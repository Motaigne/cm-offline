import Dexie, { type Table } from 'dexie';
import type { CalendarItem, Scenario } from '@/app/page';
import type { RotationSignature } from '@/app/actions/search';
import type { UserNote } from '@/app/actions/notes';
import type { ProfileVersion } from '@/app/actions/profile-version';
import type { AnnexeRow } from '@/lib/annexe';

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
  op: 'add' | 'delete' | 'update' | 'update_bid' | 'update_meta'
    | 'add_note' | 'update_note' | 'delete_note';
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

/** Annexe row stockée en Dexie. Clé primaire composite slug+valid_from. */
type StoredAnnexeRow = AnnexeRow & { key: string };
function annexeRowKey(slug: string, validFrom: string): string {
  return `${slug}|${validFrom}`;
}

class CmDatabase extends Dexie {
  drafts!:           Table<StoredDraft,      string>;
  items!:            Table<StoredItem,       string>;
  sync_queue!:       Table<SyncOp,           number>;
  rotations!:        Table<StoredRotation,   string>;
  releases!:         Table<StoredRelease,    string>;
  notes!:            Table<UserNote,         string>;
  profile_versions!: Table<ProfileVersion,   string>; // PK = valid_from (user_id implicite)
  annexe_rows!:      Table<StoredAnnexeRow,  string>; // PK = `${slug}|${valid_from}`

  constructor() {
    super('optip');
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
    // v4 : notes utilisateur (cross-scénario, indépendantes des drafts)
    this.version(4).stores({
      notes: 'id, start_date, end_date',
    });
    // v5 : cache profil versionné + annexe versionnée (pour A81 + GanttView offline)
    this.version(5).stores({
      profile_versions: 'valid_from',
      annexe_rows:      'key, slug, valid_from',
    });
  }
}

export const db = new CmDatabase();

// ─── helpers vol à cheval ─────────────────────────────────────────────────────

function shiftMonthStr(m: string, delta: number): string {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Items du mois M-1 dont end_date déborde en M (= spillovers à afficher en M).
 *  Retourne une Map<scenarioName, items>. Items stockés sous leur draft d'origine
 *  (mois de départ) — exposés en lecture seule via _isSpillover=true. */
async function loadSpillovers(month: string): Promise<Map<string, CalendarItem[]>> {
  const prevMonth = shiftMonthStr(month, -1);
  const prevDrafts = await db.drafts.where('target_month').equals(prevMonth).toArray();
  const result = new Map<string, CalendarItem[]>();
  if (prevDrafts.length === 0) return result;

  const byId = new Map<string, string>(); // draft_id → scenario name
  for (const d of prevDrafts) byId.set(d.id, d.name);

  const items = await db.items.where('draft_id').anyOf(prevDrafts.map(d => d.id)).toArray();
  for (const it of items) {
    if (it.kind !== 'flight') continue;
    if (it.start_date.slice(0, 7) >= month) continue;
    if (it.end_date.slice(0, 7) < month) continue;
    const name = byId.get(it.draft_id);
    if (!name) continue;
    const arr = result.get(name) ?? [];
    arr.push({ ...it, _isSpillover: true } as unknown as CalendarItem);
    // strip draft_id pour matcher la forme CalendarItem
    delete (arr[arr.length - 1] as unknown as { draft_id?: string }).draft_id;
    result.set(name, arr);
  }
  return result;
}

/** Met à jour le cache local pour un mois donné avec les données serveur.
 *  Préserve les items dont l'id est dans sync_queue (add/update non encore synchés).
 *  Les spillovers (items dont start_date < month) sont ignorés : ils restent
 *  stockés sous le draft de leur mois de départ et sont injectés à la lecture. */
export async function hydrateDB(scenarios: Scenario[], month: string): Promise<void> {
  const pendingOps = await db.sync_queue.toArray();
  const pendingIds = new Set(
    pendingOps
      .filter(op => op.op === 'add' || op.op === 'update' || op.op === 'update_bid' || op.op === 'update_meta')
      .map(op => (JSON.parse(op.payload) as { id: string }).id),
  );

  // Prépare les payloads HORS transaction pour ne pas casser la zone Dexie
  // (un long for+await peut faire commit/abort prématurément la tx).
  const draftRows: StoredDraft[] = scenarios.map(s => ({
    id: s.id, name: s.name, target_month: month,
  }));
  const itemRows: StoredItem[] = [];
  for (const s of scenarios) {
    for (const item of s.items) {
      // Skip spillovers : appartiennent au draft du mois précédent.
      if (item._isSpillover) continue;
      if (item.start_date.slice(0, 7) < month) continue;
      if (pendingIds.has(item.id)) continue;
      itemRows.push({ ...item, draft_id: s.id });
    }
  }

  await db.transaction('rw', db.drafts, db.items, async () => {
    const existing = await db.drafts.where('target_month').equals(month).toArray();
    const ids = existing.map(d => d.id);
    if (ids.length) {
      const all = await db.items.where('draft_id').anyOf(ids).toArray();
      await db.items.bulkDelete(all.filter(i => !pendingIds.has(i.id)).map(i => i.id));
    }
    await db.drafts.where('target_month').equals(month).delete();
    await db.drafts.bulkPut(draftRows);
    if (itemRows.length) await db.items.bulkPut(itemRows);
  });
}

/** Recharge les scénarios depuis IndexedDB (conserve la forme attendue par GanttView).
 *  Injecte les spillovers du mois M-1. */
export async function loadFromDB(scenarios: Scenario[], month: string): Promise<Scenario[]> {
  const spillovers = await loadSpillovers(month);
  return Promise.all(
    scenarios.map(async (s) => {
      const stored = await db.items.where('draft_id').equals(s.id).toArray();
      const own = stored.map(({ draft_id: _d, ...item }) => item as CalendarItem);
      const cross = spillovers.get(s.name) ?? [];
      return {
        id:    s.id,
        name:  s.name,
        items: [...own, ...cross],
      };
    }),
  );
}

export async function hasPendingOps(): Promise<boolean> {
  return (await db.sync_queue.count()) > 0;
}

/** Purge les items d'un mois pour les scénarios donnés + les ops de queue
 *  qui les concernent. Appelé après un Reset pour éviter que `loadScenariosForMonth`
 *  ressorte les items zombies au prochain changement de mois. */
export async function purgeScenarios(month: string, scenarioNames: string[]): Promise<void> {
  await db.transaction('rw', db.drafts, db.items, db.sync_queue, async () => {
    const drafts = await db.drafts.where('target_month').equals(month).toArray();
    const targets = drafts.filter(d => scenarioNames.includes(d.name));
    if (targets.length === 0) return;
    const ids = targets.map(d => d.id);
    const items = await db.items.where('draft_id').anyOf(ids).toArray();
    const itemIds = new Set(items.map(i => i.id));
    if (itemIds.size > 0) await db.items.bulkDelete([...itemIds]);

    const queue = await db.sync_queue.toArray();
    const opsToDelete: number[] = [];
    for (const op of queue) {
      try {
        const id = (JSON.parse(op.payload) as { id?: string }).id;
        if (id && itemIds.has(id) && op.id != null) opsToDelete.push(op.id);
      } catch {}
    }
    if (opsToDelete.length) await db.sync_queue.bulkDelete(opsToDelete);
  });
}

/** Charge les scénarios depuis IndexedDB pour un mois donné. Retourne null si non caché.
 *  Injecte les spillovers du mois M-1. */
export async function loadScenariosForMonth(month: string): Promise<Scenario[] | null> {
  const drafts = await db.drafts.where('target_month').equals(month).toArray();
  if (drafts.length === 0) return null;
  // Dexie ne garantit pas l'ordre par primary key dans une `where().toArray()` —
  // tri explicite par name pour avoir [A, B, C] et éviter le flash de swap au
  // chargement cache-first puis fetch réseau.
  drafts.sort((a, b) => a.name.localeCompare(b.name));
  const spillovers = await loadSpillovers(month);
  return Promise.all(
    drafts.map(async (d) => {
      const stored = await db.items.where('draft_id').equals(d.id).toArray();
      const own = stored.map(({ draft_id: _x, ...item }) => item as CalendarItem);
      const cross = spillovers.get(d.name) ?? [];
      return {
        id:    d.id,
        name:  d.name as Scenario['name'],
        items: [...own, ...cross],
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

// ─── Notes utilisateur (cross-scénario) ───────────────────────────────────────

/** Met à jour le cache local des notes pour un mois donné (= notes overlappant
 *  le mois). Préserve les notes pendantes dans sync_queue. */
export async function hydrateNotes(notes: UserNote[], month: string): Promise<void> {
  const pendingOps = await db.sync_queue.toArray();
  const pendingIds = new Set(
    pendingOps
      .filter(op => op.op === 'add_note' || op.op === 'update_note' || op.op === 'delete_note')
      .map(op => (JSON.parse(op.payload) as { id: string }).id),
  );

  const [y, m] = month.split('-').map(Number);
  const monthStartStr = `${y}-${String(m).padStart(2, '0')}-01`;
  const next = new Date(Date.UTC(y, m, 1));
  const monthEndStr = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`;

  await db.transaction('rw', db.notes, async () => {
    // Supprime les notes du mois (= overlappant) sauf les pendantes.
    const overlap = await db.notes
      .where('start_date').below(monthEndStr)
      .filter(n => n.end_date >= monthStartStr)
      .toArray();
    const toDelete = overlap.filter(n => !pendingIds.has(n.id)).map(n => n.id);
    if (toDelete.length) await db.notes.bulkDelete(toDelete);
    const toAdd = notes.filter(n => !pendingIds.has(n.id));
    if (toAdd.length) await db.notes.bulkPut(toAdd);
  });
}

// ─── Cache profil versionné ───────────────────────────────────────────────────

/** Remplace le cache local des versions de profil avec celles passées. */
export async function cacheProfileVersions(versions: ProfileVersion[]): Promise<void> {
  await db.transaction('rw', db.profile_versions, async () => {
    await db.profile_versions.clear();
    if (versions.length) await db.profile_versions.bulkPut(versions);
  });
}

export async function loadProfileVersionsLocal(): Promise<ProfileVersion[]> {
  const all = await db.profile_versions.toArray();
  return all.sort((a, b) => b.valid_from.localeCompare(a.valid_from));
}

// ─── Cache annexe versionnée ──────────────────────────────────────────────────

/** Remplace le cache local des rows annexe avec celles passées. */
export async function cacheAnnexeRows(rows: AnnexeRow[]): Promise<void> {
  const stored: StoredAnnexeRow[] = rows.map(r => ({ ...r, key: annexeRowKey(r.slug, r.valid_from) }));
  await db.transaction('rw', db.annexe_rows, async () => {
    await db.annexe_rows.clear();
    if (stored.length) await db.annexe_rows.bulkPut(stored);
  });
}

export async function loadAnnexeRowsLocal(): Promise<AnnexeRow[]> {
  const all = await db.annexe_rows.toArray();
  return all.map(({ key: _k, ...r }) => { void _k; return r as AnnexeRow; });
}

/** Notes locales overlappant le mois donné. */
export async function loadNotesForMonth(month: string): Promise<UserNote[]> {
  const [y, m] = month.split('-').map(Number);
  const monthStartStr = `${y}-${String(m).padStart(2, '0')}-01`;
  const next = new Date(Date.UTC(y, m, 1));
  const monthEndStr = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`;
  return db.notes
    .where('start_date').below(monthEndStr)
    .filter(n => n.end_date >= monthStartStr)
    .sortBy('start_date');
}
