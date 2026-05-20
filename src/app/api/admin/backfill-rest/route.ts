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

  // Phase 1 : 1 seule requête pairingsearch → valeurs correctes par instance
  const pairings = await fetchAllPairings(month, { cookie, sn, userId });

  // Map actId → { before, after } : per-instance RPC.
  // Map activityNumber → { before, after } depuis la 1ère instance vue :
  // utilisé pour synchroniser le legacy `pairing_signature.rest_*_h`.
  const instRest = new Map<string, { before: number; after: number }>();
  const sigRest  = new Map<string, { before: number; after: number }>();
  for (const p of pairings) {
    const v = {
      before: p.pairingDetail.restBeforeHaulDuration,
      after:  p.pairingDetail.restPostHaulDuration,
    };
    instRest.set(String(p.actId), v);
    if (!sigRest.has(p.activityNumber)) sigRest.set(p.activityNumber, v);
  }

  // Signatures existantes du snapshot (pour MAJ legacy rest_*_h signature-level)
  const sigs = await fetchAllPaginated<{ id: string; activity_number: string | null; rest_before_h: number | null; rest_after_h: number | null }>(
    (from, to) => supabase
      .from('pairing_signature')
      .select('id, activity_number, rest_before_h, rest_after_h')
      .eq('snapshot_id', snap.id)
      .range(from, to),
  );
  const sigIds = sigs.map(s => s.id);

  // Instances existantes (du snapshot, via signature_id) — pour MAJ rest_*_h par instance
  const insts = sigIds.length
    ? await fetchAllPaginated<{ id: string; activity_id: string; rest_before_h: number | null; rest_after_h: number | null }>(
        (from, to) => supabase
          .from('pairing_instance')
          .select('id, activity_id, rest_before_h, rest_after_h')
          .in('signature_id', sigIds)
          .range(from, to),
      )
    : [];

  let updated = 0, unchanged = 0, missing = 0;

  // Met à jour signatures (legacy)
  for (const sig of sigs) {
    if (!sig.activity_number) continue;
    const rest = sigRest.get(sig.activity_number);
    if (!rest) continue;
    if (sig.rest_before_h !== rest.before || sig.rest_after_h !== rest.after) {
      await supabase
        .from('pairing_signature')
        .update({ rest_before_h: rest.before, rest_after_h: rest.after })
        .eq('id', sig.id);
    }
  }

  // Met à jour instances (vraie source de vérité par instance)
  for (const inst of insts) {
    if (!inst.activity_id) { missing++; continue; }
    const rest = instRest.get(inst.activity_id);
    if (!rest) { missing++; continue; }
    if (inst.rest_before_h === rest.before && inst.rest_after_h === rest.after) {
      unchanged++;
      continue;
    }
    await supabase
      .from('pairing_instance')
      .update({ rest_before_h: rest.before, rest_after_h: rest.after })
      .eq('id', inst.id);
    updated++;
  }

  return Response.json({ updated, unchanged, missing, total: insts.length });
}
