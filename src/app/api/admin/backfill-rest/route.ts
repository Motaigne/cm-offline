/**
 * POST /api/admin/backfill-rest
 * body: { month: 'YYYY-MM', cookie: string, sn: string, userId: string }
 *
 * Re-appelle uniquement la Phase 1 du scrape (1 requête pairingsearch) pour
 * récupérer les restBeforeHaulDuration / restPostHaulDuration corrects, puis
 * met à jour rest_before_h / rest_after_h sur les signatures existantes du
 * dernier snapshot success du mois. Pas de re-scrape, pas de nouveau snapshot.
 */
import { createClient } from '@/lib/supabase/server';
import { fetchAllPaginated } from '@/lib/supabase/paginate';
import { fetchAllPairings } from '@/lib/scraper/crewbidd';

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
  const { month, cookie, sn, userId } = body ?? {};
  if (!month || !cookie || !sn || !userId) {
    return new Response('month, cookie, sn, userId requis', { status: 400 });
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return new Response('month doit être au format YYYY-MM', { status: 400 });
  }

  // Dernier snapshot success du mois
  const { data: snap } = await supabase
    .from('scrape_snapshot')
    .select('id')
    .eq('target_month', `${month}-01`)
    .eq('status', 'success')
    .order('started_at', { ascending: false })
    .limit(1)
    .single();

  if (!snap) return new Response('Aucun snapshot success pour ce mois', { status: 404 });

  // Phase 1 : 1 seule requête pairingsearch → valeurs correctes
  const pairings = await fetchAllPairings(month, { cookie, sn, userId });

  // Map activityNumber → { restBeforeH, restAfterH }
  const restMap = new Map<string, { before: number; after: number }>();
  for (const p of pairings) {
    restMap.set(p.activityNumber, {
      before: p.pairingDetail.restBeforeHaulDuration,
      after:  p.pairingDetail.restPostHaulDuration,
    });
  }

  // Signatures existantes du snapshot
  const sigs = await fetchAllPaginated<{ id: string; activity_number: string; rest_before_h: number | null; rest_after_h: number | null }>(
    (from, to) => supabase
      .from('pairing_signature')
      .select('id, activity_number, rest_before_h, rest_after_h')
      .eq('snapshot_id', snap.id)
      .range(from, to),
  );

  let updated = 0, unchanged = 0, missing = 0;

  for (const sig of sigs) {
    const rest = restMap.get(sig.activity_number);
    if (!rest) { missing++; continue; }

    if (sig.rest_before_h === rest.before && sig.rest_after_h === rest.after) {
      unchanged++;
      continue;
    }

    await supabase
      .from('pairing_signature')
      .update({ rest_before_h: rest.before, rest_after_h: rest.after })
      .eq('id', sig.id);
    updated++;
  }

  return Response.json({ updated, unchanged, missing, total: sigs.length });
}
