// Équivalent client (lecture Dexie) des 12 appels serveur que faisait
// `src/app/page.tsx` (Server Component). Permet au shell `/` d'être totalement
// précachable et de démarrer sans aucun call réseau.
//
// Les data sont aggregées localement à partir de :
//   - drafts/items + notes (Dexie : déjà à jour via sync_queue)
//   - annexe_rows + profile_versions (cachés)
//   - rotations (cachées) → derive irMfByScenario, a81CumulBefore, fictiveMonths
//   - a81_overrides + a81_year_data (cachés)

import { db, loadScenariosForMonth, loadNotesForMonth, loadAnnexeRowsLocal, loadProfileVersionsLocal } from '@/lib/local-db';
import { getAnnexeDataFromRows, type AnnexeData, type AnnexeRow } from '@/lib/annexe';
import { computeTSej24, TAXI_TSEJ_ADJUST_H, type Article81Data } from '@/lib/article81';
import type { Scenario } from '@/app/page';
import type { UserNote } from '@/app/actions/notes';
import type { ProfileVersion } from '@/app/actions/profile-version';
import type {
  MonthlyIrMfTotal, IrMfPerFlight, MonthlyIrMfResponse,
} from '@/app/actions/ir-mf';

const EMPTY_TOTAL: MonthlyIrMfTotal = { ir: 0, mf: 0, ir_eur: 0, mf_eur: 0, skipped: 0 };

type ProrataThreshold = {
  range: string;
  ji_restants: number;
  duree_min: number;
  duree_min_opt6: number;
};

export interface ShellData {
  scenarios:        Scenario[];
  notes:            UserNote[];
  annexeRows:       AnnexeRow[];
  annexe:           Partial<AnnexeData>;
  profileVersions:  ProfileVersion[];
  /** Profil applicable au mois M (la version la plus récente avec valid_from <= M-01).
   *  Null si aucune version saisie — le shell redirige alors vers /profil online. */
  profile:          ProfileVersion | null;
  article81Data:    Article81Data | null;
  prorataThresholds: ProrataThreshold[];
  ddaRulesData:     { rules: unknown[] } | null;
  volPRulesData:    { rules: unknown[] } | null;
  a81CumulBefore:   Record<'A' | 'B' | 'C', number>;
  irMfByScenario:   Record<'A' | 'B' | 'C', MonthlyIrMfTotal>;
  irMfPerFlightByScenario: Record<'A' | 'B' | 'C', IrMfPerFlight[]>;
  fictiveMonths:    string[];
}

function monthStart(month: string): string {
  return /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : month;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthRatio(departAt: string, arriveeAt: string, month: string): number {
  const [y, mo] = month.split('-').map(Number);
  const monthStartMs = Date.UTC(y, mo - 1, 1);
  const monthEndMs   = Date.UTC(y, mo,     1);
  const dep = new Date(departAt).getTime();
  const arr = new Date(arriveeAt).getTime();
  if (arr <= dep) return 1;
  return Math.max(0, (Math.min(arr, monthEndMs) - Math.max(dep, monthStartMs)) / (arr - dep));
}

/** Sélectionne la row annexe d'un slug applicable au mois (la plus récente
 *  avec valid_from <= 1er du mois). Mirroir client de `loadAnnexeRowForMonth`. */
function pickAnnexeRow(rows: AnnexeRow[], slug: string, month: string): unknown | null {
  const cutoff = monthStart(month);
  let best: AnnexeRow | null = null;
  for (const r of rows) {
    if (r.slug !== slug) continue;
    if (r.valid_from > cutoff) continue;
    if (!best || r.valid_from > best.valid_from) best = r;
  }
  return best?.data ?? null;
}

/** Sélectionne la version du profil applicable au mois. */
function pickProfileForMonth(versions: ProfileVersion[], month: string): ProfileVersion | null {
  const cutoff = monthStart(month);
  let best: ProfileVersion | null = null;
  for (const v of versions) {
    if (v.valid_from > cutoff) continue;
    if (!best || v.valid_from > best.valid_from) best = v;
  }
  return best;
}

/** Calcule le cumul tSej24 par scénario A/B/C pour les rotations placées
 *  dans Jan→mois-1 de l'année. Mirroir client de `getYearA81CumulBefore`. */
async function buildA81CumulBefore(year: number, month: number): Promise<Record<'A' | 'B' | 'C', number>> {
  const result: Record<'A' | 'B' | 'C', number> = { A: 0, B: 0, C: 0 };

  const yearPrefix = String(year);
  const monthFirst = `${year}-${String(month).padStart(2, '0')}-01`;

  // Drafts du user pour Jan→mois-1 de l'année courante.
  const drafts = await db.drafts
    .where('target_month').between(`${yearPrefix}-01`, monthFirst.slice(0, 7), true, false)
    .toArray();
  if (drafts.length === 0) return result;

  const draftById = new Map(drafts.map(d => [d.id, d]));
  const draftIds = drafts.map(d => d.id);

  const items = await db.items.where('draft_id').anyOf(draftIds).toArray();
  const flights = items.filter(it => it.kind === 'flight' && it.pairing_instance_id);
  if (flights.length === 0) return result;

  // Index signature : on charge TOUTES les rotations (Dexie est petite, ~quelques
  // milliers de signatures max). On cherche par instance_id.
  const allRotations = await db.rotations.toArray();
  const sigByInstId = new Map<string, { temps_sej: number }>();
  for (const sig of allRotations) {
    for (const inst of sig.instances) {
      sigByInstId.set(inst.id, { temps_sej: sig.temps_sej });
    }
  }

  for (const it of flights) {
    const draft = draftById.get(it.draft_id);
    if (!draft) continue;
    const name = draft.name as 'A' | 'B' | 'C';
    if (name !== 'A' && name !== 'B' && name !== 'C') continue;
    const sig = sigByInstId.get(it.pairing_instance_id as string);
    if (!sig) continue;
    result[name] += computeTSej24(sig.temps_sej + TAXI_TSEJ_ADJUST_H);
  }
  return result;
}

/** Construit `irMfByScenario` + `irMfPerFlightByScenario` pour le mois M.
 *  Mirroir client de `getMonthlyIrMfEuros`. Utilise ir_eur/mf_eur pré-calculés
 *  sur la signature au scrape (pas besoin de recomputer côté client). */
async function buildIrMfForMonth(month: string): Promise<Pick<MonthlyIrMfResponse, 'byScenario' | 'perFlightByScenario'>> {
  const prevMonth = shiftMonth(month, -1);
  const result = {
    byScenario:          { A: { ...EMPTY_TOTAL }, B: { ...EMPTY_TOTAL }, C: { ...EMPTY_TOTAL } },
    perFlightByScenario: { A: [], B: [], C: [] } as Record<'A' | 'B' | 'C', IrMfPerFlight[]>,
  };

  const drafts = await db.drafts
    .where('target_month').anyOf([month, prevMonth])
    .toArray();
  if (drafts.length === 0) return result;

  const draftById = new Map(drafts.map(d => [d.id, d]));
  const draftIds = drafts.map(d => d.id);

  const items = await db.items.where('draft_id').anyOf(draftIds).toArray();
  const flightItems = items.filter(it => it.kind === 'flight' && it.pairing_instance_id);

  // Filtre comme la version serveur : items du mois M OU items du mois M-1
  // dont end_date >= mois M (= vols à cheval).
  const filteredItems = flightItems.filter(it => {
    const d = draftById.get(it.draft_id);
    if (!d) return false;
    const draftMonth = d.target_month;
    if (draftMonth === month) return true;
    return draftMonth === prevMonth && it.end_date.slice(0, 7) >= month;
  });
  if (filteredItems.length === 0) return result;

  // Index signature + instance pour les instance_id concernées.
  const allRotations = await db.rotations.toArray();
  type SigSubset = { id: string; rotation_code: string; ir_eur: number; mf_eur: number; ir: number; mf: number; };
  type InstSubset = { id: string; depart_at: string | null; arrivee_at: string | null; signature_id: string; };
  const instById = new Map<string, InstSubset>();
  const sigById  = new Map<string, SigSubset>();
  for (const sig of allRotations) {
    sigById.set(sig.id, {
      id:            sig.id,
      rotation_code: sig.rotation_code,
      ir_eur:        sig.ir_eur,
      mf_eur:        sig.mf_eur,
      ir:            sig.ir,
      mf:            sig.mf,
    });
    for (const inst of sig.instances) {
      instById.set(inst.id, {
        id:           inst.id,
        depart_at:    inst.depart_at ?? null,
        arrivee_at:   inst.arrivee_at ?? null,
        signature_id: sig.id,
      });
    }
  }

  for (const it of filteredItems) {
    const draft = draftById.get(it.draft_id);
    if (!draft) continue;
    const name = draft.name as 'A' | 'B' | 'C';
    if (name !== 'A' && name !== 'B' && name !== 'C') continue;

    const inst = instById.get(it.pairing_instance_id as string);
    if (!inst) continue;
    const sig = sigById.get(inst.signature_id);
    if (!sig) { result.byScenario[name].skipped += 1; continue; }

    const ratio = (inst.depart_at && inst.arrivee_at)
      ? monthRatio(inst.depart_at, inst.arrivee_at, month)
      : 1;
    const irEur = sig.ir_eur * ratio;
    const mfEur = sig.mf_eur * ratio;
    result.byScenario[name].ir     += sig.ir * ratio;
    result.byScenario[name].mf     += sig.mf * ratio;
    result.byScenario[name].ir_eur += irEur;
    result.byScenario[name].mf_eur += mfEur;
    result.perFlightByScenario[name].push({
      instance_id: inst.id,
      destination: sig.rotation_code ?? '?',
      ir_eur:      Math.round(irEur * 100) / 100,
      mf_eur:      Math.round(mfEur * 100) / 100,
    });
  }

  for (const name of ['A', 'B', 'C'] as const) {
    result.byScenario[name].ir_eur = Math.round(result.byScenario[name].ir_eur * 100) / 100;
    result.byScenario[name].mf_eur = Math.round(result.byScenario[name].mf_eur * 100) / 100;
  }
  return result;
}

/** Liste des mois (YYYY-MM) qui contiennent au moins une rotation fictive
 *  (projection admin). Dérive de rotations.is_fictive. */
async function buildFictiveMonths(): Promise<string[]> {
  const all = await db.rotations.toArray();
  const months = new Set<string>();
  for (const sig of all) {
    if (sig.is_fictive) months.add(sig.target_month.slice(0, 7));
  }
  return [...months].sort();
}

/** Point d'entrée unique : lit Dexie et reconstitue toutes les props que
 *  l'ancien Server Component passait à GanttView. Pas de réseau. */
export async function loadShellData(month: string): Promise<ShellData> {
  const [y, mo] = month.split('-').map(Number);
  // Instrumentation temporaire : log la duree de chaque sub-fetch pour
  // identifier le bottleneck du chargement online (cf debug user 2026-06-17).
  // A retirer une fois la cause comprise.
  const t0 = performance.now();
  const lap = (label: string) => console.warn(`[shell] ${label} ${Math.round(performance.now() - t0)}ms`);
  const [scenarios, notes, annexeRows, profileVersions, a81CumulBefore, irMf, fictiveMonths] = await Promise.all([
    loadScenariosForMonth(month).then(s => { lap('scenarios');       return s ?? []; }),
    loadNotesForMonth(month).then(n =>      { lap('notes');           return n; }),
    loadAnnexeRowsLocal().then(a =>         { lap('annexeRows');      return a; }),
    loadProfileVersionsLocal().then(p =>    { lap('profileVersions'); return p; }),
    buildA81CumulBefore(y, mo).then(a =>    { lap('a81CumulBefore');  return a; }),
    buildIrMfForMonth(month).then(i =>      { lap('irMf');            return i; }),
    buildFictiveMonths().then(f =>          { lap('fictiveMonths');   return f; }),
  ]);
  lap('TOTAL Promise.all');

  const annexe = getAnnexeDataFromRows(annexeRows, month);
  const profile = pickProfileForMonth(profileVersions, month);

  const article81Data    = pickAnnexeRow(annexeRows, 'article_81', month) as Article81Data | null;
  const prorataRowData   = pickAnnexeRow(annexeRows, 'prorata',    month) as { thresholds: ProrataThreshold[] } | null;
  const ddaRulesData     = pickAnnexeRow(annexeRows, 'dda_rules',  month) as { rules: unknown[] } | null;
  const volPRulesData    = pickAnnexeRow(annexeRows, 'vol_p_rules',month) as { rules: unknown[] } | null;

  return {
    scenarios,
    notes,
    annexeRows,
    annexe,
    profileVersions,
    profile,
    article81Data,
    prorataThresholds: prorataRowData?.thresholds ?? [],
    ddaRulesData,
    volPRulesData,
    a81CumulBefore,
    irMfByScenario:          irMf.byScenario,
    irMfPerFlightByScenario: irMf.perFlightByScenario,
    fictiveMonths,
  };
}
