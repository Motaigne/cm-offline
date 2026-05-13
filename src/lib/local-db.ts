import Dexie, { type Table } from 'dexie';
import type { CalendarItem, Scenario } from '@/app/page';
import type { RotationSignature } from '@/app/actions/search';

interface StoredDraft {
  id: string;
  name: string;
  target_month: string; // "YYYY-MM"
}

interface StoredItem extends CalendarItem {
  draft_id: string;
}

export interface SyncOp {
  id?: number;
  op: 'add' | 'delete' | 'update';
  payload: string; // JSON
  created_at: number;
}

type StoredRotation = RotationSignature & { target_month: string };

/** Release locale chiffrée (point A2). */
export interface StoredRelease {
  /** target_month YYYY-MM-DD — clé primaire (1 release latest par mois). */
  target_month: string;
  release_id: string;
  version: number;
  released_at: string;
  notes: string | null;
  /** AES-GCM IV (base64). */
  iv: string;
  /** ciphertext + auth tag (base64). */
  data: string;
  /** Clé AES-GCM (base64) — stockée localement pour permettre le déchiffrement offline. */
  key_b64: string;
  /** HMAC traçabilité fuite. */
  watermark: string;
  /** ISO string — passé cette date la release locale est considérée expirée. */
  expires_at: string;
  /** Timestamp local du download (ms). */
  downloaded_at: number;
}

class CmDatabase extends Dexie {
  drafts!:    Table<StoredDraft,    string>;
  items!:     Table<StoredItem,     string>;
  sync_queue!:Table<SyncOp,         number>;
  rotations!: Table<StoredRotation, string>;
  releases!:  Table<StoredRelease,  string>;

  constructor() {
    super('cm-offline');
    this.version(1).stores({
      drafts:     'id, target_month',
      items:      'id, draft_id',
      sync_queue: '++id, created_at',
    });
    // v2 : cache des rotations pour le panneau de recherche offline
    this.version(2).stores({
      rotations: 'id, target_month',
    });
    // v3 : releases mensuelles chiffrées (A2)
    this.version(3).stores({
      releases: 'target_month, release_id, expires_at',
    });
  }
}

export const db = new CmDatabase();

/** Met à jour le cache local pour un mois donné avec les données serveur.
 *  Préserve les items dont l'id est dans sync_queue (add/update non encore synchés). */
export async function hydrateDB(scenarios: Scenario[], month: string): Promise<void> {
  const pendingOps = await db.sync_queue.toArray();
  const pendingIds = new Set(
    pendingOps
      .filter(op => op.op === 'add' || op.op === 'update')
      .map(op => (JSON.parse(op.payload) as { id: string }).id),
  );

  await db.transaction('rw', db.drafts, db.items, async () => {
    const existing = await db.drafts.where('target_month').equals(month).toArray();
    const ids = existing.map(d => d.id);
    if (ids.length) {
      const all = await db.items.where('draft_id').anyOf(ids).toArray();
      await db.items.bulkDelete(all.filter(i => !pendingIds.has(i.id)).map(i => i.id));
    }
    await db.drafts.where('target_month').equals(month).delete();

    for (const s of scenarios) {
      await db.drafts.put({ id: s.id, name: s.name, target_month: month });
      for (const item of s.items) {
        if (!pendingIds.has(item.id)) {
          await db.items.put({ ...item, draft_id: s.id });
        }
      }
    }
  });
}

/** Recharge les scénarios depuis IndexedDB (conserve la forme attendue par GanttView). */
export async function loadFromDB(scenarios: Scenario[]): Promise<Scenario[]> {
  return Promise.all(
    scenarios.map(async (s) => {
      const stored = await db.items.where('draft_id').equals(s.id).toArray();
      return {
        id:    s.id,
        name:  s.name,
        items: stored.map(({ draft_id: _d, ...item }) => item as CalendarItem),
      };
    }),
  );
}

export async function hasPendingOps(): Promise<boolean> {
  return (await db.sync_queue.count()) > 0;
}

/** Charge les scénarios depuis IndexedDB pour un mois donné. Retourne null si non caché. */
export async function loadScenariosForMonth(month: string): Promise<Scenario[] | null> {
  const drafts = await db.drafts.where('target_month').equals(month).toArray();
  if (drafts.length === 0) return null;
  // Dexie ne garantit pas l'ordre par primary key dans une `where().toArray()` —
  // tri explicite par name pour avoir [A, B, C] et éviter le flash de swap au
  // chargement cache-first puis fetch réseau.
  drafts.sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(
    drafts.map(async (d) => {
      const stored = await db.items.where('draft_id').equals(d.id).toArray();
      return {
        id:    d.id,
        name:  d.name as Scenario['name'],
        items: stored.map(({ draft_id: _d, ...item }) => item as CalendarItem),
      };
    }),
  );
}

/** Liste des mois pour lesquels on a des rotations en cache. */
export async function getCachedMonths(): Promise<string[]> {
  const keys = await db.rotations.orderBy('target_month').uniqueKeys();
  return keys as string[];
}

// ─── Cache rotations (panneau de recherche) ───────────────────────────────────

export async function cacheRotations(sigs: RotationSignature[], month: string): Promise<void> {
  await db.transaction('rw', db.rotations, async () => {
    await db.rotations.where('target_month').equals(month).delete();
    await db.rotations.bulkPut(sigs.map(s => ({ ...s, target_month: month })));
  });
}

export async function loadRotationsFromDB(month: string): Promise<RotationSignature[]> {
  const stored = await db.rotations.where('target_month').equals(month).toArray();
  return stored.map(({ target_month: _t, ...sig }) => sig as RotationSignature);
}
