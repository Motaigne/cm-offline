'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type { ActivityKind, BidCategory } from '@/lib/activity-meta';
import type { CalendarItem } from '@/app/page';
import { computeEffectiveRpc } from '@/lib/rpc';

const SCENARIO_NAMES = ['A', 'B', 'C'] as const;
export type ScenarioName = typeof SCENARIO_NAMES[number];

async function getOrCreateDraft(
  userId: string,
  targetMonth: string,
  name: ScenarioName,
): Promise<string> {
  const supabase = await createClient();
  const monthDate = `${targetMonth}-01`;

  // .single() retourne data=null aussi bien sur 0 rows que >1 rows. Avant la
  // migration 0037 (unique index), des doublons historiques pouvaient exister
  // → .single() voyait null → INSERT créait un n+1ème doublon, et les
  // planning_item posés référencent un draft id de plus en plus obsolète à
  // chaque render. Fix : order+limit+maybeSingle = on prend toujours le plus
  // ancien (= canonique) de façon déterministe.
  async function selectCanonical(): Promise<string | null> {
    const { data } = await supabase
      .from('planning_draft')
      .select('id')
      .eq('user_id', userId)
      .eq('target_month', monthDate)
      .eq('name', name)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    return data?.id ?? null;
  }

  const existingId = await selectCanonical();
  if (existingId) return existingId;

  const { data: created, error } = await supabase
    .from('planning_draft')
    .insert({ user_id: userId, target_month: monthDate, name, is_primary: name === 'A' })
    .select('id')
    .single();

  // Race : si une autre requête a créé le draft entre notre SELECT et notre
  // INSERT, l'unique index renvoie 23505. On retombe sur le SELECT.
  if (error && (error.code === '23505' || /duplicate key/i.test(error.message))) {
    const retryId = await selectCanonical();
    if (retryId) return retryId;
  }

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
  if (error) {
    // 23505 = duplicate PK. L'UUID est généré côté client → une collision
    // signifie que l'op a déjà été appliquée (crash après INSERT serveur mais
    // avant suppression de l'op dans la sync_queue Dexie). On traite comme un
    // succès pour vider la queue et stopper le retry infini.
    if (error.code === '23505') {
      revalidatePath('/');
      return;
    }
    return { error: error.message };
  }
  revalidatePath('/');
}

export async function deletePlanningItem(itemId: string) {
  const supabase = await createClient();
  const { error } = await supabase.from('planning_item').delete().eq('id', itemId);
  if (error) return { error: error.message };
  revalidatePath('/');
}

/**
 * Reset complet du planning : supprime tous les items des scénarios donnés
 * (par défaut A, B, C) pour le mois indiqué — utilisateur courant uniquement.
 */
export async function resetPlanningScenarios(
  month: string,
  scenarios: ScenarioName[] = ['A', 'B', 'C'],
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Non authentifié' };

  const { data: drafts, error: dErr } = await supabase
    .from('planning_draft')
    .select('id')
    .eq('user_id', user.id)
    .eq('target_month', `${month}-01`)
    .in('name', scenarios);
  if (dErr) return { error: dErr.message };
  if (!drafts?.length) { revalidatePath('/'); return { ok: true, deleted: 0 }; }

  const draftIds = drafts.map(d => d.id);
  const { error, count } = await supabase
    .from('planning_item')
    .delete({ count: 'exact' })
    .in('draft_id', draftIds);
  if (error) return { error: error.message };
  revalidatePath('/');
  return { ok: true, deleted: count ?? 0 };
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
 *  Inclut les items de M-1 injectés en M :
 *    - body-spillover : vol dont start_date<M et end_date>=M ;
 *    - RPC-only spillover : vol dont le RPC étendu (chevauchement) atteint M
 *      (corps reste en M-1, on n'affiche que la queue post-RPC en M) ;
 *    - pause-spillover : congé/TAF/CSS/hard-blocker de M-1 dans la fenêtre RPC
 *      d'un spillover ci-dessus, requis pour que computeEffectiveRpc côté
 *      client retrouve les pauses. Jamais rendu, jamais validé.
 */
export async function getScenariosWithItems(month: string): Promise<{ name: ScenarioName; id: string; items: CalendarItem[] }[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const drafts = await getOrCreateScenarios(month);
  const draftIds = drafts.map(d => d.id);

  const { data: allItems } = await supabase
    .from('planning_item')
    .select('id, kind, start_date, end_date, bid_category, pairing_instance_id, meta, draft_id')
    .in('draft_id', draftIds);

  // Items de M-1 : on charge TOUT le draft pour pouvoir calculer le RPC max
  // et identifier vols+pauses qui débordent en M.
  const prevMonth = shiftMonth(month, -1);
  const monthFirstMs = new Date(`${month}-01T00:00:00Z`).getTime();
  const { data: prevDrafts } = await supabase
    .from('planning_draft')
    .select('id, name')
    .eq('user_id', user.id)
    .eq('target_month', `${prevMonth}-01`);

  const prevDraftByName = new Map<string, string>();
  for (const d of prevDrafts ?? []) {
    if (d.name === 'A' || d.name === 'B' || d.name === 'C') prevDraftByName.set(d.name, d.id);
  }

  const prevItemsByDraft = new Map<string, CalendarItem[]>();
  if (prevDraftByName.size > 0) {
    const { data: prevItems } = await supabase
      .from('planning_item')
      .select('id, kind, start_date, end_date, bid_category, pairing_instance_id, meta, draft_id')
      .in('draft_id', Array.from(prevDraftByName.values()));
    for (const raw of (prevItems ?? []) as (CalendarItem & { draft_id: string })[]) {
      const { draft_id, ...rest } = raw;
      const arr = prevItemsByDraft.get(draft_id) ?? [];
      arr.push(rest as CalendarItem);
      prevItemsByDraft.set(draft_id, arr);
    }
  }

  /** Construit la liste de spillovers (vols body/RPC + pauses) pour un draft. */
  function buildSpillover(prevDraftId: string): CalendarItem[] {
    const draftItems = prevItemsByDraft.get(prevDraftId);
    if (!draftItems) return [];
    const spilledFlights: CalendarItem[] = [];
    const pauseIds = new Set<string>();
    for (const flight of draftItems) {
      if (flight.kind !== 'flight') continue;
      if (flight.start_date.slice(0, 7) >= month) continue;
      const bodyCrosses = flight.end_date.slice(0, 7) >= month;
      if (bodyCrosses) {
        spilledFlights.push({ ...flight, _isSpillover: true });
      } else {
        const eff = computeEffectiveRpc(flight, draftItems, true);
        if (eff.endMs >= monthFirstMs) {
          spilledFlights.push({ ...flight, _isSpillover: true, _rpcOnlySpillover: true });
        }
      }
    }
    for (const flight of spilledFlights) {
      const meta = (flight.meta && typeof flight.meta === 'object' && !Array.isArray(flight.meta))
        ? flight.meta as Record<string, unknown> : null;
      const arrivee = typeof meta?.arrivee_at === 'string' ? new Date(meta.arrivee_at).getTime() : NaN;
      if (!Number.isFinite(arrivee)) continue;
      const eff = computeEffectiveRpc(flight, draftItems, true);
      const winStart = arrivee;
      const winEnd   = eff.endMs;
      if (winEnd <= winStart) continue;
      for (const it of draftItems) {
        if (it.kind === 'flight') continue;
        if (pauseIds.has(it.id)) continue;
        const sMs = new Date(it.start_date + 'T00:00:00Z').getTime();
        const eMs = new Date(it.end_date   + 'T00:00:00Z').getTime() + 86_400_000;
        if (sMs < winEnd && eMs > winStart) pauseIds.add(it.id);
      }
    }
    const pauseItems = draftItems
      .filter(it => pauseIds.has(it.id))
      .map(it => ({ ...it, _isSpillover: true, _isPauseSpillover: true } as CalendarItem));
    return [...spilledFlights, ...pauseItems];
  }

  return drafts.map(draft => {
    const own = ((allItems ?? []) as (CalendarItem & { draft_id: string })[])
      .filter(item => item.draft_id === draft.id)
      .map(({ draft_id: _d, ...it }) => it as CalendarItem);

    const prevDraftId = prevDraftByName.get(draft.name);
    const cross = prevDraftId ? buildSpillover(prevDraftId) : [];

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

/**
 * Met à jour la catégorie DDA (bid_category) d'un item — utilisé par le
 * sélecteur de placement de vol et l'édition. Permet le `null` pour repasser
 * à l'état non catégorisé.
 */
export async function updatePlanningItemBidCategory(
  itemId: string,
  bidCategory: BidCategory | null,
) {
  const supabase = await createClient();
  const { error } = await supabase
    .from('planning_item')
    .update({ bid_category: bidCategory })
    .eq('id', itemId);
  if (error) return { error: error.message };
  revalidatePath('/');
}

/**
 * Patch le champ meta (jsonb) d'un item — sert notamment à persister
 * l'acquittement du report de RPC (meta.rpc_reported = true) pour les paires
 * DDA VOL → CONGES.
 */
export async function updatePlanningItemMeta(
  itemId: string,
  meta: import('@/types/supabase').Json | null,
) {
  const supabase = await createClient();
  const { error } = await supabase
    .from('planning_item')
    .update({ meta })
    .eq('id', itemId);
  if (error) return { error: error.message };
  revalidatePath('/');
}
