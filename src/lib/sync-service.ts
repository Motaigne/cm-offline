import { db } from './local-db';
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
} from '@/app/actions/a81';
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
}

export async function enqueueDelete(itemId: string): Promise<void> {
  const payload: DeletePayload = { id: itemId };
  await db.transaction('rw', db.items, db.sync_queue, async () => {
    await db.items.delete(itemId);
    await db.sync_queue.add({ op: 'delete', payload: JSON.stringify(payload), created_at: Date.now() });
  });
}

export async function enqueueUpdate(itemId: string, startDate: string, endDate: string): Promise<void> {
  const payload: UpdatePayload = { id: itemId, start_date: startDate, end_date: endDate };
  await db.transaction('rw', db.items, db.sync_queue, async () => {
    await db.items.where('id').equals(itemId).modify({ start_date: startDate, end_date: endDate });
    await db.sync_queue.add({ op: 'update', payload: JSON.stringify(payload), created_at: Date.now() });
  });
}

export async function enqueueBidCategoryUpdate(itemId: string, bidCategory: BidCategory | null): Promise<void> {
  const payload: UpdateBidPayload = { id: itemId, bid_category: bidCategory };
  await db.transaction('rw', db.items, db.sync_queue, async () => {
    await db.items.where('id').equals(itemId).modify({ bid_category: bidCategory });
    await db.sync_queue.add({ op: 'update_bid', payload: JSON.stringify(payload), created_at: Date.now() });
  });
}

export async function enqueueMetaUpdate(itemId: string, meta: Json | null): Promise<void> {
  const payload: UpdateMetaPayload = { id: itemId, meta };
  await db.transaction('rw', db.items, db.sync_queue, async () => {
    await db.items.where('id').equals(itemId).modify({ meta });
    await db.sync_queue.add({ op: 'update_meta', payload: JSON.stringify(payload), created_at: Date.now() });
  });
}

// ─── Notes ────────────────────────────────────────────────────────────────────

export async function enqueueAddNote(note: UserNote): Promise<void> {
  await db.transaction('rw', db.notes, db.sync_queue, async () => {
    await db.notes.put(note);
    await db.sync_queue.add({ op: 'add_note', payload: JSON.stringify(note), created_at: Date.now() });
  });
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
}

export async function enqueueDeleteNote(id: string): Promise<void> {
  const payload: DeleteNotePayload = { id };
  await db.transaction('rw', db.notes, db.sync_queue, async () => {
    await db.notes.delete(id);
    await db.sync_queue.add({ op: 'delete_note', payload: JSON.stringify(payload), created_at: Date.now() });
  });
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
}

export async function enqueueA81Delete(instanceId: string): Promise<void> {
  const payload: A81DeletePayload = { pairing_instance_id: instanceId };
  await db.transaction('rw', db.a81_overrides, db.sync_queue, async () => {
    await applyA81OverrideLocal(instanceId, { deleted: true });
    await db.sync_queue.add({ op: 'a81_delete', payload: JSON.stringify(payload), created_at: Date.now() });
  });
}

export async function enqueueA81Restore(instanceId: string): Promise<void> {
  const payload: A81RestorePayload = { pairing_instance_id: instanceId };
  await db.transaction('rw', db.a81_overrides, db.sync_queue, async () => {
    await applyA81OverrideLocal(instanceId, { deleted: false });
    await db.sync_queue.add({ op: 'a81_restore', payload: JSON.stringify(payload), created_at: Date.now() });
  });
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

/** Rejoue toute la queue vers Supabase. Appelé quand online revient.
 *
 *  Les server actions retournent `{ error: string }` sur échec (pas un throw),
 *  donc on inspecte le résultat et on throw nous-mêmes — sinon l'op serait
 *  supprimée de la queue alors que l'item n'a jamais été inséré côté serveur,
 *  ce qui le fait disparaître au prochain hydrateDB. */
export async function syncNow(): Promise<void> {
  const ops = await db.sync_queue.orderBy('created_at').toArray();
  for (const op of ops) {
    try {
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
      }
      if (res?.error) {
        throw new Error(res.error);
      }
      await db.sync_queue.delete(op.id!);
    } catch (e) {
      console.error('[sync] op failed:', op.op, e);
      // On s'arrête sur la première erreur pour respecter l'ordre.
      // L'op reste dans la queue et sera ré-essayée au prochain Sync.
      throw e;
    }
  }
}

export async function pendingOpsCount(): Promise<number> {
  return db.sync_queue.count();
}
