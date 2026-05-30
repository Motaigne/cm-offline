/**
 * POST /api/admin/import-csv-month
 * body: { month: 'YYYY-MM', csvText: string }
 *
 * Importe les rotations d'un mois depuis un CSV historique
 * (sources/8_cleanEp4_MMYYYY.csv) — utilisé pour Jan→Mai 2026 (avant que le
 * scrape CrewBidd ne soit branché). Idempotent : skip les sigs dont
 * activity_number est déjà en DB pour ce snapshot.
 *
 * Comportement :
 *   1. Get-or-create scrape_snapshot pour le mois (status='success' à la fin).
 *   2. Parse le CSV → rotations.
 *   3. Pour chaque rotation absente, insert sig + 1 instance.
 *
 * Admin only.
 */
import { createClient } from '@/lib/supabase/server';
import { fetchAllPaginated } from '@/lib/supabase/paginate';
import { parseRotationsCsv } from '@/lib/csv-import/parse';
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
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return new Response('month requis au format YYYY-MM', { status: 400 });
  }
  if (!csvText) return new Response('csvText requis', { status: 400 });

  let rotations;
  try {
    rotations = parseRotationsCsv(csvText);
  } catch (e) {
    return new Response(`CSV invalide : ${String(e)}`, { status: 400 });
  }

  // Filtre point C (cohérent avec le scraper) : ne garde que les rotations qui
  // décollent dans le mois cible.
  const [paramY, paramM] = month.split('-').map(Number);
  const filtered = rotations.filter(r => {
    const [y, m] = r.debutVol.split('-').map(Number);
    return y === paramY && m === paramM;
  });

  const snap = await getOrCreateMonthSnapshot(supabase, month, user.id);
  if (!snap) return new Response('Impossible de créer le snapshot', { status: 500 });

  // Diff par activity_number (= ID Ligne du CSV) : on ne ré-insère pas
  // les sigs déjà en DB pour ce snapshot.
  const existingSigs = await fetchAllPaginated<{ id: string; activity_number: string | null }>((from, to) =>
    supabase.from('pairing_signature')
      .select('id, activity_number')
      .eq('snapshot_id', snap.id)
      .range(from, to),
  );
  const existingActNums = new Set(existingSigs.map(s => s.activity_number).filter(Boolean) as string[]);

  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  const errorSamples: string[] = [];

  for (const rot of filtered) {
    if (existingActNums.has(rot.idLigne)) { skipped++; continue; }
    const rows = rotationToRows(rot);
    if (!rows) { errors++; continue; }
    const { sig, inst } = rows;

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
      errors++;
      if (errorSamples.length < 5) errorSamples.push(`${rot.code}: ${sigErr?.message ?? 'no row'}`);
      continue;
    }

    const { error: instErr } = await supabase
      .from('pairing_instance')
      .insert({
        signature_id: sigRow.id,
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
      errors++;
      if (errorSamples.length < 5) errorSamples.push(`${rot.code} (inst): ${instErr.message}`);
      continue;
    }
    inserted++;
  }

  // Recompute totals sur tout le snapshot (pas seulement cet import)
  const allSigsForSnap = await fetchAllPaginated<{ id: string }>((from, to) =>
    supabase.from('pairing_signature').select('id').eq('snapshot_id', snap.id).range(from, to),
  );
  const allSigIds = allSigsForSnap.map(r => r.id);
  const { count: trueInstanceCount } = await supabase
    .from('pairing_instance')
    .select('id', { count: 'exact', head: true })
    .in('signature_id', allSigIds);

  await supabase
    .from('scrape_snapshot')
    .update({
      status:            'success',
      finished_at:       new Date().toISOString(),
      flights_found:     trueInstanceCount ?? 0,
      unique_signatures: allSigIds.length,
    })
    .eq('id', snap.id);

  return Response.json({
    month,
    snapshot_id:   snap.id,
    rotations_in_csv: rotations.length,
    in_target_month:  filtered.length,
    inserted,
    skipped,
    errors,
    errorSamples,
    totals: { signatures: allSigIds.length, instances: trueInstanceCount ?? 0 },
  });
}
