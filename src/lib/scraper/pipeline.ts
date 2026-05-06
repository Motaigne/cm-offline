import { createClient } from '@/lib/supabase/server';
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
  /** Reprend le snapshot 'running' existant pour ce mois/utilisateur si présent. */
  resume?: boolean;
}

export async function* runScrape(params: ScrapeParams): AsyncGenerator<ScrapeEvent> {
  const supabase = await createClient();
  const cfg: CrewBiddConfig = { cookie: params.cookie, sn: params.sn, userId: params.userId };

  // Verify is_scraper
  const { data: profile } = await supabase
    .from('user_profile')
    .select('is_scraper')
    .eq('user_id', params.supabaseUserId)
    .single();

  if (!profile?.is_scraper) {
    yield { type: 'error', message: 'Profil non autorisé à scraper (is_scraper = false)' };
    return;
  }

  let snapshotId: string;
  const skipActivitySet = new Set<string>();

  if (params.resume) {
    // Reprise : on cherche le dernier snapshot 'running' du mois pour ce user
    const { data: existing } = await supabase
      .from('scrape_snapshot')
      .select('id')
      .eq('target_month', `${params.month}-01`)
      .eq('scraped_by', params.supabaseUserId)
      .eq('status', 'running')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!existing) {
      yield { type: 'error', message: 'Aucun téléchargement en cours à reprendre' };
      return;
    }
    snapshotId = existing.id;

    // Lit les activity_id déjà traités via pairing_instance ↔ pairing_signature
    const { data: doneSigs } = await supabase
      .from('pairing_signature')
      .select('id')
      .eq('snapshot_id', snapshotId);
    const sigIds = (doneSigs ?? []).map(r => r.id);
    if (sigIds.length > 0) {
      const { data: doneInstances } = await supabase
        .from('pairing_instance')
        .select('activity_id')
        .in('signature_id', sigIds);
      for (const r of doneInstances ?? []) skipActivitySet.add(String(r.activity_id));
    }
  } else {
    // Création d'un nouveau snapshot
    const { data: snap, error: snapErr } = await supabase
      .from('scrape_snapshot')
      .insert({
        target_month: `${params.month}-01`,
        status: 'running',
        scraped_by: params.supabaseUserId,
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (snapErr || !snap) {
      yield { type: 'error', message: `Snapshot: ${snapErr?.message ?? 'erreur inconnue'}` };
      return;
    }
    snapshotId = snap.id;
  }

  try {
    // Request 1: fetch all pairings
    yield { type: 'progress', current: 0, total: 0, rotation: 'Extraction de tous les vols…' };
    const rawPairings = await fetchAllPairings(params.month, cfg);

    // Filtre point C : on ne garde que les rotations qui décollent en M
    // (sécurité côté client si l'API renvoie des rotations hors fenêtre).
    const [paramY, paramM] = params.month.split('-').map(Number);
    const allPairings = rawPairings.filter(p => {
      const d = new Date(p.beginBlockDate);
      return d.getUTCFullYear() === paramY && d.getUTCMonth() + 1 === paramM;
    });

    // Group by activityNumber
    const sigMap = new Map<string, PairingSummary[]>();
    for (const p of allPairings) {
      const key = p.activityNumber;
      if (!sigMap.has(key)) sigMap.set(key, []);
      sigMap.get(key)!.push(p);
    }

    const uniqueKeys = Array.from(sigMap.keys());
    const remainingKeys = uniqueKeys.filter(k => {
      const instances = sigMap.get(k)!;
      // On considère un activityNumber comme déjà traité si au moins une de ses instances l'est
      return !instances.some(i => skipActivitySet.has(String(i.actId)));
    });

    yield {
      type: 'start',
      total_instances: allPairings.length,
      unique_sigs: uniqueKeys.length,
    };

    let totalInstances = 0;
    let processedSigs  = uniqueKeys.length - remainingKeys.length;

    // Request 2: one detail fetch per unique activityNumber
    for (const activityNumber of remainingKeys) {
      const instances   = sigMap.get(activityNumber)!;
      const repr        = instances[0];
      const rotCode     = buildRotationCode(repr);

      yield {
        type: 'progress',
        current: ++processedSigs,
        total: uniqueKeys.length,
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
      const pv0         = detail?.pairingValue?.[0];
      const restBeforeH = pv0?.restBeforeHaulDuration ?? null;
      const restAfterH  = pv0?.restPostHaulDuration   ?? null;

      const firstDuty = detail?.flightDuty?.[0];
      const lastDuty  = detail?.flightDuty?.[detail.flightDuty.length - 1];
      const heureDebut = firstDuty ? msToTimeStr(firstDuty.schBeginDate) : msToTimeStr(repr.beginDutyDate);
      const heureFin   = lastDuty  ? msToTimeStr(lastDuty.schEndDate)   : msToTimeStr(repr.endDutyDate);

      const { data: sig, error: sigErr } = await supabase
        .from('pairing_signature')
        .insert({
          snapshot_id:        snapshotId,
          rotation_code:      rotCode,
          nb_on_days:         repr.pairingDetail.nbOnDays,
          aircraft_code:      repr.aircraftSubtypeCode,
          zone,
          hc,
          hcr_crew:           hcrCrew,
          hdv,
          a81,
          heure_debut:        heureDebut,
          heure_fin:          heureFin,
          temps_sej:          tempsSej,
          prime,
          legs_number:        repr.legsNumber,
          dead_head:          repr.deadHead === 1,
          first_flight_number: repr.firstFlightNumber,
          first_layover:      repr.firstLayover,
          layovers:           repr.layovers ? repr.layovers.split('-').filter(Boolean).length : 0,
          stopovers:          repr.stopovers,
          station_code:       repr.stationCode,
          tdv_total:          repr.pairingDetail.workedFlightTime,
          rest_before_h:      restBeforeH,
          rest_after_h:       restAfterH,
          tsv_nuit:           tsvNuit,
          raw_detail:         detail as any ?? null,
        })
        .select('id')
        .single();

      if (sigErr || !sig) continue;

      // Insert all instances for this signature
      const rows = instances.map(inst => ({
        signature_id: sig.id,
        activity_id:  String(inst.actId),
        depart_date:  msToDateStr(inst.beginBlockDate),
        depart_at:    new Date(inst.beginBlockDate).toISOString(),
        arrivee_at:   new Date(inst.endBlockDate).toISOString(),
      }));

      await supabase.from('pairing_instance').insert(rows);
      totalInstances += rows.length;

      // Respectful delay: 0.8–1.8s between detail requests
      await sleep(800 + Math.random() * 1000);
    }

    // Recompte total réel (couvre le cas reprise : on additionne sessions)
    const { count: trueInstanceCount } = await supabase
      .from('pairing_instance')
      .select('id', { count: 'exact', head: true })
      .in('signature_id',
        ((await supabase.from('pairing_signature').select('id').eq('snapshot_id', snapshotId)).data ?? [])
          .map(r => r.id),
      );
    const finalInstances = trueInstanceCount ?? totalInstances;

    await supabase
      .from('scrape_snapshot')
      .update({
        status:           'success',
        finished_at:      new Date().toISOString(),
        flights_found:    finalInstances,
        unique_signatures: uniqueKeys.length,
      })
      .eq('id', snapshotId);

    yield { type: 'done', snapshot_id: snapshotId, signatures: uniqueKeys.length, instances: finalInstances };

  } catch (err) {
    await supabase
      .from('scrape_snapshot')
      .update({ status: 'error', error_message: String(err), finished_at: new Date().toISOString() })
      .eq('id', snapshotId);
    yield { type: 'error', message: String(err) };
  }
}
