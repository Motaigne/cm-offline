// Sauvegardes / restaurations Dexie en deux fichiers JSON distincts :
//
//   • Planning (par-user)  : drafts + items + sync_queue + notes
//                            + a81_overrides + a81_year_data + profile_versions
//   • Database (partagée)  : rotations + releases + annexe_rows
//
// Ces deux exports permettent à un utilisateur de restaurer un cache vidé en
// mode hors-ligne (sans réseau), en chargeant les deux fichiers téléchargés
// en ligne au préalable.
//
// Rétro-compatibilité : les anciens fichiers `optiP-backup-*.json` v1 (qui
// ne contenaient que drafts/items/sync_queue) restent importables — détectés
// par l'absence de champ `kind` ou par `kind === 'planning'` + version 1.

import {
  db,
  type SyncOp,
  type StoredRelease,
  type A81YearDataLocal,
} from './local-db';
import type { CalendarItem } from '@/app/page';
import type { UserNote } from '@/app/actions/notes';
import type { ProfileVersion } from '@/app/actions/profile-version';
import type { AnnexeRow } from '@/lib/annexe';
import type { A81OverrideLocal } from '@/lib/a81-local';
import type { RotationSignature } from '@/app/actions/search';

const PLANNING_VERSION = 2;
const DATABASE_VERSION = 1;

// ─── Types ────────────────────────────────────────────────────────────────────

interface BackupDraft {
  id: string;
  name: string;
  target_month: string;
}

interface BackupItem extends CalendarItem {
  draft_id: string;
}

/** Format v1 historique — drafts/items/sync_queue uniquement. Plus exporté
 *  mais reste importable pour les utilisateurs qui ont déjà un .json local. */
export interface BackupFileV1 {
  version: 1;
  exported_at: string;
  drafts: BackupDraft[];
  items: BackupItem[];
  sync_queue: Omit<SyncOp, 'id'>[];
}

export interface PlanningBackupFile {
  version: typeof PLANNING_VERSION;
  kind: 'planning';
  exported_at: string;
  drafts:            BackupDraft[];
  items:             BackupItem[];
  sync_queue:        Omit<SyncOp, 'id'>[];
  notes:             UserNote[];
  a81_overrides:     A81OverrideLocal[];
  a81_year_data:     A81YearDataLocal[];
  profile_versions:  ProfileVersion[];
}

type StoredRotation = RotationSignature & { target_month: string };
type StoredAnnexeRow = AnnexeRow & { key: string };

export interface DatabaseBackupFile {
  version: typeof DATABASE_VERSION;
  kind: 'database';
  exported_at: string;
  rotations:    StoredRotation[];
  releases:     StoredRelease[];
  annexe_rows:  StoredAnnexeRow[];
}

export type AnyBackupFile = BackupFileV1 | PlanningBackupFile | DatabaseBackupFile;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nowIso(): string { return new Date().toISOString(); }

function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ─── Export Planning ──────────────────────────────────────────────────────────

export async function exportPlanning(): Promise<PlanningBackupFile> {
  const [drafts, items, queue, notes, overrides, yearData, profiles] = await Promise.all([
    db.drafts.toArray(),
    db.items.toArray(),
    db.sync_queue.orderBy('created_at').toArray(),
    db.notes.toArray(),
    db.a81_overrides.toArray(),
    db.a81_year_data.toArray(),
    db.profile_versions.toArray(),
  ]);
  return {
    version:          PLANNING_VERSION,
    kind:             'planning',
    exported_at:      nowIso(),
    drafts:           drafts as BackupDraft[],
    items:            items  as BackupItem[],
    sync_queue:       queue.map(({ id: _id, ...rest }) => rest),
    notes,
    a81_overrides:    overrides,
    a81_year_data:    yearData,
    profile_versions: profiles,
  };
}

export async function downloadPlanning(): Promise<void> {
  const data = await exportPlanning();
  downloadJson(data, `optiP-planning-${data.exported_at.slice(0, 10)}.json`);
}

// ─── Export Database ──────────────────────────────────────────────────────────

export async function exportDatabase(): Promise<DatabaseBackupFile> {
  const [rotations, releases, annexeRows] = await Promise.all([
    db.rotations.toArray(),
    db.releases.toArray(),
    db.annexe_rows.toArray(),
  ]);
  return {
    version:     DATABASE_VERSION,
    kind:        'database',
    exported_at: nowIso(),
    rotations,
    releases,
    annexe_rows: annexeRows,
  };
}

export async function downloadDatabase(): Promise<void> {
  const data = await exportDatabase();
  downloadJson(data, `optiP-database-${data.exported_at.slice(0, 10)}.json`);
}

// ─── Parse (détection automatique du format) ──────────────────────────────────

/** Parse un fichier JSON exporté (planning v2, database v1, ou backup legacy v1).
 *  Lève une erreur si le format est invalide ou non supporté. */
export function parseBackupFile(text: string): AnyBackupFile {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('JSON invalide'); }
  if (!raw || typeof raw !== 'object') throw new Error('Format inattendu');
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== 'number') throw new Error('Version manquante');

  const kind = typeof obj.kind === 'string' ? obj.kind : null;

  // Legacy v1 sans kind = planning historique.
  if (kind === null) {
    if (obj.version !== 1) throw new Error(`Version legacy non supportée: ${obj.version}`);
    if (!Array.isArray(obj.drafts) || !Array.isArray(obj.items) || !Array.isArray(obj.sync_queue)) {
      throw new Error('Structure legacy invalide');
    }
    return raw as BackupFileV1;
  }

  if (kind === 'planning') {
    if (obj.version !== PLANNING_VERSION) {
      throw new Error(`Version Planning non supportée: ${obj.version}`);
    }
    const required: (keyof PlanningBackupFile)[] = [
      'drafts', 'items', 'sync_queue', 'notes',
      'a81_overrides', 'a81_year_data', 'profile_versions',
    ];
    for (const k of required) {
      if (!Array.isArray(obj[k])) throw new Error(`Champ planning manquant: ${k}`);
    }
    return raw as PlanningBackupFile;
  }

  if (kind === 'database') {
    if (obj.version !== DATABASE_VERSION) {
      throw new Error(`Version Database non supportée: ${obj.version}`);
    }
    for (const k of ['rotations', 'releases', 'annexe_rows'] as const) {
      if (!Array.isArray(obj[k])) throw new Error(`Champ database manquant: ${k}`);
    }
    return raw as DatabaseBackupFile;
  }

  throw new Error(`Type de backup inconnu: ${kind}`);
}

// ─── Import Planning ──────────────────────────────────────────────────────────

export interface PlanningImportSummary {
  drafts: number;
  items: number;
  notes: number;
  queue: number;
  a81_overrides: number;
  a81_year_data: number;
  profile_versions: number;
}

/** Restaure intégralement le planning utilisateur — remplace toutes les tables
 *  perso par le contenu du backup. Les tables catalogue (rotations/releases/
 *  annexe) ne sont PAS touchées. */
export async function importPlanning(backup: PlanningBackupFile): Promise<PlanningImportSummary> {
  await db.transaction(
    'rw',
    [db.drafts, db.items, db.sync_queue, db.notes,
     db.a81_overrides, db.a81_year_data, db.profile_versions],
    async () => {
      await Promise.all([
        db.drafts.clear(),
        db.items.clear(),
        db.sync_queue.clear(),
        db.notes.clear(),
        db.a81_overrides.clear(),
        db.a81_year_data.clear(),
        db.profile_versions.clear(),
      ]);
      if (backup.drafts.length)           await db.drafts.bulkPut(backup.drafts);
      if (backup.items.length)            await db.items.bulkPut(backup.items);
      if (backup.sync_queue.length)       await db.sync_queue.bulkAdd(backup.sync_queue);
      if (backup.notes.length)            await db.notes.bulkPut(backup.notes);
      if (backup.a81_overrides.length)    await db.a81_overrides.bulkPut(backup.a81_overrides);
      if (backup.a81_year_data.length)    await db.a81_year_data.bulkPut(backup.a81_year_data);
      if (backup.profile_versions.length) await db.profile_versions.bulkPut(backup.profile_versions);
    },
  );
  return {
    drafts:           backup.drafts.length,
    items:            backup.items.length,
    notes:            backup.notes.length,
    queue:            backup.sync_queue.length,
    a81_overrides:    backup.a81_overrides.length,
    a81_year_data:    backup.a81_year_data.length,
    profile_versions: backup.profile_versions.length,
  };
}

// ─── Import Database ──────────────────────────────────────────────────────────

export interface DatabaseImportSummary {
  rotations: number;
  releases: number;
  annexe_rows: number;
  months: string[];
}

/** Restaure intégralement le cache catalogue (rotations, releases, annexe).
 *  Les tables perso (drafts/items/notes/...) ne sont PAS touchées.
 *
 *  Compat schema v9 : le format historique stockait raw_detail dans la row
 *  rotations. On split sur import → rotations (light) + rotation_details
 *  (raw_detail). Les backups exportés post-v9 n'ont déjà plus raw_detail
 *  dans rotations, donc rien à split. */
export async function importDatabase(backup: DatabaseBackupFile): Promise<DatabaseImportSummary> {
  type RawRotation = { id: string; raw_detail?: unknown } & Record<string, unknown>;
  const rawRotations = backup.rotations as RawRotation[];
  const lightRotations: RawRotation[] = [];
  const details: { id: string; raw_detail: unknown }[] = [];
  for (const r of rawRotations) {
    if (r.raw_detail) {
      details.push({ id: r.id, raw_detail: r.raw_detail });
      const { raw_detail: _, ...rest } = r;
      lightRotations.push(rest as RawRotation);
    } else {
      lightRotations.push(r);
    }
  }
  await db.transaction('rw', db.rotations, db.rotation_details, db.releases, db.annexe_rows, async () => {
    await Promise.all([
      db.rotations.clear(),
      db.rotation_details.clear(),
      db.releases.clear(),
      db.annexe_rows.clear(),
    ]);
    if (lightRotations.length)     await db.rotations.bulkPut(lightRotations as never);
    if (details.length)            await db.rotation_details.bulkPut(details);
    if (backup.releases.length)    await db.releases.bulkPut(backup.releases);
    if (backup.annexe_rows.length) await db.annexe_rows.bulkPut(backup.annexe_rows);
  });
  const months = Array.from(new Set(backup.rotations.map(r => r.target_month))).sort();
  return {
    rotations:   backup.rotations.length,
    releases:    backup.releases.length,
    annexe_rows: backup.annexe_rows.length,
    months,
  };
}

// ─── Import legacy v1 ─────────────────────────────────────────────────────────

export interface LegacyImportSummary {
  monthsReplaced: string[];
  draftsImported: number;
  itemsImported:  number;
  queueImported:  number;
}

/** Restaure un backup legacy v1 (drafts + items + sync_queue uniquement).
 *  Conserve le comportement historique : remplace UNIQUEMENT les mois présents
 *  dans le fichier, laisse les autres mois intacts. */
export async function importLegacyBackup(backup: BackupFileV1): Promise<LegacyImportSummary> {
  const monthsSet = new Set<string>();
  for (const d of backup.drafts) monthsSet.add(d.target_month);
  const monthsReplaced = Array.from(monthsSet).sort();

  await db.transaction('rw', db.drafts, db.items, db.sync_queue, async () => {
    const existingDrafts = await db.drafts
      .where('target_month').anyOf(monthsReplaced).toArray();
    const existingDraftIds = existingDrafts.map(d => d.id);

    const existingItems = existingDraftIds.length
      ? await db.items.where('draft_id').anyOf(existingDraftIds).toArray()
      : [];
    const existingItemIds = new Set(existingItems.map(i => i.id));

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

    if (existingItems.length)    await db.items.bulkDelete([...existingItemIds]);
    if (existingDrafts.length)   await db.drafts.bulkDelete(existingDraftIds);
    if (queueIdsToDelete.length) await db.sync_queue.bulkDelete(queueIdsToDelete);

    if (backup.drafts.length) await db.drafts.bulkPut(backup.drafts);
    if (backup.items.length)  await db.items.bulkPut(backup.items);
    if (backup.sync_queue.length) {
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
