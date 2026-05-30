/**
 * POST /api/admin/import-csv-month
 * body: { month: 'YYYY-MM', csvText: string, extractCsvText?: string }
 *
 * Importe les rotations d'un mois depuis :
 *   - csvText         : 8_cleanEp4_MMYYYY.csv (rotations UNIQUES dédupliquées par
 *                       le pipeline Python). Source des pairing_signature
 *                       (incl. raw_detail synthétique, zone, temps_sej, prime…).
 *   - extractCsvText  : 1_extract_MMYYYY.csv (toutes les rotations datées, avant
 *                       dédup). Source des pairing_instance (1 ligne = 1 actID).
 *
 * Si `extractCsvText` est absent : on n'insère qu'une instance par sig
 * (= la date d'exemple du cleanEp4) — mode dégradé qui couvre catalogue/A81
 * mais pas la pose calendrier sur tous les jours.
 *
 * Liaison actID → sig : clé composite
 *   (stopovers, nbOnDays, hc, hcrCrew, hdv, aircraftCode, firstFlightNumber)
 * + tie-break par date la plus proche (sépare les rotations type "8ON 25LAX"
 * vs "8ON 26LAX" qui ont la même clé mais des HC différentes selon le mois).
 *
 * Idempotent : skip les sigs déjà en DB (par activity_number) et les instances
 * déjà en DB (par (signature_id, activity_id) — contrainte UNIQUE).
 *
 * Admin only.
 */
import { createClient } from '@/lib/supabase/server';
import { fetchAllPaginated } from '@/lib/supabase/paginate';
import { parseRotationsCsv, type ParsedRotation } from '@/lib/csv-import/parse';
import { parseExtractCsv, type ExtractRow } from '@/lib/csv-import/parse-extract';
import { rotationToRows } from '@/lib/csv-import/transform';

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

async function getOrCreateMonthSnapshot(
  supabase: SupabaseClient,
  month: string,
  userId: string,
): Promise<{ id: string } | null> {
  const monthDate = `${month}-01`;
  const { data: existing } = await supabase
    .from('scrape_snapshot')
    .select('id')
    .eq('target_month', monthDate)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) return { id: existing.id };

  const { data: snap, error } = await supabase
    .from('scrape_snapshot')
    .insert({
      target_month: monthDate,
      status:       'running',
      scraped_by:   userId,
      started_at:   new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error || !snap) return null;
  return snap;
}

/** Clé de match sig ⇄ extract : champs présents (et identiques) des 2 côtés. */
function matchKey(args: {
  stopovers: string; nbOnDays: number;
  hc: number; hcrCrew: number; hdv: number;
  aircraftCode: string; firstFlightNumber: string;
}): string {
  return [
    args.stopovers,
    args.nbOnDays,
    args.hc.toFixed(2),
    args.hcrCrew.toFixed(2),
    args.hdv.toFixed(2),
    args.aircraftCode,
    args.firstFlightNumber,
  ].join('|');
}

function keyFromRotation(rot: ParsedRotation): string {
  return matchKey({
    stopovers:         rot.rot.replace(/\s+/g, '-'),
    nbOnDays:          rot.on,
    hc:                rot.hc,
    hcrCrew:           rot.hc,           // CSV cleanEp4 ne distingue pas — utilisé comme proxy
    hdv:               rot.hdv,
    aircraftCode:      rot.avion,
    firstFlightNumber: rot.legs[0]?.flightNumber ?? '',
  });
}

function keyFromExtract(ex: ExtractRow): string {
  return matchKey({
    stopovers:         ex.stopovers,
    nbOnDays:          ex.nbOnDays,
    hc:                ex.hc,
    hcrCrew:           ex.hc,            // on n'utilise pas hcrCrew côté sig (proxy → cohérence ici aussi)
    hdv:               ex.hdv,
    aircraftCode:      ex.aircraftCode,
    firstFlightNumber: ex.firstFlightNumber,
  });
}

function msToDateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const { data: profile } = await supabase
    .from('user_profile')
    .select('is_admin')
    .eq('user_id', user.id)
    .single();
  if (!profile?.is_admin) return new Response('Forbidden', { status: 403 });

  const body = await req.json().catch(() => null);
  const month = body?.month as string | undefined;
  const csvText = body?.csvText as string | undefined;
  const extractCsvText = body?.extractCsvText as string | undefined;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return new Response('month requis au format YYYY-MM', { status: 400 });
  }
  if (!csvText) return new Response('csvText (cleanEp4) requis', { status: 400 });

  let rotations: ParsedRotation[];
  try {
    rotations = parseRotationsCsv(csvText);
  } catch (e) {
    return new Response(`CSV cleanEp4 invalide : ${String(e)}`, { status: 400 });
  }

  let extractRows: ExtractRow[] = [];
  if (extractCsvText) {
    try {
      extractRows = parseExtractCsv(extractCsvText);
    } catch (e) {
      return new Response(`CSV extract invalide : ${String(e)}`, { status: 400 });
    }
  }

  // Filtre point C : ne garde que les rotations qui décollent dans le mois cible.
  const [paramY, paramM] = month.split('-').map(Number);
  const inMonth = (ms: number) => {
    const d = new Date(ms);
    return d.getUTCFullYear() === paramY && d.getUTCMonth() + 1 === paramM;
  };
  const filteredRotations = rotations.filter(r => {
    const [y, m] = r.debutVol.split('-').map(Number);
    return y === paramY && m === paramM;
  });
  const filteredExtract = extractRows.filter(e => inMonth(e.firstBlockOffMs));

  const snap = await getOrCreateMonthSnapshot(supabase, month, user.id);
  if (!snap) return new Response('Impossible de créer le snapshot', { status: 500 });

  // Diff sigs par activity_number (= ID Ligne du cleanEp4)
  const existingSigs = await fetchAllPaginated<{ id: string; activity_number: string | null }>((from, to) =>
    supabase.from('pairing_signature')
      .select('id, activity_number')
      .eq('snapshot_id', snap.id)
      .range(from, to),
  );
  const sigDbIdByActNum = new Map<string, string>();
  for (const s of existingSigs) {
    if (s.activity_number) sigDbIdByActNum.set(s.activity_number, s.id);
  }

  let sigsInserted = 0;
  let sigsSkipped  = 0;
  let sigsErrors   = 0;
  const errorSamples: string[] = [];

  // Phase 1 : insert sigs depuis cleanEp4 (skip si déjà en DB).
  // On garde aussi en mémoire le mapping rotation → sig_db_id pour la phase 2.
  type SigBucket = {
    rot: ParsedRotation;
    sigDbId: string;
    /** Date de DebutVol en YYYY-MM-DD, utilisée pour le tie-break. */
    repDate: string;
  };
  const sigsByKey = new Map<string, SigBucket[]>();

  for (const rot of filteredRotations) {
    let sigDbId = sigDbIdByActNum.get(rot.idLigne);
    if (!sigDbId) {
      const rows = rotationToRows(rot);
      if (!rows) { sigsErrors++; continue; }
      const { sig } = rows;
      const { data: sigRow, error: sigErr } = await supabase
        .from('pairing_signature')
        .insert({
          snapshot_id:         snap.id,
          activity_number:     sig.activity_number,
          rotation_code:       sig.rotation_code,
          nb_on_days:          sig.nb_on_days,
          aircraft_code:       sig.aircraft_code,
          zone:                sig.zone,
          hc:                  sig.hc,
          hcr_crew:            sig.hcr_crew,
          hdv:                 sig.hdv,
          a81:                 sig.a81,
          heure_debut:         sig.heure_debut,
          heure_fin:           sig.heure_fin,
          temps_sej:           sig.temps_sej,
          legs_number:         sig.legs_number,
          prime:               sig.prime,
          rest_before_h:       sig.rest_before_h,
          rest_after_h:        sig.rest_after_h,
          tsv_nuit:            sig.tsv_nuit,
          dead_head:           sig.dead_head,
          first_flight_number: sig.first_flight_number,
          first_layover:       sig.first_layover,
          layovers:            sig.layovers,
          stopovers:           sig.stopovers,
          station_code:        sig.station_code,
          tdv_total:           sig.tdv_total,
          raw_detail:          sig.raw_detail as unknown as never,
          debut_sejour_at:     sig.debut_sejour_at,
          fin_sejour_at:       sig.fin_sejour_at,
          escale_debut:        sig.escale_debut,
          escale_fin:          sig.escale_fin,
        })
        .select('id')
        .single();
      if (sigErr || !sigRow) {
        sigsErrors++;
        if (errorSamples.length < 5) errorSamples.push(`${rot.code}: ${sigErr?.message ?? 'no row'}`);
        continue;
      }
      sigDbId = sigRow.id;
      sigDbIdByActNum.set(rot.idLigne, sigDbId);
      sigsInserted++;
    } else {
      sigsSkipped++;
    }
    const key = keyFromRotation(rot);
    const bucket: SigBucket = { rot, sigDbId, repDate: rot.debutVol };
    if (!sigsByKey.has(key)) sigsByKey.set(key, []);
    sigsByKey.get(key)!.push(bucket);
  }

  // Phase 2 : insert instances.
  // Si on a l'extract : pour chaque actID, find sig par clé + tie-break date.
  // Sinon : 1 instance par sig (= la date du cleanEp4) — déjà couvert par la
  // route précédente.
  let instInserted = 0;
  let instSkipped  = 0;
  let instUnmatched = 0;

  // Récupère les instances déjà en DB pour dédupliquer (par activity_id).
  const allSigIds = Array.from(sigDbIdByActNum.values());
  const existingInstActIds = new Set<string>();
  if (allSigIds.length > 0) {
    const insts = await fetchAllPaginated<{ activity_id: string }>((from, to) =>
      supabase.from('pairing_instance')
        .select('activity_id')
        .in('signature_id', allSigIds)
        .range(from, to),
    );
    for (const i of insts) existingInstActIds.add(String(i.activity_id));
  }

  if (filteredExtract.length > 0) {
    for (const ex of filteredExtract) {
      if (existingInstActIds.has(ex.actID)) { instSkipped++; continue; }
      const key = keyFromExtract(ex);
      const candidates = sigsByKey.get(key);
      if (!candidates || candidates.length === 0) {
        instUnmatched++;
        if (errorSamples.length < 10) errorSamples.push(`actID ${ex.actID} (${ex.stopovers}, HC=${ex.hc}) : aucun sig matché`);
        continue;
      }
      // Tie-break par date de départ la plus proche
      const exDate = msToDateStr(ex.firstBlockOffMs);
      let best = candidates[0];
      let bestDist = Math.abs(new Date(exDate).getTime() - new Date(best.repDate).getTime());
      for (let i = 1; i < candidates.length; i++) {
        const d = Math.abs(new Date(exDate).getTime() - new Date(candidates[i].repDate).getTime());
        if (d < bestDist) { best = candidates[i]; bestDist = d; }
      }
      const restBefore = ex.tsvBeginMs > 0 && ex.firstBlockOffMs > 0
        ? (ex.firstBlockOffMs - ex.tsvBeginMs) / 3_600_000 : null;
      const restAfter  = ex.tsvEndMs > 0 && ex.lastBlockOnMs > 0
        ? (ex.tsvEndMs - ex.lastBlockOnMs) / 3_600_000 : null;
      const { error: instErr } = await supabase
        .from('pairing_instance')
        .insert({
          signature_id: best.sigDbId,
          activity_id:  ex.actID,
          depart_date:  msToDateStr(ex.firstBlockOffMs),
          depart_at:    new Date(ex.firstBlockOffMs).toISOString(),
          arrivee_at:   new Date(ex.lastBlockOnMs).toISOString(),
          rest_before_h: restBefore,
          rest_after_h:  restAfter,
          scheduled_begin_activity_at: ex.tsvBeginMs > 0 ? new Date(ex.tsvBeginMs).toISOString() : null,
          scheduled_end_activity_at:   ex.tsvEndMs   > 0 ? new Date(ex.tsvEndMs).toISOString()   : null,
        });
      if (instErr) {
        if (errorSamples.length < 10) errorSamples.push(`inst ${ex.actID}: ${instErr.message}`);
        instUnmatched++;
        continue;
      }
      instInserted++;
    }
  } else {
    // Mode dégradé : 1 instance par sig à partir du cleanEp4.
    for (const bucket of [...sigsByKey.values()].flat()) {
      const rows = rotationToRows(bucket.rot);
      if (!rows) continue;
      const { inst } = rows;
      if (existingInstActIds.has(inst.activity_id)) { instSkipped++; continue; }
      const { error: instErr } = await supabase
        .from('pairing_instance')
        .insert({
          signature_id: bucket.sigDbId,
          activity_id:  inst.activity_id,
          depart_date:  inst.depart_date,
          depart_at:    inst.depart_at,
          arrivee_at:   inst.arrivee_at,
          rest_before_h: inst.rest_before_h,
          rest_after_h:  inst.rest_after_h,
          scheduled_begin_activity_at: inst.scheduled_begin_activity_at,
          scheduled_end_activity_at:   inst.scheduled_end_activity_at,
        });
      if (instErr) {
        if (errorSamples.length < 10) errorSamples.push(`inst ${inst.activity_id}: ${instErr.message}`);
        continue;
      }
      instInserted++;
    }
  }

  // Recompute totals sur tout le snapshot.
  const allSigsForSnap = await fetchAllPaginated<{ id: string }>((from, to) =>
    supabase.from('pairing_signature').select('id').eq('snapshot_id', snap.id).range(from, to),
  );
  const allSigIdsFinal = allSigsForSnap.map(r => r.id);
  const { count: trueInstanceCount } = await supabase
    .from('pairing_instance')
    .select('id', { count: 'exact', head: true })
    .in('signature_id', allSigIdsFinal);

  await supabase
    .from('scrape_snapshot')
    .update({
      status:            'success',
      finished_at:       new Date().toISOString(),
      flights_found:     trueInstanceCount ?? 0,
      unique_signatures: allSigIdsFinal.length,
    })
    .eq('id', snap.id);

  return Response.json({
    month,
    snapshot_id: snap.id,
    cleanEp4: {
      rotations_in_csv: rotations.length,
      in_target_month:  filteredRotations.length,
      inserted: sigsInserted,
      skipped:  sigsSkipped,
      errors:   sigsErrors,
    },
    extract: {
      rows_in_csv:     extractRows.length,
      in_target_month: filteredExtract.length,
      inserted:        instInserted,
      skipped:         instSkipped,
      unmatched:       instUnmatched,
    },
    errorSamples,
    totals: { signatures: allSigIdsFinal.length, instances: trueInstanceCount ?? 0 },
  });
}
