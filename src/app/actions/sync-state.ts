'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

/** "YYYY-MM" + delta mois → "YYYY-MM". */
function shiftMonthStr(m: string, delta: number): string {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Retourne, pour chaque mois demandé, le timestamp (ms) du dernier changement
 *  qui pourrait impacter son rendu. Le client compare à son
 *  `month_sync_state.last_full_pulled_at` (Dexie) : si client ≥ server, le mois
 *  est skippé dans le Pull différentiel.
 *
 *  Fenêtre M-1 ∪ M par mois demandé : un draft M-1 modifié impacte les
 *  spillovers (vols+pauses) injectés en M par `getScenariosWithItems`.
 *  Une sig M-1 rescrapée idem (raw_detail, rest_after_h).
 *
 *  Tables agrégées :
 *   - `scrape_snapshot.started_at` (rescrape d'un mois)
 *   - `pairing_signature.updated_at` (mig 0041, backfill + trigger)
 *   - `planning_draft.updated_at` (drafts du user)
 *   - `planning_item.updated_at` (items du user via drafts)
 *
 *  Coût : 4 SELECTs parallèles, payload total kB. Largement < 1 RPC par mois.
 */
export async function getMonthsLastModified(
  months: string[],
): Promise<Record<string, number>> {
  if (months.length === 0) return {};

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Fenêtre = union {M-1, M} pour chaque M demandé, dédupliquée.
  const windowSet = new Set<string>();
  for (const m of months) {
    windowSet.add(m);
    windowSet.add(shiftMonthStr(m, -1));
  }
  const windowMonthDates = Array.from(windowSet).map(m => `${m}-01`);

  // 4 requêtes parallèles. Aucune ne devrait être lente (toutes indexées
  // sur target_month, snapshot_id, draft_id) ; payload léger (timestamps + clés).
  const [snapsRes, draftsRes] = await Promise.all([
    supabase
      .from('scrape_snapshot')
      .select('id, target_month, started_at')
      .eq('status', 'success')
      .in('target_month', windowMonthDates),
    supabase
      .from('planning_draft')
      .select('id, target_month, updated_at')
      .eq('user_id', user.id)
      .in('target_month', windowMonthDates),
  ]);

  const snaps = snapsRes.data ?? [];
  const drafts = draftsRes.data ?? [];

  // Sigs : on agrège par snapshot_id, le rattachement au mois se fait via snaps.
  const snapIds = snaps.map(s => s.id);
  const [sigsRes, itemsRes] = await Promise.all([
    snapIds.length === 0
      ? Promise.resolve({ data: [] as { snapshot_id: string; updated_at: string }[] })
      : supabase
          .from('pairing_signature')
          .select('snapshot_id, updated_at')
          .in('snapshot_id', snapIds)
          .order('updated_at', { ascending: false }),
    drafts.length === 0
      ? Promise.resolve({ data: [] as { draft_id: string; updated_at: string }[] })
      : supabase
          .from('planning_item')
          .select('draft_id, updated_at')
          .in('draft_id', drafts.map(d => d.id))
          .order('updated_at', { ascending: false }),
  ]);

  const sigs = sigsRes.data ?? [];
  const items = itemsRes.data ?? [];

  // Pré-aggrege par mois (M-01 → max ms) pour chaque source.
  const snapMaxByMonth = new Map<string, number>();
  for (const s of snaps) {
    const ms = new Date(s.started_at).getTime();
    const cur = snapMaxByMonth.get(s.target_month) ?? 0;
    if (ms > cur) snapMaxByMonth.set(s.target_month, ms);
  }

  // snapshot_id → target_month (pour rattacher la sig au mois)
  const snapMonthById = new Map<string, string>();
  for (const s of snaps) snapMonthById.set(s.id, s.target_month);

  const sigMaxByMonth = new Map<string, number>();
  for (const sig of sigs) {
    const month = snapMonthById.get(sig.snapshot_id);
    if (!month) continue;
    const ms = new Date(sig.updated_at).getTime();
    const cur = sigMaxByMonth.get(month) ?? 0;
    if (ms > cur) sigMaxByMonth.set(month, ms);
  }

  const draftMaxByMonth = new Map<string, number>();
  for (const d of drafts) {
    const ms = new Date(d.updated_at).getTime();
    const cur = draftMaxByMonth.get(d.target_month) ?? 0;
    if (ms > cur) draftMaxByMonth.set(d.target_month, ms);
  }

  const draftMonthById = new Map<string, string>();
  for (const d of drafts) draftMonthById.set(d.id, d.target_month);

  const itemMaxByMonth = new Map<string, number>();
  for (const it of items) {
    const month = draftMonthById.get(it.draft_id);
    if (!month) continue;
    const ms = new Date(it.updated_at).getTime();
    const cur = itemMaxByMonth.get(month) ?? 0;
    if (ms > cur) itemMaxByMonth.set(month, ms);
  }

  // Pour chaque mois demandé : max sur fenêtre {M-1, M} × 4 sources.
  const result: Record<string, number> = {};
  for (const m of months) {
    const mMinus1Date = `${shiftMonthStr(m, -1)}-01`;
    const mDate = `${m}-01`;
    const candidates = [
      snapMaxByMonth.get(mMinus1Date) ?? 0,
      snapMaxByMonth.get(mDate) ?? 0,
      sigMaxByMonth.get(mMinus1Date) ?? 0,
      sigMaxByMonth.get(mDate) ?? 0,
      draftMaxByMonth.get(mMinus1Date) ?? 0,
      draftMaxByMonth.get(mDate) ?? 0,
      itemMaxByMonth.get(mMinus1Date) ?? 0,
      itemMaxByMonth.get(mDate) ?? 0,
    ];
    result[m] = Math.max(...candidates);
  }

  return result;
}
