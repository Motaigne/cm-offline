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

  // Phase 1 : 1 seule requête pairingsearch → on recalcule le RPC depuis les
  // timestamps (scheduledEndActivityDate - endBlockDate). Les champs
  // restPostHaulDuration des endpoints SEARCH et DETAIL sont menteurs (chacun
  // dans des cas différents) ; les timestamps sont la source de vérité.
  const pairings = await fetchAllPairings(month, { cookie, sn, userId });

  type PerInst = {
    before: number | null;
    after: number | null;
    beginActivityAt: string | null;
    endActivityAt: string | null;
  };
  function computePerInst(p: typeof pairings[number]): PerInst {
    const before = (p.scheduledBeginActivityDate > 0 && p.beginBlockDate > 0)
      ? (p.beginBlockDate - p.scheduledBeginActivityDate) / 3_600_000
      : (p.pairingDetail.restBeforeHaulDuration ?? null);
    const after  = (p.scheduledEndActivityDate > 0 && p.endBlockDate > 0)
      ? (p.scheduledEndActivityDate - p.endBlockDate) / 3_600_000
      : (p.pairingDetail.restPostHaulDuration ?? null);
    const beginActivityAt = p.scheduledBeginActivityDate > 0
      ? new Date(p.scheduledBeginActivityDate).toISOString() : null;
    const endActivityAt = p.scheduledEndActivityDate > 0
      ? new Date(p.scheduledEndActivityDate).toISOString() : null;
    return { before, after, beginActivityAt, endActivityAt };
  }

  // Map actId → PerInst : RPC + timestamps activity par instance.
  // Map activityNumber → { before, after } depuis la 1ère instance vue :
  // utilisé pour synchroniser le legacy `pairing_signature.rest_*_h`.
  const instRest = new Map<string, PerInst>();
  const sigRest  = new Map<string, { before: number | null; after: number | null }>();
  for (const p of pairings) {
    const v = computePerInst(p);
    instRest.set(String(p.actId), v);
    if (!sigRest.has(p.activityNumber)) sigRest.set(p.activityNumber, { before: v.before, after: v.after });
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

  // Instances existantes (du snapshot, via signature_id) — pour MAJ rest_*_h + activity timestamps par instance
  const insts = sigIds.length
    ? await fetchAllPaginated<{
        id: string; activity_id: string;
        rest_before_h: number | null; rest_after_h: number | null;
        scheduled_begin_activity_at: string | null; scheduled_end_activity_at: string | null;
      }>(
        (from, to) => supabase
          .from('pairing_instance')
          .select('id, activity_id, rest_before_h, rest_after_h, scheduled_begin_activity_at, scheduled_end_activity_at')
          .in('signature_id', sigIds)
          .range(from, to),
      )
    : [];

  let updated = 0, unchanged = 0, missing = 0;

  // Met à jour signatures (legacy) — en parallèle, batches de 20
  const sigUpdates = sigs
    .filter(sig => {
      if (!sig.activity_number) return false;
      const rest = sigRest.get(sig.activity_number);
      if (!rest) return false;
      return sig.rest_before_h !== rest.before || sig.rest_after_h !== rest.after;
    })
    .map(sig => {
      const rest = sigRest.get(sig.activity_number!)!;
      return supabase
        .from('pairing_signature')
        .update({ rest_before_h: rest.before, rest_after_h: rest.after })
        .eq('id', sig.id);
    });
  const CHUNK = 20;
  for (let i = 0; i < sigUpdates.length; i += CHUNK) {
    await Promise.all(sigUpdates.slice(i, i + CHUNK));
  }

  // Met à jour instances (vraie source de vérité par instance) — en parallèle, batches de 20
  const instUpdates: PromiseLike<unknown>[] = [];
  for (const inst of insts) {
    if (!inst.activity_id) { missing++; continue; }
    const rest = instRest.get(inst.activity_id);
    if (!rest) { missing++; continue; }
    const sameRest = inst.rest_before_h === rest.before && inst.rest_after_h === rest.after;
    const sameActivity = inst.scheduled_begin_activity_at === rest.beginActivityAt
      && inst.scheduled_end_activity_at === rest.endActivityAt;
    if (sameRest && sameActivity) {
      unchanged++;
      continue;
    }
    instUpdates.push(
      supabase
        .from('pairing_instance')
        .update({
          rest_before_h: rest.before,
          rest_after_h:  rest.after,
          scheduled_begin_activity_at: rest.beginActivityAt,
          scheduled_end_activity_at:   rest.endActivityAt,
        })
        .eq('id', inst.id),
    );
    updated++;
  }
  for (let i = 0; i < instUpdates.length; i += CHUNK) {
    await Promise.all(instUpdates.slice(i, i + CHUNK));
  }

  return Response.json({ updated, unchanged, missing, total: insts.length });
}
