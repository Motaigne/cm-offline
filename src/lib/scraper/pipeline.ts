import { createClient } from '@/lib/supabase/server';
import { fetchAllPaginated } from '@/lib/supabase/paginate';
import { fetchAllPairings, fetchPairingDetail, type CrewBiddConfig } from './crewbidd';
import { getZone } from './zone-lookup';
import { computeTsvNuit } from './tsv-nuit';
import type { PairingSummary, PairingDetail, ScrapeEvent } from './types';
import type { Json } from '@/types/supabase';

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

function msToDateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function msToTimeStr(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}:00`;
}

/**
 * nb_on_days = nombre de jours calendaires couverts par la rotation, du
 * premier block-off au dernier block-on (UTC). Plus fiable que
 * pairingDetail.nbOnDays renvoyé par CrewBidd, qui peut être incohérent entre
 * instances d'une même rotation (probablement un cache stale côté AF).
 */
function computeNbOnDays(beginBlockDateMs: number, endBlockDateMs: number): number {
  if (!beginBlockDateMs || !endBlockDateMs || endBlockDateMs < beginBlockDateMs) return 0;
  const begin = new Date(beginBlockDateMs);
  const end   = new Date(endBlockDateMs);
  const beginDay = Date.UTC(begin.getUTCFullYear(), begin.getUTCMonth(), begin.getUTCDate());
  const endDay   = Date.UTC(end.getUTCFullYear(),   end.getUTCMonth(),   end.getUTCDate());
  return Math.round((endDay - beginDay) / 86_400_000) + 1;
}

function buildRotationCode(s: PairingSummary, nbOnDays: number): string {
  const dest = s.layovers.replace(/-/g, ' ');
  return `${nbOnDays}ON ${dest}`;
}

function computeTempsSej(detail: PairingDetail): number {
  const duties = detail.flightDuty;
  if (!duties || duties.length < 2) return 0;
  return (duties[duties.length - 1].schBeginDate - duties[0].schEndDate) / 3600000;
}

const FIVE_MIN_MS = 5  * 60 * 1000;
const TEN_MIN_MS  = 10 * 60 * 1000;

/**
 * Pré-calcule les 4 champs A81 depuis raw_detail. Stockés sur pairing_signature
 * pour permettre le compute offline (page A81) sans recharger raw_detail.
 */
function computeA81Meta(detail: PairingDetail | null, firstLayoverFallback: string | null) {
  if (!detail?.flightDuty || detail.flightDuty.length < 2) {
    return { debut_sejour_at: null, fin_sejour_at: null, escale_debut: null, escale_fin: null };
  }
  const firstDuty = detail.flightDuty[0];
  const lastDuty  = detail.flightDuty[detail.flightDuty.length - 1];
  const debutSejourMs = firstDuty.schEndDate - FIVE_MIN_MS;
  const finSejourMs   = lastDuty.schBeginDate + TEN_MIN_MS;
  const firstDutyLegs = firstDuty.dutyLegAssociation?.flatMap(d => d.legs) ?? [];
  const lastDutyLegs  = lastDuty.dutyLegAssociation?.flatMap(d => d.legs) ?? [];
  const escaleDebut = firstDutyLegs[firstDutyLegs.length - 1]?.arrivalStationCode ?? firstLayoverFallback ?? null;
  const escaleFin   = lastDutyLegs[0]?.departureStationCode ?? firstLayoverFallback ?? null;
  return {
    debut_sejour_at: new Date(debutSejourMs).toISOString(),
    fin_sejour_at:   new Date(finSejourMs).toISOString(),
    escale_debut:    escaleDebut,
    escale_fin:      escaleFin,
  };
}

function computePrime(detail: PairingDetail): number {
  let prime = 0;
  for (const fd of detail.flightDuty) {
    const legs = fd.dutyLegAssociation.flatMap(d => d.legs);
    if (legs.length >= 2) {
      const hasExcluded = legs.some(l => l.arrivalStationCode === 'TLV' || l.arrivalStationCode === 'BEY');
      if (!hasExcluded) prime++;
    }
  }
  return prime;
}


export interface ScrapeParams {
  month: string;
  cookie: string;
  sn: string;
  userId: string;
  supabaseUserId: string;
  /** Surcharge la fenêtre de search CrewBidd (YYYY-MM-DD) — utile pour backfill ciblé. */
  windowFrom?: string;
  windowTo?:   string;
  /** Limite le nombre de rotations à fetcher dans ce run. Plafonné côté API à
   *  50 pour les non-admin. undefined = tout télécharger. */
  maxRotations?: number;
}

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Get-or-create LE snapshot du mois (option A : un snapshot par mois,
 * accumulatif). S'il en existe plusieurs (legacy), prend le plus récent et
 * le réutilise.
 */
async function getOrCreateMonthSnapshot(
  supabase: SupabaseClient,
  month: string,
  supabaseUserId: string,
): Promise<{ id: string } | null> {
  const monthDate = `${month}-01`;
  const { data: existing } = await supabase
    .from('scrape_snapshot')
    .select('id, status')
    .eq('target_month', monthDate)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    if (existing.status !== 'running') {
      await supabase
        .from('scrape_snapshot')
        .update({ status: 'running', error_message: null })
        .eq('id', existing.id);
    }
    return { id: existing.id };
  }

  const { data: snap } = await supabase
    .from('scrape_snapshot')
    .insert({
      target_month: monthDate,
      status:       'running',
      scraped_by:   supabaseUserId,
      started_at:   new Date().toISOString(),
    })
    .select('id')
    .single();

  return snap ?? null;
}

/** Clé d'index (sig + dedup) : `${activity_number}|${nb_on_days}`. */
function sigKey(activityNumber: string, nbOnDays: number): string {
  return `${activityNumber}|${nbOnDays}`;
}

/**
 * Charge l'état du snapshot pour calculer la diff (niveau signature ET niveau
 * instance, pour détecter les sigs déjà en DB qui ont des dates manquantes) :
 *  - existingKeys : clés `${activity_number}|${nb_on_days}` déjà en DB.
 *  - sigIdByKey  : signature_id (DB) indexé par cette même clé.
 *  - existingActIdsBySig : pour chaque signature_id en DB, l'ensemble des
 *    activity_id déjà persistés en pairing_instance.
 *  - legacySigByActId : signature_id indexé par activity_id pour les lignes
 *    héritées dont activity_number est NULL. Le pipeline répare ces lignes
 *    au passage.
 */
async function loadSnapshotDiffState(supabase: SupabaseClient, snapshotId: string) {
  const existingKeys          = new Set<string>();
  const sigIdByKey            = new Map<string, string>();
  const existingActIdsBySig   = new Map<string, Set<string>>();
  const legacySigByActId      = new Map<string, string>();

  const sigs = await fetchAllPaginated<{ id: string; activity_number: string | null; nb_on_days: number | null }>((from, to) =>
    supabase
      .from('pairing_signature')
      .select('id, activity_number, nb_on_days')
      .eq('snapshot_id', snapshotId)
      .range(from, to),
  );

  const legacySigIds: string[] = [];
  const allSigIds:    string[] = [];
  for (const s of sigs) {
    allSigIds.push(s.id);
    if (s.activity_number && s.nb_on_days != null) {
      const k = sigKey(s.activity_number, s.nb_on_days);
      existingKeys.add(k);
      sigIdByKey.set(k, s.id);
    } else {
      legacySigIds.push(s.id);
    }
  }

  if (allSigIds.length > 0) {
    const insts = await fetchAllPaginated<{ signature_id: string; activity_id: string }>((from, to) =>
      supabase
        .from('pairing_instance')
        .select('signature_id, activity_id')
        .in('signature_id', allSigIds)
        .range(from, to),
    );
    for (const r of insts) {
      let set = existingActIdsBySig.get(r.signature_id);
      if (!set) { set = new Set(); existingActIdsBySig.set(r.signature_id, set); }
      set.add(String(r.activity_id));
      // Index legacy par actId aussi (utilisé en fallback pour matcher
      // une signature dont activity_number serait NULL).
      if (legacySigIds.includes(r.signature_id)) {
        legacySigByActId.set(String(r.activity_id), r.signature_id);
      }
    }
  }

  return { existingKeys, sigIdByKey, existingActIdsBySig, legacySigByActId };
}

/** Construit une row pairing_instance à partir d'une PairingSummary.
 *  raw_summary : le payload brut tel que renvoyé par CrewBidd `pairingsearch`,
 *  conservé pour permettre une re-dérivation hors-ligne en cas de bug
 *  d'exploitation (cf. migration 0034). */
function buildInstanceRow(sigId: string, inst: PairingSummary) {
  const beginAct = inst.scheduledBeginActivityDate;
  const endAct   = inst.scheduledEndActivityDate;
  const restBefore = (beginAct > 0 && inst.beginBlockDate > 0)
    ? (inst.beginBlockDate - beginAct) / 3_600_000
    : (inst.pairingDetail.restBeforeHaulDuration ?? null);
  const restAfter = (endAct > 0 && inst.endBlockDate > 0)
    ? (endAct - inst.endBlockDate) / 3_600_000
    : (inst.pairingDetail.restPostHaulDuration ?? null);
  return {
    signature_id:   sigId,
    activity_id:    String(inst.actId),
    depart_date:    msToDateStr(inst.beginBlockDate),
    depart_at:      new Date(inst.beginBlockDate).toISOString(),
    arrivee_at:     new Date(inst.endBlockDate).toISOString(),
    rest_before_h:  restBefore,
    rest_after_h:   restAfter,
    scheduled_begin_activity_at: beginAct > 0 ? new Date(beginAct).toISOString() : null,
    scheduled_end_activity_at:   endAct   > 0 ? new Date(endAct).toISOString()   : null,
    raw_summary:    inst as unknown as Json,
  };
}

export async function* runScrape(params: ScrapeParams): AsyncGenerator<ScrapeEvent> {
  const supabase = await createClient();
  const cfg: CrewBiddConfig = { cookie: params.cookie, sn: params.sn, userId: params.userId };

  const { data: profile } = await supabase
    .from('user_profile')
    .select('is_admin, is_scraper')
    .eq('user_id', params.supabaseUserId)
    .single();

  if (!profile?.is_admin && !profile?.is_scraper) {
    yield { type: 'error', message: 'Profil non autorisé à scraper' };
    return;
  }

  const snap = await getOrCreateMonthSnapshot(supabase, params.month, params.supabaseUserId);
  if (!snap) {
    yield { type: 'error', message: 'Impossible de créer le snapshot du mois' };
    return;
  }
  const snapshotId = snap.id;

  try {
    // Phase 1 — pairingsearch
    yield { type: 'progress', current: 0, total: 0, rotation: 'Extraction de tous les vols…' };
    const rawPairings = await fetchAllPairings(params.month, cfg, {
      windowFrom: params.windowFrom,
      windowTo:   params.windowTo,
    });

    // Filtre point C : ne garder que les rotations qui décollent en M.
    const [paramY, paramM] = params.month.split('-').map(Number);
    const allPairings = rawPairings.filter(p => {
      const d = new Date(p.beginBlockDate);
      return d.getUTCFullYear() === paramY && d.getUTCMonth() + 1 === paramM;
    });

    // sigMap keyée par `(activity_number, nb_on_days)` — sépare les rotations
    // de durées différentes qui partagent un activity_number CrewBidd (cas JFK).
    // Chaque clé devient une signature DB distincte, ce qui maintient
    // l'invariant : tous les instances d'une sig ont la même durée.
    const sigMap = new Map<string, PairingSummary[]>();
    for (const p of allPairings) {
      const dur = computeNbOnDays(p.beginBlockDate, p.endBlockDate);
      if (dur <= 0) continue; // ignore les dates malformées
      const key = sigKey(p.activityNumber, dur);
      if (!sigMap.has(key)) sigMap.set(key, []);
      sigMap.get(key)!.push(p);
    }
    const allKeys = Array.from(sigMap.keys());

    // Phase 2 — diff à 2 niveaux (signature ET instance)
    const { existingKeys, sigIdByKey, existingActIdsBySig, legacySigByActId } =
      await loadSnapshotDiffState(supabase, snapshotId);
    void existingKeys; // conservé pour debug futur, non utilisé directement

    // partialSigs : sig déjà en DB MAIS avec des dates manquantes → on insère
    //   uniquement les pairing_instance manquants (pas de detail fetch).
    // missingKeys : sig pas en DB du tout → detail fetch + insert sig + instances.
    const partialSigs: Array<{ activityNumber: string; nbOnDays: number; sigDbId: string; missingInsts: PairingSummary[] }> = [];
    const missingKeys: string[] = [];

    for (const k of allKeys) {
      const fetchedInsts = sigMap.get(k)!;
      const [actNum, durStr] = k.split('|');
      const nbOnDays = Number(durStr);

      // Résolution sigDbId : 1) match direct par (activity_number, nb_on_days),
      // 2) fallback héritage par activity_id (activity_number NULL en DB) → on
      //    répare la ligne au passage. Le fallback ne s'applique qu'une fois
      //    par sig legacy (la 1ère clé qui la touche), les autres durées tomberont
      //    dans missingKeys → nouvelles insertions.
      let sigDbId = sigIdByKey.get(k);
      if (!sigDbId) {
        for (const i of fetchedInsts) {
          const legacy = legacySigByActId.get(String(i.actId));
          if (legacy) {
            await supabase.from('pairing_signature')
              .update({ activity_number: actNum, nb_on_days: nbOnDays })
              .eq('id', legacy);
            sigDbId = legacy;
            sigIdByKey.set(k, legacy);
            // Ne pas réutiliser ce legacy sigId pour les autres clés
            // (autres durées du même activity_number).
            legacySigByActId.delete(String(i.actId));
            break;
          }
        }
      }

      if (sigDbId) {
        // Sig en DB → diff au niveau instance.
        const existingActIds = existingActIdsBySig.get(sigDbId) ?? new Set<string>();
        const missingInsts   = fetchedInsts.filter(i => !existingActIds.has(String(i.actId)));
        if (missingInsts.length > 0) {
          partialSigs.push({ activityNumber: actNum, nbOnDays, sigDbId, missingInsts });
        }
      } else {
        missingKeys.push(k);
      }
    }

    // Cap maxRotations : ne s'applique qu'aux full-fetches (lent). Les partial
    // (sans detail fetch) sont toujours traitées d'un coup — c'est rapide.
    const cappedMissing = (params.maxRotations != null && params.maxRotations > 0)
      ? missingKeys.slice(0, params.maxRotations)
      : missingKeys;

    const totalToProcess = partialSigs.length + cappedMissing.length;

    yield {
      type: 'start',
      total_instances: allPairings.length,
      unique_sigs:     allKeys.length,
    };

    let processedSigs = 0;

    // Phase 3a — partial sigs (rapide, juste insert d'instances).
    // nb_on_days est déjà fixé par la clé sigMap (toutes les instances
    // partagent la même durée). On réécrit rotation_code pour rattraper
    // d'éventuelles valeurs historiques incohérentes.
    for (const { sigDbId, missingInsts, nbOnDays, activityNumber } of partialSigs) {
      const repr     = missingInsts[0];
      const rotCode  = buildRotationCode(repr, nbOnDays);
      yield {
        type: 'progress',
        current:  ++processedSigs,
        total:    totalToProcess,
        rotation: `${rotCode} (+${missingInsts.length} date${missingInsts.length > 1 ? 's' : ''})`,
      };
      const rows = missingInsts.map(inst => buildInstanceRow(sigDbId, inst));
      await supabase.from('pairing_instance').insert(rows);
      await supabase.from('pairing_signature')
        .update({ nb_on_days: nbOnDays, rotation_code: rotCode })
        .eq('id', sigDbId);
      // Pas de sleep : pas d'appel CrewBidd côté detail, juste 2 calls DB.
      void activityNumber;
    }

    // Phase 3b — full fetch pour les sigs vraiment manquantes
    for (const k of cappedMissing) {
      const instances = sigMap.get(k)!;
      const repr      = instances[0];
      const [activityNumber, durStr] = k.split('|');
      const nbOnDays  = Number(durStr);
      const rotCode   = buildRotationCode(repr, nbOnDays);

      yield {
        type: 'progress',
        current: ++processedSigs,
        total:   totalToProcess,
        rotation: rotCode,
      };

      const detail = await fetchPairingDetail(repr.actId, cfg);

      const hc          = repr.pairingDetail.creditedHour;
      const hcrCrew     = repr.pairingDetail.paidCreditedTime;
      const hdv         = repr.pairingDetail.flightTime;
      const a81         = hcrCrew > hc;
      const zone        = getZone(repr.layovers);
      const tempsSej    = detail ? computeTempsSej(detail) : 0;
      const prime       = detail ? computePrime(detail) : 0;
      const tsvNuit     = detail ? computeTsvNuit(detail) : 0;
      // RPC (rest_after) calculé depuis les timestamps — source de vérité.
      // Les champs `restPostHaulDuration` des endpoints SEARCH et DETAIL sont
      // incohérents entre eux selon les rotations.
      // rest_before / rest_after : calculés depuis timestamps (briefing → block,
      // block-off → fin activity). L'API restBefore/PostHaulDuration sert de
      // fallback uniquement si les timestamps sont absents.
      const restBeforeH = (repr.beginBlockDate > 0 && repr.scheduledBeginActivityDate > 0)
        ? (repr.beginBlockDate - repr.scheduledBeginActivityDate) / 3_600_000
        : (repr.pairingDetail.restBeforeHaulDuration ?? null);
      const restAfterH  = (repr.scheduledEndActivityDate > 0 && repr.endBlockDate > 0)
        ? (repr.scheduledEndActivityDate - repr.endBlockDate) / 3_600_000
        : (repr.pairingDetail.restPostHaulDuration ?? null);

      const firstDuty  = detail?.flightDuty?.[0];
      const lastDuty   = detail?.flightDuty?.[detail.flightDuty.length - 1];
      const heureDebut = firstDuty ? msToTimeStr(firstDuty.schBeginDate) : msToTimeStr(repr.beginDutyDate);
      const heureFin   = lastDuty  ? msToTimeStr(lastDuty.schEndDate)   : msToTimeStr(repr.endDutyDate);
      const a81Meta    = computeA81Meta(detail, repr.firstLayover ?? null);

      const { data: sig, error: sigErr } = await supabase
        .from('pairing_signature')
        .insert({
          snapshot_id:         snapshotId,
          activity_number:     activityNumber,
          rotation_code:       rotCode,
          nb_on_days:          nbOnDays,
          aircraft_code:       repr.aircraftSubtypeCode,
          zone,
          hc,
          hcr_crew:            hcrCrew,
          hdv,
          a81,
          heure_debut:         heureDebut,
          heure_fin:           heureFin,
          temps_sej:           tempsSej,
          prime,
          legs_number:         repr.legsNumber,
          dead_head:           repr.deadHead === 1,
          first_flight_number: repr.firstFlightNumber,
          first_layover:       repr.firstLayover,
          layovers:            repr.layovers ? repr.layovers.split('-').filter(Boolean).length : 0,
          stopovers:           repr.stopovers,
          station_code:        repr.stationCode,
          tdv_total:           repr.pairingDetail.workedFlightTime,
          rest_before_h:       restBeforeH,
          rest_after_h:        restAfterH,
          tsv_nuit:            tsvNuit,
          raw_detail:          (detail as unknown as Json) ?? null,
          debut_sejour_at:     a81Meta.debut_sejour_at,
          fin_sejour_at:       a81Meta.fin_sejour_at,
          escale_debut:        a81Meta.escale_debut,
          escale_fin:          a81Meta.escale_fin,
        })
        .select('id')
        .single();

      if (sigErr || !sig) continue;

      const rows = instances.map(inst => buildInstanceRow(sig.id, inst));
      await supabase.from('pairing_instance').insert(rows);

      // Délai respectueux entre détails (0.8–1.8 s).
      await sleep(800 + Math.random() * 1000);
    }

    // Recompute totals (sur tout le snapshot, pas seulement cette session).
    const allSigsForSnap = await fetchAllPaginated<{ id: string }>((from, to) =>
      supabase.from('pairing_signature').select('id').eq('snapshot_id', snapshotId).range(from, to),
    );
    const allSigIds = allSigsForSnap.map(r => r.id);
    const { count: trueInstanceCount } = await supabase
      .from('pairing_instance')
      .select('id', { count: 'exact', head: true })
      .in('signature_id', allSigIds);
    const finalInstances = trueInstanceCount ?? 0;
    const finalSigs      = allSigIds.length;

    await supabase
      .from('scrape_snapshot')
      .update({
        status:            'success',
        finished_at:       new Date().toISOString(),
        flights_found:     finalInstances,
        unique_signatures: finalSigs,
      })
      .eq('id', snapshotId);

    yield { type: 'done', snapshot_id: snapshotId, signatures: finalSigs, instances: finalInstances };

  } catch (err) {
    await supabase
      .from('scrape_snapshot')
      .update({ status: 'error', error_message: String(err), finished_at: new Date().toISOString() })
      .eq('id', snapshotId);
    yield { type: 'error', message: String(err) };
  }
}
