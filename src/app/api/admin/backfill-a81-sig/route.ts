/**
 * POST /api/admin/backfill-a81-sig
 *
 * Backfille les 4 colonnes A81 (debut_sejour_at, fin_sejour_at,
 * escale_debut, escale_fin) sur les pairing_signature existantes,
 * calculées depuis raw_detail. Idempotent : ne touche que les rows où
 * au moins un des 4 champs est null.
 *
 * Admin only.
 */
import { createClient } from '@/lib/supabase/server';
import { fetchAllPaginated } from '@/lib/supabase/paginate';
import type { PairingDetail } from '@/lib/scraper/types';

const FIVE_MIN_MS = 5  * 60 * 1000;
const TEN_MIN_MS  = 10 * 60 * 1000;

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

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const { data: profile } = await supabase
    .from('user_profile')
    .select('is_admin')
    .eq('user_id', user.id)
    .single();
  if (!profile?.is_admin) return new Response('Forbidden', { status: 403 });

  // Pioche les signatures dont au moins un champ A81 est null (idempotent).
  const sigs = await fetchAllPaginated<{
    id: string; first_layover: string | null; raw_detail: unknown;
    debut_sejour_at: string | null; fin_sejour_at: string | null;
    escale_debut: string | null; escale_fin: string | null;
  }>((from, to) => supabase
    .from('pairing_signature')
    .select('id, first_layover, raw_detail, debut_sejour_at, fin_sejour_at, escale_debut, escale_fin')
    .or('debut_sejour_at.is.null,fin_sejour_at.is.null,escale_debut.is.null,escale_fin.is.null')
    .range(from, to),
  );

  let updated = 0, skipped = 0, noRawDetail = 0;
  const CHUNK = 20;
  const promises: PromiseLike<unknown>[] = [];

  for (const sig of sigs) {
    if (!sig.raw_detail) { noRawDetail++; continue; }
    const meta = computeA81Meta(sig.raw_detail as PairingDetail, sig.first_layover);
    if (!meta.debut_sejour_at) { skipped++; continue; }
    promises.push(
      supabase.from('pairing_signature')
        .update({
          debut_sejour_at: meta.debut_sejour_at,
          fin_sejour_at:   meta.fin_sejour_at,
          escale_debut:    meta.escale_debut,
          escale_fin:      meta.escale_fin,
        })
        .eq('id', sig.id),
    );
    updated++;
  }

  for (let i = 0; i < promises.length; i += CHUNK) {
    await Promise.all(promises.slice(i, i + CHUNK));
  }

  return Response.json({
    candidates: sigs.length,
    updated,
    skipped,            // raw_detail présent mais flightDuty < 2 → pas de séjour
    no_raw_detail: noRawDetail,
  });
}
