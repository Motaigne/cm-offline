import { db, type SyncOp } from './local-db';
import {
  addPlanningItem,
  deletePlanningItem,
  updatePlanningItem,
  updatePlanningItemBidCategory,
  updatePlanningItemMeta,
} from '@/app/actions/planning';
import {
  addNote,
  updateNote,
  deleteNote,
  type UserNote,
} from '@/app/actions/notes';
import {
  upsertA81Override,
  deleteA81Row,
  restoreA81Row,
  saveA81PlafondExo,
} from '@/app/actions/a81';
import {
  saveProfile,
  type ProfileData,
} from '@/app/actions/profile';
import {
  saveProfileVersion,
  deleteProfileVersion,
  type ProfileVersion,
} from '@/app/actions/profile-version';
import type { CalendarItem } from '@/app/page';
import type { ActivityKind, BidCategory } from '@/lib/activity-meta';
import type { Json } from '@/types/supabase';
import type { A81OverrideLocal } from '@/lib/a81-local';

// ─── Types payload ────────────────────────────────────────────────────────────

type AddPayload = {
  id: string;
  draft_id: string;
  kind: ActivityKind;
  start_date: string;
  end_date: string;
  bid_category: BidCategory | null;
  pairing_instance_id?: string | null;
  meta: Json | null;
};
type DeletePayload    = { id: string };
type UpdatePayload    = { id: string; start_date: string; end_date: string };
type UpdateBidPayload = { id: string; bid_category: BidCategory | null };
type UpdateMetaPayload = { id: string; meta: Json | null };

type AddNotePayload    = UserNote;
type UpdateNotePayload = { id: string; start_date?: string; end_date?: string; text?: string; color?: string | null };
type DeleteNotePayload = { id: string };

// A81 overrides (édit/delete/restore par instance)
type A81UpsertPayload  = { pairing_instance_id: string; debut_sejour_at?: string | null; fin_sejour_at?: string | null };
type A81DeletePayload  = { pairing_instance_id: string };
type A81RestorePayload = { pairing_instance_id: string };
type A81SavePlafondExoPayload = { year: number; plafond_exo_brut: number | null };

// Profil utilisateur (user_profile : compat) — pas de cache local, juste queue.
type SaveProfilePayload = ProfileData;
// Profil versionné (user_profile_version : source de vérité paie).
type SaveProfileVersionFields = Partial<Omit<ProfileVersion, 'user_id' | 'valid_from' | 'created_at' | 'updated_at'>>;
type SaveProfileVersionPayload = { valid_from: string; fields: SaveProfileVersionFields };
type DeleteProfileVersionPayload = { valid_from: string };

// ─── Event : compteur de queue changé ─────────────────────────────────────────
// Dispatché à chaque enqueue ET à chaque sync (pour MAJ instantanée du badge NavBar).
const PENDING_EVENT = 'cm-pending-count-changed';
function notifyPendingChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PENDING_EVENT));
  }
}
export const PENDING_CHANGED_EVENT = PENDING_EVENT;

// ─── Enqueue helpers (écriture locale + mise en queue) ───────────────────────

export async function enqueueAdd(item: CalendarItem, draftId: string): Promise<void> {
  const payload: AddPayload = {
    id:                  item.id,
    draft_id:            draftId,
    kind:                item.kind,
    start_date:          item.start_date,
    end_date:            item.end_date,
    bid_category:        item.bid_category,
    pairing_instance_id: item.pairing_instance_id ?? null,
    meta:                item.meta as Json | null,
  };
  await db.transaction('rw', db.items, db.sync_queue, async () => {
    await db.items.put({ ...item, draft_id: draftId });
    await db.sync_queue.add({ op: 'add', payload: JSON.stringify(payload), created_at: Date.now() });
  });
  notifyPendingChanged();
}

export async function enqueueDelete(itemId: string): Promise<void> {
  await db.transaction('rw', db.items, db.sync_queue, async () => {
    await db.items.delete(itemId);
    // Coalescing : si l'item a une op 'add' encore en queue, le serveur ne le
    // connaît pas → on supprime add + updates intermédiaires et on ne pousse
    // PAS le delete. Net : compteur revient à zéro pour ce cycle add+delete.
    const ops = await db.sync_queue.toArray();
    const opsForItem = ops.filter(op => {
      if (op.op !== 'add' && op.op !== 'delete' && op.op !== 'update'
          && op.op !== 'update_bid' && op.op !== 'update_meta') return false;
      try { return (JSON.parse(op.payload) as { id?: string }).id === itemId; }
      catch { return false; }
    });
    const hasPendingAdd = opsForItem.some(op => op.op === 'add');
    if (hasPendingAdd) {
      const ids = opsForItem.map(op => op.id!).filter((x): x is number => typeof x === 'number');
      if (ids.length) await db.sync_queue.bulkDelete(ids);
      return;
    }
    const payload: DeletePayload = { id: itemId };
    await db.sync_queue.add({ op: 'delete', payload: JSON.stringify(payload), created_at: Date.now() });
  });
  notifyPendingChanged();
}

export async function enqueueUpdate(itemId: string, startDate: string, endDate: string): Promise<void> {
  const payload: UpdatePayload = { id: itemId, start_date: startDate, end_date: endDate };
  await db.transaction('rw', db.items, db.sync_queue, async () => {
    await db.items.where('id').equals(itemId).modify({ start_date: startDate, end_date: endDate });
    await db.sync_queue.add({ op: 'update', payload: JSON.stringify(payload), created_at: Date.now() });
  });
  notifyPendingChanged();
}

export async function enqueueBidCategoryUpdate(itemId: string, bidCategory: BidCategory | null): Promise<void> {
  const payload: UpdateBidPayload = { id: itemId, bid_category: bidCategory };
  await db.transaction('rw', db.items, db.sync_queue, async () => {
    await db.items.where('id').equals(itemId).modify({ bid_category: bidCategory });
    await db.sync_queue.add({ op: 'update_bid', payload: JSON.stringify(payload), created_at: Date.now() });
  });
  notifyPendingChanged();
}

export async function enqueueMetaUpdate(itemId: string, meta: Json | null): Promise<void> {
  const payload: UpdateMetaPayload = { id: itemId, meta };
  await db.transaction('rw', db.items, db.sync_queue, async () => {
    await db.items.where('id').equals(itemId).modify({ meta });
    await db.sync_queue.add({ op: 'update_meta', payload: JSON.stringify(payload), created_at: Date.now() });
  });
  notifyPendingChanged();
}

// ─── Notes ────────────────────────────────────────────────────────────────────

export async function enqueueAddNote(note: UserNote): Promise<void> {
  await db.transaction('rw', db.notes, db.sync_queue, async () => {
    await db.notes.put(note);
    await db.sync_queue.add({ op: 'add_note', payload: JSON.stringify(note), created_at: Date.now() });
  });
  notifyPendingChanged();
}

export async function enqueueUpdateNote(
  id: string,
  patch: { start_date?: string; end_date?: string; text?: string; color?: string | null },
): Promise<void> {
  const payload: UpdateNotePayload = { id, ...patch };
  await db.transaction('rw', db.notes, db.sync_queue, async () => {
    await db.notes.where('id').equals(id).modify(patch);
    await db.sync_queue.add({ op: 'update_note', payload: JSON.stringify(payload), created_at: Date.now() });
  });
  notifyPendingChanged();
}

export async function enqueueDeleteNote(id: string): Promise<void> {
  const payload: DeleteNotePayload = { id };
  await db.transaction('rw', db.notes, db.sync_queue, async () => {
    await db.notes.delete(id);
    await db.sync_queue.add({ op: 'delete_note', payload: JSON.stringify(payload), created_at: Date.now() });
  });
  notifyPendingChanged();
}

// ─── A81 overrides ────────────────────────────────────────────────────────────

async function applyA81OverrideLocal(
  instanceId: string,
  patch: Partial<Omit<A81OverrideLocal, 'pairing_instance_id'>>,
): Promise<void> {
  const existing = await db.a81_overrides.get(instanceId);
  const next: A81OverrideLocal = {
    pairing_instance_id: instanceId,
    deleted:         existing?.deleted ?? false,
    debut_sejour_at: existing?.debut_sejour_at ?? null,
    fin_sejour_at:   existing?.fin_sejour_at   ?? null,
    ...patch,
  };
  await db.a81_overrides.put(next);
}

export async function enqueueA81UpsertOverride(
  instanceId: string,
  fields: { debut_sejour_at?: string | null; fin_sejour_at?: string | null },
): Promise<void> {
  const payload: A81UpsertPayload = { pairing_instance_id: instanceId, ...fields };
  await db.transaction('rw', db.a81_overrides, db.sync_queue, async () => {
    await applyA81OverrideLocal(instanceId, fields);
    await db.sync_queue.add({ op: 'a81_upsert_override', payload: JSON.stringify(payload), created_at: Date.now() });
  });
  notifyPendingChanged();
}

export async function enqueueA81Delete(instanceId: string): Promise<void> {
  const payload: A81DeletePayload = { pairing_instance_id: instanceId };
  await db.transaction('rw', db.a81_overrides, db.sync_queue, async () => {
    await applyA81OverrideLocal(instanceId, { deleted: true });
    await db.sync_queue.add({ op: 'a81_delete', payload: JSON.stringify(payload), created_at: Date.now() });
  });
  notifyPendingChanged();
}

export async function enqueueA81Restore(instanceId: string): Promise<void> {
  const payload: A81RestorePayload = { pairing_instance_id: instanceId };
  await db.transaction('rw', db.a81_overrides, db.sync_queue, async () => {
    await applyA81OverrideLocal(instanceId, { deleted: false });
    await db.sync_queue.add({ op: 'a81_restore', payload: JSON.stringify(payload), created_at: Date.now() });
  });
  notifyPendingChanged();
}

export async function enqueueA81SavePlafondExo(year: number, value: number | null): Promise<void> {
  const payload: A81SavePlafondExoPayload = { year, plafond_exo_brut: value };
  await db.transaction('rw', db.a81_year_data, db.sync_queue, async () => {
    await db.a81_year_data.put({ year, plafond_exo_brut: value });
    await db.sync_queue.add({ op: 'a81_save_plafond_exo', payload: JSON.stringify(payload), created_at: Date.now() });
  });
  notifyPendingChanged();
}

// ─── Profil utilisateur ───────────────────────────────────────────────────────

/** Queue un save de user_profile (table de compat). Pas de cache local : la
 *  donnée est consommée serveur-only (display_name, onboarding check). */
export async function enqueueSaveProfile(data: ProfileData): Promise<void> {
  const payload: SaveProfilePayload = data;
  await db.sync_queue.add({ op: 'save_profile', payload: JSON.stringify(payload), created_at: Date.now() });
  notifyPendingChanged();
}

/** Queue un save de user_profile_version + écrit la version dans le cache
 *  local optimistiquement (les calculs paie consomment cette table offline).
 *  `optimisticRow` doit être la ligne complète telle qu'attendue par les
 *  lecteurs (incl. user_id, created_at, updated_at, base, instructeur). */
export async function enqueueSaveProfileVersion(
  validFrom: string,
  fields: SaveProfileVersionFields,
  optimisticRow: ProfileVersion,
): Promise<void> {
  const payload: SaveProfileVersionPayload = { valid_from: validFrom, fields };
  await db.transaction('rw', db.profile_versions, db.sync_queue, async () => {
    await db.profile_versions.put(optimisticRow);
    await db.sync_queue.add({ op: 'save_profile_version', payload: JSON.stringify(payload), created_at: Date.now() });
  });
  notifyPendingChanged();
}

/** Queue une suppression de user_profile_version + retire du cache local. */
export async function enqueueDeleteProfileVersion(validFrom: string): Promise<void> {
  const payload: DeleteProfileVersionPayload = { valid_from: validFrom };
  await db.transaction('rw', db.profile_versions, db.sync_queue, async () => {
    await db.profile_versions.delete(validFrom);
    await db.sync_queue.add({ op: 'delete_profile_version', payload: JSON.stringify(payload), created_at: Date.now() });
  });
  notifyPendingChanged();
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

/** Dispatch une op vers son server action. Throw si error retourné. */
async function runSingleOp(op: SyncOp): Promise<void> {
  let res: { error?: string } | undefined;
  if (op.op === 'add') {
    const p = JSON.parse(op.payload) as AddPayload;
    res = await addPlanningItem(p);
  } else if (op.op === 'delete') {
    const p = JSON.parse(op.payload) as DeletePayload;
    res = await deletePlanningItem(p.id);
  } else if (op.op === 'update') {
    const p = JSON.parse(op.payload) as UpdatePayload;
    res = await updatePlanningItem(p.id, p.start_date, p.end_date);
  } else if (op.op === 'update_bid') {
    const p = JSON.parse(op.payload) as UpdateBidPayload;
    res = await updatePlanningItemBidCategory(p.id, p.bid_category);
  } else if (op.op === 'update_meta') {
    const p = JSON.parse(op.payload) as UpdateMetaPayload;
    res = await updatePlanningItemMeta(p.id, p.meta);
  } else if (op.op === 'add_note') {
    const p = JSON.parse(op.payload) as AddNotePayload;
    res = await addNote(p);
  } else if (op.op === 'update_note') {
    const p = JSON.parse(op.payload) as UpdateNotePayload;
    const { id, ...patch } = p;
    res = await updateNote(id, patch);
  } else if (op.op === 'delete_note') {
    const p = JSON.parse(op.payload) as DeleteNotePayload;
    res = await deleteNote(p.id);
  } else if (op.op === 'a81_upsert_override') {
    const p = JSON.parse(op.payload) as A81UpsertPayload;
    const { pairing_instance_id, ...fields } = p;
    const r = await upsertA81Override(pairing_instance_id, fields);
    res = 'error' in r ? r : {};
  } else if (op.op === 'a81_delete') {
    const p = JSON.parse(op.payload) as A81DeletePayload;
    const r = await deleteA81Row(p.pairing_instance_id);
    res = 'error' in r ? r : {};
  } else if (op.op === 'a81_restore') {
    const p = JSON.parse(op.payload) as A81RestorePayload;
    const r = await restoreA81Row(p.pairing_instance_id);
    res = 'error' in r ? r : {};
  } else if (op.op === 'a81_save_plafond_exo') {
    const p = JSON.parse(op.payload) as A81SavePlafondExoPayload;
    const r = await saveA81PlafondExo(p.year, p.plafond_exo_brut);
    res = 'error' in r ? r : {};
  } else if (op.op === 'save_profile') {
    const p = JSON.parse(op.payload) as SaveProfilePayload;
    const r = await saveProfile(p);
    res = r && 'error' in r ? r : {};
  } else if (op.op === 'save_profile_version') {
    const p = JSON.parse(op.payload) as SaveProfileVersionPayload;
    const r = await saveProfileVersion(p.valid_from, p.fields);
    res = 'error' in r ? r : {};
  } else if (op.op === 'delete_profile_version') {
    const p = JSON.parse(op.payload) as DeleteProfileVersionPayload;
    const r = await deleteProfileVersion(p.valid_from);
    res = 'error' in r ? r : {};
  }
  if (res?.error) throw new Error(res.error);
}

/** Clé d'entité pour grouper les ops : 2 ops sur la même entité doivent
 *  rester séquentielles (add avant update/delete, FK, ordre logique). Les
 *  ops sur entités différentes peuvent tourner en parallèle. */
function entityKey(op: SyncOp): string {
  try {
    const p = JSON.parse(op.payload) as Record<string, unknown>;
    switch (op.op) {
      case 'add': case 'delete': case 'update': case 'update_bid': case 'update_meta':
        return `item:${p.id as string}`;
      case 'add_note': case 'update_note': case 'delete_note':
        return `note:${p.id as string}`;
      case 'a81_upsert_override': case 'a81_delete': case 'a81_restore':
        return `a81ov:${p.pairing_instance_id as string}`;
      case 'a81_save_plafond_exo':
        return `a81y:${p.year as number}`;
      case 'save_profile':
        // Pas d'ID naturel : tous les save_profile partagent une clé pour rester séquentiels.
        return 'profile';
      case 'save_profile_version': case 'delete_profile_version':
        return `pv:${p.valid_from as string}`;
    }
  } catch { /* payload malformé : fallback sur op.id pour isoler */ }
  return `unknown:${op.id ?? ''}`;
}

/** Concurrence bornée : workers parallèles tirent dans une file commune. */
async function runWithLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      const i = cursor++;
      try { results[i] = { status: 'fulfilled', value: await tasks[i]() }; }
      catch (e) { results[i] = { status: 'rejected', reason: e }; }
    }
  }
  const n = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/** Rejoue toute la queue vers Supabase. Appelé quand online revient.
 *
 *  Stratégie : ops sur la même entité (même item.id, note.id, etc.) restent
 *  séquentielles (ordre + FK), mais entités différentes tournent en parallèle
 *  (limite 8 — évite de saturer Supabase sur grosses queues post-offline).
 *  Un groupe qui fail laisse les ops restantes de ce groupe en queue ; les
 *  autres groupes continuent. syncNow throw à la fin s'il reste une erreur,
 *  pour signaler au caller (NavBar affiche statut 'err').
 *
 *  Les server actions retournent `{ error: string }` sur échec — runSingleOp
 *  inspecte et throw, sinon l'op serait supprimée alors qu'elle a échoué. */
export async function syncNow(): Promise<void> {
  const ops = await db.sync_queue.orderBy('created_at').toArray();
  if (ops.length === 0) return;

  // Regroupement par entité. Map préserve l'ordre d'insertion, et les ops sont
  // déjà triées par created_at → ordre intra-groupe conservé.
  const groups = new Map<string, SyncOp[]>();
  for (const op of ops) {
    const key = entityKey(op);
    const arr = groups.get(key);
    if (arr) arr.push(op); else groups.set(key, [op]);
  }

  const runGroup = (groupOps: SyncOp[]) => async (): Promise<void> => {
    for (const op of groupOps) {
      try {
        await runSingleOp(op);
      } catch (e) {
        console.error('[sync] op failed:', op.op, e);
        // Op échouée + suivantes du groupe restent en queue pour retry.
        throw e;
      }
      await db.sync_queue.delete(op.id!);
      notifyPendingChanged();
    }
  };

  const tasks = [...groups.values()].map(runGroup);
  const results = await runWithLimit(tasks, 8);

  const firstFail = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
  if (firstFail) throw firstFail.reason;
}

export async function pendingOpsCount(): Promise<number> {
  return db.sync_queue.count();
}
