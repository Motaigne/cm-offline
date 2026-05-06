import { db } from './local-db';
import { addPlanningItem, deletePlanningItem, updatePlanningItem } from '@/app/actions/planning';
import type { CalendarItem } from '@/app/page';
import type { ActivityKind, BidCategory } from '@/lib/activity-meta';
import type { Json } from '@/types/supabase';

// ─── Types payload ────────────────────────────────────────────────────────────

type AddPayload = {
  id: string;
  draft_id: string;
  kind: ActivityKind;
  start_date: string;
  end_date: string;
  bid_category: BidCategory | null;
  meta: Json | null;
};
type DeletePayload = { id: string };
type UpdatePayload  = { id: string; start_date: string; end_date: string };

// ─── Enqueue helpers (écriture locale + mise en queue) ───────────────────────

export async function enqueueAdd(item: CalendarItem, draftId: string): Promise<void> {
  const payload: AddPayload = {
    id:           item.id,
    draft_id:     draftId,
    kind:         item.kind,
    start_date:   item.start_date,
    end_date:     item.end_date,
    bid_category: item.bid_category,
    meta:         item.meta as Json | null,
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

// ─── Sync ─────────────────────────────────────────────────────────────────────

/** Rejoue toute la queue vers Supabase. Appelé quand online revient. */
export async function syncNow(): Promise<void> {
  const ops = await db.sync_queue.orderBy('created_at').toArray();
  for (const op of ops) {
    try {
      if (op.op === 'add') {
        const p = JSON.parse(op.payload) as AddPayload;
        await addPlanningItem(p);
      } else if (op.op === 'delete') {
        const p = JSON.parse(op.payload) as DeletePayload;
        await deletePlanningItem(p.id);
      } else if (op.op === 'update') {
        const p = JSON.parse(op.payload) as UpdatePayload;
        await updatePlanningItem(p.id, p.start_date, p.end_date);
      }
      await db.sync_queue.delete(op.id!);
    } catch (e) {
      console.error('[sync] op failed:', op.op, e);
      // On s'arrête sur la première erreur pour respecter l'ordre
      break;
    }
  }
}

export async function pendingOpsCount(): Promise<number> {
  return db.sync_queue.count();
}
