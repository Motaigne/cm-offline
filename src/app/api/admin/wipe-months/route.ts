/**
 * POST /api/admin/wipe-months
 * body: { months: string[] }   (format YYYY-MM)
 *
 * Supprime tous les `scrape_snapshot` + signatures + instances pour les mois
 * donnés (cascade ON DELETE CASCADE en DB). Avant cascade, désaccroche les
 * `planning_item` qui pointaient sur ces instances (set pairing_instance_id =
 * null) pour préserver les drafts utilisateur.
 *
 * Destructif — admin only.
 */
import { createClient } from '@/lib/supabase/server';
import { fetchAllPaginated } from '@/lib/supabase/paginate';

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
  const months = body?.months as string[] | undefined;
  if (!Array.isArray(months) || months.length === 0) {
    return new Response('months[] requis', { status: 400 });
  }
  for (const m of months) {
    if (!/^\d{4}-\d{2}$/.test(m)) {
      return new Response(`month invalide: ${m} (attendu YYYY-MM)`, { status: 400 });
    }
  }

  const results: Array<{
    month: string;
    snapshots: number;
    signatures: number;
    instances: number;
    items_unlinked: number;
  }> = [];

  for (const month of months) {
    const monthDate = `${month}-01`;
    const { data: snaps } = await supabase
      .from('scrape_snapshot')
      .select('id')
      .eq('target_month', monthDate);
    const snapIds = (snaps ?? []).map(s => s.id);
    if (snapIds.length === 0) {
      results.push({ month, snapshots: 0, signatures: 0, instances: 0, items_unlinked: 0 });
      continue;
    }

    // 1) Récupère toutes les sigs des snapshots
    const sigs = await fetchAllPaginated<{ id: string }>((from, to) =>
      supabase.from('pairing_signature').select('id').in('snapshot_id', snapIds).range(from, to),
    );
    const sigIds = sigs.map(s => s.id);

    // 2) Récupère toutes les instances de ces sigs
    let instIds: string[] = [];
    if (sigIds.length > 0) {
      const insts = await fetchAllPaginated<{ id: string }>((from, to) =>
        supabase.from('pairing_instance').select('id').in('signature_id', sigIds).range(from, to),
      );
      instIds = insts.map(i => i.id);
    }

    // 3) Unlink planning_items qui pointent sur ces instances (par chunks de 1000)
    let itemsUnlinked = 0;
    const CHUNK = 1000;
    for (let i = 0; i < instIds.length; i += CHUNK) {
      const slice = instIds.slice(i, i + CHUNK);
      const { count } = await supabase
        .from('planning_item')
        .update({ pairing_instance_id: null }, { count: 'exact' })
        .in('pairing_instance_id', slice);
      itemsUnlinked += count ?? 0;
    }

    // 4) Delete les snapshots → cascade vers signatures + instances
    await supabase.from('scrape_snapshot').delete().in('id', snapIds);

    results.push({
      month,
      snapshots: snapIds.length,
      signatures: sigIds.length,
      instances:  instIds.length,
      items_unlinked: itemsUnlinked,
    });
  }

  return Response.json({ results });
}
