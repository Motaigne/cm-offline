'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type { ActivityKind, BidCategory } from '@/lib/activity-meta';
import type { CalendarItem } from '@/app/page';

const SCENARIO_NAMES = ['A', 'B', 'C'] as const;
export type ScenarioName = typeof SCENARIO_NAMES[number];

async function getOrCreateDraft(
  userId: string,
  targetMonth: string,
  name: ScenarioName,
): Promise<string> {
  const supabase = await createClient();
  const monthDate = `${targetMonth}-01`;

  const { data: existing } = await supabase
    .from('planning_draft')
    .select('id')
    .eq('user_id', userId)
    .eq('target_month', monthDate)
    .eq('name', name)
    .single();

  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from('planning_draft')
    .insert({ user_id: userId, target_month: monthDate, name, is_primary: name === 'A' })
    .select('id')
    .single();

  if (error || !created) throw new Error(error?.message ?? 'Impossible de créer le scénario');
  return created.id;
}

export async function getOrCreateScenarios(
  targetMonth: string,
): Promise<{ name: ScenarioName; id: string }[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const results = await Promise.all(
    SCENARIO_NAMES.map(async (name) => ({
      name,
      id: await getOrCreateDraft(user.id, targetMonth, name),
    }))
  );
  return results;
}

export async function addPlanningItem(data: {
  id?: string;            // UUID généré côté client pour le support offline
  draft_id: string;
  kind: ActivityKind;
  start_date: string;
  end_date: string;
  bid_category?: BidCategory | null;
  pairing_instance_id?: string | null;
  meta?: import('@/types/supabase').Json | null;
}) {
  const supabase = await createClient();
  const { error } = await supabase.from('planning_item').insert(data);
  if (error) return { error: error.message };
  revalidatePath('/');
}

export async function deletePlanningItem(itemId: string) {
  const supabase = await createClient();
  const { error } = await supabase.from('planning_item').delete().eq('id', itemId);
  if (error) return { error: error.message };
  revalidatePath('/');
}

/**
 * Décale un mois "YYYY-MM" de `delta` mois.
 */
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Charge scénarios + items pour un mois — appelable côté client pour la navigation offline.
 *  Inclut les vols « à cheval » du mois précédent (point E) : flights dont end_date est dans M
 *  alors qu'ils sont rattachés à un draft de M-1, marqués _isSpillover=true.
 */
export async function getScenariosWithItems(month: string): Promise<{ name: ScenarioName; id: string; items: CalendarItem[] }[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const drafts = await getOrCreateScenarios(month);
  const draftIds = drafts.map(d => d.id);

  const { data: allItems } = await supabase
    .from('planning_item')
    .select('id, kind, start_date, end_date, bid_category, meta, draft_id')
    .in('draft_id', draftIds);

  // Spillovers : drafts du mois précédent (s'ils existent) avec leurs vols se prolongeant en M
  const prevMonth = shiftMonth(month, -1);
  const monthPrefix = month; // "YYYY-MM"
  const { data: prevDrafts } = await supabase
    .from('planning_draft')
    .select('id, name')
    .eq('user_id', user.id)
    .eq('target_month', `${prevMonth}-01`);

  const prevDraftByName = new Map<string, string>();
  for (const d of prevDrafts ?? []) {
    if (d.name === 'A' || d.name === 'B' || d.name === 'C') prevDraftByName.set(d.name, d.id);
  }

  let spillovers: (CalendarItem & { draft_id: string })[] = [];
  if (prevDraftByName.size > 0) {
    const { data: prevItems } = await supabase
      .from('planning_item')
      .select('id, kind, start_date, end_date, bid_category, meta, draft_id')
      .in('draft_id', Array.from(prevDraftByName.values()))
      .eq('kind', 'flight')
      .gte('end_date', `${monthPrefix}-01`);
    spillovers = ((prevItems ?? []) as (CalendarItem & { draft_id: string })[])
      .filter(it => it.start_date.slice(0, 7) < monthPrefix && it.end_date.slice(0, 7) >= monthPrefix);
  }

  return drafts.map(draft => {
    const own = ((allItems ?? []) as (CalendarItem & { draft_id: string })[])
      .filter(item => item.draft_id === draft.id)
      .map(({ draft_id: _d, ...it }) => it as CalendarItem);

    const prevDraftId = prevDraftByName.get(draft.name);
    const cross = prevDraftId
      ? spillovers
          .filter(it => it.draft_id === prevDraftId)
          .map(({ draft_id: _d, ...it }) => ({ ...it, _isSpillover: true } as CalendarItem))
      : [];

    return { name: draft.name, id: draft.id, items: [...own, ...cross] };
  });
}

export async function updatePlanningItem(
  itemId: string,
  startDate: string,
  endDate: string,
) {
  const supabase = await createClient();
  const { error } = await supabase
    .from('planning_item')
    .update({ start_date: startDate, end_date: endDate })
    .eq('id', itemId);
  if (error) return { error: error.message };
  revalidatePath('/');
}
