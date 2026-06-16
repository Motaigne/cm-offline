import Dexie, { type Table } from 'dexie';
import type { CalendarItem, Scenario } from '@/app/page';
import type { RotationSignature } from '@/app/actions/search';
import type { UserNote } from '@/app/actions/notes';
import type { ProfileVersion } from '@/app/actions/profile-version';
import type { AnnexeRow } from '@/lib/annexe';
import type { A81OverrideLocal } from '@/lib/a81-local';
import type { TauxAppRow } from '@/lib/ep4';
import { computeEffectiveRpc } from '@/lib/rpc';

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
    | 'add_note' | 'update_note' | 'delete_note'
    | 'a81_upsert_override' | 'a81_delete' | 'a81_restore'
    | 'a81_save_plafond_exo'
    | 'save_profile' | 'save_profile_version' | 'delete_profile_version';
  payload: string; // JSON
  created_at: number;
}

/** Année A81 — données saisies (plafond exo brut). */
export interface A81YearDataLocal {
  year: number;
  plafond_exo_brut: number | null;
}

type StoredRotation = RotationSignature & { target_month: string };

/** Row taux_app stockée en Dexie. Clé primaire composite `rot_code|min|max`. */
type StoredTauxAppRow = TauxAppRow & { key: string };
function tauxAppKey(r: TauxAppRow): string {
  return `${r.rot_code}|${r.duree_min_h}|${r.duree_max_h}`;
}

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
  drafts!:           Table<StoredDraft,        string>;
  items!:            Table<StoredItem,         string>;
  sync_queue!:       Table<SyncOp,             number>;
  rotations!:        Table<StoredRotation,     string>;
  releases!:         Table<StoredRelease,      string>;
  notes!:            Table<UserNote,           string>;
  profile_versions!: Table<ProfileVersion,     string>; // PK = valid_from (user_id implicite)
  annexe_rows!:      Table<StoredAnnexeRow,    string>; // PK = `${slug}|${valid_from}`
  a81_overrides!:    Table<A81OverrideLocal,   string>; // PK = pairing_instance_id
  a81_year_data!:    Table<A81YearDataLocal,   number>; // PK = year
  taux_app!:         Table<StoredTauxAppRow,   string>; // PK = `${rot_code}|${min_h}|${max_h}`

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
    // v6 : overrides A81 (édits utilisateur sur le tableau A81)
    this.version(6).stores({
      a81_overrides: 'pairing_instance_id',
    });
    // v7 : données année A81 (plafond exo brut saisi par user)
    this.version(7).stores({
      a81_year_data: 'year',
    });
    // v8 : table taux_app (brackets AF rot_code → taux) — utilisée par EP4 offline
    this.version(8).stores({
      taux_app: 'key, rot_code',
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

/** Items de M-1 à injecter en M. 3 sous-cas :
 *    - body-spillover : vol dont start_date < M et end_date >= M (vol à cheval) ;
 *    - RPC-only spillover : vol dont le corps reste en M-1 mais dont le RPC
 *      étendu (mode chevauchement) atteint M. Le client ne dessine que la
 *      queue post-RPC en M.
 *    - pause-spillover : congé/TAF/CSS/sol/sim/medical/instr/autre de M-1 qui
 *      tombe dans la fenêtre RPC d'un spillover ci-dessus. Inclus uniquement
 *      pour que `computeEffectiveRpc` puisse recalculer les pauses côté client.
 *      Jamais rendu (clipItem renvoie null), jamais validé (filtré côté DDA).
 *  Tous les items sont marqués `_isSpillover=true` (read-only + filtres copy/
 *  reset existants). Les sous-cas sont distingués par les flags dédiés. */
async function loadSpillovers(month: string): Promise<Map<string, CalendarItem[]>> {
  const prevMonth = shiftMonthStr(month, -1);
  const prevDrafts = await db.drafts.where('target_month').equals(prevMonth).toArray();
  const result = new Map<string, CalendarItem[]>();
  if (prevDrafts.length === 0) return result;

  const byId = new Map<string, string>(); // draft_id → scenario name
  for (const d of prevDrafts) byId.set(d.id, d.name);

  const monthFirstMs = new Date(month + '-01T00:00:00Z').getTime();

  const rawItems = await db.items.where('draft_id').anyOf(prevDrafts.map(d => d.id)).toArray();
  const itemsByDraft = new Map<string, CalendarItem[]>();
  for (const it of rawItems) {
    const { draft_id, ...rest } = it as unknown as { draft_id: string } & CalendarItem;
    const arr = itemsByDraft.get(draft_id) ?? [];
    arr.push(rest as CalendarItem);
    itemsByDraft.set(draft_id, arr);
  }

  for (const [draftId, draftItems] of itemsByDraft) {
    const name = byId.get(draftId);
    if (!name) continue;

    const flights = draftItems.filter(i => i.kind === 'flight');
    const spilledFlights: CalendarItem[] = [];
    // ids des items M-1 (non-vol) à injecter comme pause-spillover.
    const pauseIds = new Set<string>();

    for (const flight of flights) {
      const startInM   = flight.start_date.slice(0, 7) >= month;
      if (startInM) continue;
      const endsBeforeM = flight.end_date.slice(0, 7) < month;
      const bodyCrosses = !endsBeforeM; // start < M && end >= M
      if (bodyCrosses) {
        spilledFlights.push({ ...flight, _isSpillover: true });
      } else {
        // Calcul du RPC max (chevauchement ON) contre tous les items du draft :
        // si la queue atteint M, on flag _rpcOnlySpillover.
        const eff = computeEffectiveRpc(flight, draftItems, true);
        if (eff.endMs >= monthFirstMs) {
          spilledFlights.push({ ...flight, _isSpillover: true, _rpcOnlySpillover: true });
        }
      }
    }

    // Pour chaque vol spillover (body ou RPC-only), on identifie les items
    // M-1 (hors vol) qui tombent dans sa fenêtre RPC étendue → pause-spillovers.
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

    const all = [...spilledFlights, ...pauseItems];
    if (all.length > 0) result.set(name, all);
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

/** Cache des rotations pour un mois.
 *
 *  Contraintes :
 *  (a) `raw_detail` = ~5 kB / sig × ~50 sigs / mois → payload conséquent. Un
 *      seul gros rw lock sur db.rotations bloque pendant plusieurs secondes
 *      les reads `toArray()` faits par `loadShellData` calendrier → page
 *      blanche "Chargement…" lors d'une nav profil → /.
 *  (b) Le combo "delete-all-then-put" laissait une fenêtre courte mais réelle
 *      où Dexie n'avait PLUS les anciens sigs et PAS ENCORE les nouveaux. Si
 *      l'utilisateur cliquait un sig pendant cette fenêtre, `loadEp4DetailLocal`
 *      retournait null → tableau champ/valeur limité à la première ligne.
 *
 *  Stratégie : upsert par batches (bulkPut atomique par row), puis cleanup
 *  des sigs orphelins (ids présents en Dexie mais pas dans la nouvelle liste)
 *  en fin. À tout moment, un read `get(id)` voit soit l'ancien sig, soit le
 *  nouveau, jamais "rien". */
const CACHE_ROTATIONS_CHUNK = 10;

export async function cacheRotations(sigs: RotationSignature[], month: string): Promise<void> {
  // Diag Eruda : combien de sigs reçus ont raw_detail. Si 0/N, c'est que la
  // server action `getRotationsForMonth` ne renvoie pas raw_detail (peut-être
  // build pas redéployé, ou stripping de Next.js sur grosse payload).
  const withRD = sigs.filter(s => !!s.raw_detail).length;
  console.warn(`[cacheRotations] ${month} : ${sigs.length} sigs, ${withRD} avec raw_detail`);
  if (sigs.length === 0) {
    await db.transaction('rw', db.rotations, async () => {
      await db.rotations.where('target_month').equals(month).delete();
    });
    return;
  }
  const stamped = sigs.map(s => ({ ...s, target_month: month }));
  const newIds = new Set(sigs.map(s => s.id));
  // Upsert par batches — chaque batch dans sa propre transaction pour libérer
  // le rw lock entre deux. Les reads peuvent s'intercaler proprement.
  for (let i = 0; i < stamped.length; i += CACHE_ROTATIONS_CHUNK) {
    const batch = stamped.slice(i, i + CACHE_ROTATIONS_CHUNK);
    await db.transaction('rw', db.rotations, async () => {
      await db.rotations.bulkPut(batch);
    });
  }
  // Cleanup : retire les sigs orphelins (anciens ids pour ce mois pas remplacés
  // par la nouvelle liste). Indispensable sinon des sigs zombies traînent.
  await db.transaction('rw', db.rotations, async () => {
    await db.rotations.where('target_month').equals(month)
      .filter(r => !newIds.has(r.id))
      .delete();
  });
}

export async function loadRotationsFromDB(month: string): Promise<RotationSignature[]> {
  const stored = await db.rotations.where('target_month').equals(month).toArray();
  return stored.map(({ target_month: _t, ...sig }) => sig as RotationSignature);
}

// ─── Cache taux_app (brackets AF — utilisé par EP4) ───────────────────────────

export async function cacheTauxApp(rows: TauxAppRow[]): Promise<void> {
  await db.transaction('rw', db.taux_app, async () => {
    await db.taux_app.clear();
    if (rows.length) await db.taux_app.bulkPut(rows.map(r => ({ ...r, key: tauxAppKey(r) })));
  });
}

export async function loadTauxAppLocal(): Promise<TauxAppRow[]> {
  const stored = await db.taux_app.toArray();
  return stored.map(({ key: _k, ...r }) => r as TauxAppRow);
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

/**
 * Remplace le cache local par les versions serveur, mais préserve les rows
 * pour lesquelles une op `save_profile_version` ou `delete_profile_version`
 * est encore en attente (sinon l'hydration online écraserait les éditions
 * offline avant qu'elles ne soient pushées). Même esprit que cacheA81Overrides.
 */
export async function cacheProfileVersions(versions: ProfileVersion[]): Promise<void> {
  await db.transaction('rw', db.profile_versions, db.sync_queue, async () => {
    // 2 reads en parallèle dans la même tx — Dexie autorise les promesses
    // concurrentes au sein d'une transaction.
    const [pending, existing] = await Promise.all([
      db.sync_queue.toArray(),
      db.profile_versions.toArray(),
    ]);
    const pendingSaves = new Set<string>();
    const pendingDeletes = new Set<string>();
    for (const op of pending) {
      if (op.op === 'save_profile_version') {
        try {
          const p = JSON.parse(op.payload) as { valid_from?: string };
          if (p.valid_from) pendingSaves.add(p.valid_from);
        } catch { /* skip */ }
      } else if (op.op === 'delete_profile_version') {
        try {
          const p = JSON.parse(op.payload) as { valid_from?: string };
          if (p.valid_from) pendingDeletes.add(p.valid_from);
        } catch { /* skip */ }
      }
    }
    const keptLocal = existing.filter(v => pendingSaves.has(v.valid_from));
    const fromServer = versions
      .filter(v => !pendingSaves.has(v.valid_from))   // override local-first
      .filter(v => !pendingDeletes.has(v.valid_from)); // pas de résurrection
    await db.profile_versions.clear();
    if (keptLocal.length || fromServer.length) {
      await db.profile_versions.bulkPut([...keptLocal, ...fromServer]);
    }
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

// ─── Cache overrides A81 ──────────────────────────────────────────────────────

/**
 * Remplace le cache local par les overrides serveur, mais préserve les rows
 * pour lesquelles une op est encore en attente de sync (sinon le passage
 * online écraserait les modifs offline avant qu'elles ne soient pushées).
 * Même esprit que hydrateDB pour les planning items.
 */
export async function cacheA81Overrides(overrides: A81OverrideLocal[]): Promise<void> {
  await db.transaction('rw', db.a81_overrides, db.sync_queue, async () => {
    const [pending, existing] = await Promise.all([
      db.sync_queue.toArray(),
      db.a81_overrides.toArray(),
    ]);
    const pendingInstIds = new Set<string>();
    for (const op of pending) {
      if (op.op === 'a81_upsert_override' || op.op === 'a81_delete' || op.op === 'a81_restore') {
        try {
          const p = JSON.parse(op.payload) as { pairing_instance_id?: string };
          if (p.pairing_instance_id) pendingInstIds.add(p.pairing_instance_id);
        } catch { /* skip op malformée */ }
      }
    }
    const keptLocal = existing.filter(o => pendingInstIds.has(o.pairing_instance_id));
    const fromServer = overrides.filter(o => !pendingInstIds.has(o.pairing_instance_id));
    await db.a81_overrides.clear();
    if (keptLocal.length || fromServer.length) {
      await db.a81_overrides.bulkPut([...keptLocal, ...fromServer]);
    }
  });
}

export async function loadA81OverridesLocal(): Promise<A81OverrideLocal[]> {
  return db.a81_overrides.toArray();
}

// ─── Cache année A81 (plafond exo brut) ───────────────────────────────────────

/** Préserve les années avec ops pending (même esprit que cacheA81Overrides). */
export async function cacheA81YearData(rows: A81YearDataLocal[]): Promise<void> {
  await db.transaction('rw', db.a81_year_data, db.sync_queue, async () => {
    const [pending, existing] = await Promise.all([
      db.sync_queue.toArray(),
      db.a81_year_data.toArray(),
    ]);
    const pendingYears = new Set<number>();
    for (const op of pending) {
      if (op.op === 'a81_save_plafond_exo') {
        try {
          const p = JSON.parse(op.payload) as { year?: number };
          if (p.year != null) pendingYears.add(p.year);
        } catch { /* skip */ }
      }
    }
    const keptLocal = existing.filter(r => pendingYears.has(r.year));
    const fromServer = rows.filter(r => !pendingYears.has(r.year));
    await db.a81_year_data.clear();
    if (keptLocal.length || fromServer.length) {
      await db.a81_year_data.bulkPut([...keptLocal, ...fromServer]);
    }
  });
}

export async function loadA81YearDataLocal(year: number): Promise<A81YearDataLocal | null> {
  return (await db.a81_year_data.get(year)) ?? null;
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
