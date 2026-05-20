// Backup local du calendrier : drafts + items + sync_queue, en JSON lisible.
// Conflits à l'import : remplace les mois présents dans le fichier, laisse les
// autres mois intacts. Le profil et les rotations cachées ne sont PAS inclus.

import { db, type SyncOp } from './local-db';
import type { CalendarItem } from '@/app/page';

const BACKUP_VERSION = 1;

interface BackupDraft {
  id: string;
  name: string;
  target_month: string;
}

interface BackupItem extends CalendarItem {
  draft_id: string;
}

export interface BackupFile {
  version: number;
  exported_at: string;
  drafts: BackupDraft[];
  items: BackupItem[];
  sync_queue: Omit<SyncOp, 'id'>[];
}

/** Exporte tout le contenu calendrier + queue. */
export async function exportBackup(): Promise<BackupFile> {
  const [drafts, items, queue] = await Promise.all([
    db.drafts.toArray(),
    db.items.toArray(),
    db.sync_queue.orderBy('created_at').toArray(),
  ]);
  return {
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    drafts:     drafts as BackupDraft[],
    items:      items  as BackupItem[],
    sync_queue: queue.map(({ id: _id, ...rest }) => rest),
  };
}

/** Déclenche le téléchargement du backup. */
export async function downloadBackup(): Promise<void> {
  const data = await exportBackup();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `optiP-backup-${data.exported_at.slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Parse le fichier de backup en validant sa structure. */
export function parseBackup(text: string): BackupFile {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('JSON invalide'); }
  if (!raw || typeof raw !== 'object') throw new Error('Format inattendu');
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== 'number') throw new Error('Version manquante');
  if (obj.version !== BACKUP_VERSION) throw new Error(`Version non supportée: ${obj.version}`);
  if (!Array.isArray(obj.drafts) || !Array.isArray(obj.items) || !Array.isArray(obj.sync_queue)) {
    throw new Error('Structure invalide');
  }
  return raw as BackupFile;
}

export interface ImportSummary {
  monthsReplaced: string[];
  draftsImported: number;
  itemsImported:  number;
  queueImported:  number;
}

/** Restaure le backup. Remplace UNIQUEMENT les mois présents dans le fichier ;
 *  les autres mois et leurs items restent intacts. La queue ne touche que les
 *  ops liées à des items des mois remplacés. */
export async function importBackup(backup: BackupFile): Promise<ImportSummary> {
  const monthsSet = new Set<string>();
  for (const d of backup.drafts) monthsSet.add(d.target_month);
  const monthsReplaced = Array.from(monthsSet).sort();

  await db.transaction('rw', db.drafts, db.items, db.sync_queue, async () => {
    // Identifie les drafts existants pour ces mois (à supprimer + leurs items).
    const existingDrafts = await db.drafts
      .where('target_month').anyOf(monthsReplaced).toArray();
    const existingDraftIds = existingDrafts.map(d => d.id);

    // Items existants liés à ces drafts → ids à supprimer.
    const existingItems = existingDraftIds.length
      ? await db.items.where('draft_id').anyOf(existingDraftIds).toArray()
      : [];
    const existingItemIds = new Set(existingItems.map(i => i.id));

    // Ops de queue à supprimer : celles qui touchent un item existant
    // OU un item du backup (pour éviter les doublons après restauration).
    const backupItemIds = new Set(backup.items.map(i => i.id));
    const queue = await db.sync_queue.toArray();
    const queueIdsToDelete: number[] = [];
    for (const op of queue) {
      let itemId: string | null = null;
      try { itemId = (JSON.parse(op.payload) as { id?: string }).id ?? null; } catch {}
      if (itemId && (existingItemIds.has(itemId) || backupItemIds.has(itemId))) {
        if (op.id != null) queueIdsToDelete.push(op.id);
      }
    }

    // Purge
    if (existingItems.length)    await db.items.bulkDelete([...existingItemIds]);
    if (existingDrafts.length)   await db.drafts.bulkDelete(existingDraftIds);
    if (queueIdsToDelete.length) await db.sync_queue.bulkDelete(queueIdsToDelete);

    // Restauration
    if (backup.drafts.length) await db.drafts.bulkPut(backup.drafts);
    if (backup.items.length)  await db.items.bulkPut(backup.items);
    if (backup.sync_queue.length) {
      // Ne restaure que les ops liées aux items du backup, pour rester cohérent
      // avec le périmètre "remplacer le mois ciblé".
      const opsToRestore = backup.sync_queue.filter(op => {
        try {
          const id = (JSON.parse(op.payload) as { id?: string }).id;
          return id ? backupItemIds.has(id) : false;
        } catch { return false; }
      });
      await db.sync_queue.bulkAdd(opsToRestore);
    }
  });

  return {
    monthsReplaced,
    draftsImported: backup.drafts.length,
    itemsImported:  backup.items.length,
    queueImported:  backup.sync_queue.length,
  };
}
