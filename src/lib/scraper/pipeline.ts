import { createClient } from '@/lib/supabase/server';
import { fetchAllPaginated } from '@/lib/supabase/paginate';
import { fetchAllPairings, fetchPairingDetail, type CrewBiddConfig } from './crewbidd';
import { getZone } from './zone-lookup';
import { computeTsvNuit } from './tsv-nuit';
import type { PairingSummary, PairingDetail, ScrapeEvent } from './types';

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

function buildRotationCode(s: PairingSummary): string {
  const dest = s.layovers.replace(/-/g, ' ');
  return `${s.pairingDetail.nbOnDays}ON ${dest}`;
}

function computeTempsSej(detail: PairingDetail): number {
  const duties = detail.flightDuty;
  if (!duties || duties.length < 2) return 0;
  return (duties[duties.length - 1].schBeginDate - duties[0].schEndDate) / 3600000;
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

/**
 * Charge l'état du snapshot pour calculer la diff :
 *  - existingNumbers : activity_number déjà en DB (filtre principal)
 *  - legacySigByActId : signature_id indexé par activity_id pour les
 *    lignes héritées dont activity_number est NULL. Le pipeline répare
 *    ces lignes au passage.
 */
async function loadSnapshotDiffState(supabase: SupabaseClient, snapshotId: string) {
  const existingNumbers = new Set<string>();
  const legacySigByActId = new Map<string, string>();

  const sigs = await fetchAllPaginated<{ id: string; activity_number: string | null }>((from, to) =>
    supabase
      .from('pairing_signature')
      .select('id, activity_number')
      .eq('snapshot_id', snapshotId)
      .range(from, to),
  );

  const legacySigIds: string[] = [];
  for (const s of sigs) {
    if (s.activity_number) existingNumbers.add(s.activity_number);
    else legacySigIds.push(s.id);
  }

  if (legacySigIds.length > 0) {
    const insts = await fetchAllPaginated<{ signature_id: string; activity_id: string }>((from, to) =>
      supabase
        .from('pairing_instance')
        .select('signature_id, activity_id')
        .in('signature_id', legacySigIds)
        .range(from, to),
    );
    for (const r of insts) {
      legacySigByActId.set(String(r.activity_id), r.signature_id);
    }
  }

  return { existingNumbers, legacySigByActId };
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

    const sigMap = new Map<string, PairingSummary[]>();
    for (const p of allPairings) {
      const key = p.activityNumber;
      if (!sigMap.has(key)) sigMap.set(key, []);
      sigMap.get(key)!.push(p);
    }
    const allKeys = Array.from(sigMap.keys());

    // Phase 2 — diff avec ce qui est déjà en DB
    const { existingNumbers, legacySigByActId } = await loadSnapshotDiffState(supabase, snapshotId);

    const missingKeys: string[] = [];
    for (const k of allKeys) {
      if (existingNumbers.has(k)) continue;

      // Fallback héritage : un actId connu pointe sur une signature legacy.
      const insts = sigMap.get(k)!;
      let legacySigId: string | null = null;
      for (const i of insts) {
        const sigId = legacySigByActId.get(String(i.actId));
        if (sigId) { legacySigId = sigId; break; }
      }
      if (legacySigId) {
        await supabase
          .from('pairing_signature')
          .update({ activity_number: k })
          .eq('id', legacySigId);
        existingNumbers.add(k);
        continue;
      }

      missingKeys.push(k);
    }

    // Cap maxRotations (cf. ScrapeParams) — coupe la liste des manquants en
    // tête. Les rotations exclues seront récupérées au prochain run.
    const cappedMissing = (params.maxRotations != null && params.maxRotations > 0)
      ? missingKeys.slice(0, params.maxRotations)
      : missingKeys;

    yield {
      type: 'start',
      total_instances: allPairings.length,
      unique_sigs:     allKeys.length,
    };

    // Phase 3 — fetch detail uniquement pour les manquantes (cappées)
    let processedSigs = 0;

    for (const activityNumber of cappedMissing) {
      const instances = sigMap.get(activityNumber)!;
      const repr      = instances[0];
      const rotCode   = buildRotationCode(repr);

      yield {
        type: 'progress',
        current: ++processedSigs,
        total:   cappedMissing.length,
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
      const restBeforeH = repr.pairingDetail.restBeforeHaulDuration ?? null;
      const restAfterH  = repr.pairingDetail.restPostHaulDuration   ?? null;

      const firstDuty  = detail?.flightDuty?.[0];
      const lastDuty   = detail?.flightDuty?.[detail.flightDuty.length - 1];
      const heureDebut = firstDuty ? msToTimeStr(firstDuty.schBeginDate) : msToTimeStr(repr.beginDutyDate);
      const heureFin   = lastDuty  ? msToTimeStr(lastDuty.schEndDate)   : msToTimeStr(repr.endDutyDate);

      const { data: sig, error: sigErr } = await supabase
        .from('pairing_signature')
        .insert({
          snapshot_id:         snapshotId,
          activity_number:     activityNumber,
          rotation_code:       rotCode,
          nb_on_days:          repr.pairingDetail.nbOnDays,
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
          raw_detail:          detail as any ?? null,
        })
        .select('id')
        .single();

      if (sigErr || !sig) continue;

      const rows = instances.map(inst => ({
        signature_id: sig.id,
        activity_id:  String(inst.actId),
        depart_date:  msToDateStr(inst.beginBlockDate),
        depart_at:    new Date(inst.beginBlockDate).toISOString(),
        arrivee_at:   new Date(inst.endBlockDate).toISOString(),
      }));

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
