// Équivalent client (lecture Dexie) de `getEp4ForMonth` / `getEp4Detail`.
// Permet à la page /ep4 et au panneau détail du /comparatif de tourner offline
// (raw_detail + taux_app pré-cachés en Dexie).
//
// Logique métier alignée mot-à-mot sur `src/app/actions/ep4.ts` :
//   - MANEX_BRIEF_MS / MANEX_CLOSE_MS pour fallback briefing/closeout
//   - scénario A/B/C, spillovers M-1 dont end_date ≥ M
//   - tri chrono par scenario

import { db, loadAnnexeRowsLocal, loadTauxAppLocal, loadRawDetailLocal } from '@/lib/local-db';
import { buildEp4Rotation, type PairingDetail, type TauxAppRow } from '@/lib/ep4';
import type { IrMfRate } from '@/lib/ir-rates';
import type { Ep4MonthResponse } from '@/app/actions/ep4';

const MANEX_BRIEF_MS = 1.75 * 3_600_000;
const MANEX_CLOSE_MS = 0.5  * 3_600_000;

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function pickIrRates(rows: Awaited<ReturnType<typeof loadAnnexeRowsLocal>>, month: string): IrMfRate[] {
  const cutoff = `${month}-01`;
  let best: { valid_from: string; data: unknown } | null = null;
  for (const r of rows) {
    if (r.slug !== 'ir_mf_rates') continue;
    if (r.valid_from > cutoff) continue;
    if (!best || r.valid_from > best.valid_from) best = r;
  }
  return (best?.data ?? []) as IrMfRate[];
}

/** Diagnostic d'un flight item exclu du résultat EP4 — sert à expliquer en UI
 *  pourquoi un vol présent au calendrier n'apparaît pas en EP4 offline.
 *  Reasons :
 *   - 'no-pairing'    : item.kind=flight mais pairing_instance_id NULL (vol
 *                       ajouté manuellement, jamais le cas online non plus)
 *   - 'no-draft'      : draft introuvable dans Dexie (cache désync)
 *   - 'no-instance'   : pairing_instance absent de db.rotations (sync rotations
 *                       incomplet ou instance supprimée serveur)
 *   - 'no-sig'        : signature absente — théoriquement impossible si l'inst
 *                       est trouvée (sig parent), gardé par défense
 *   - 'no-raw-detail' : sig OK mais raw_detail manquant en db.rotation_details
 *                       (pré-cache incomplet — typique cold offline) */
export type Ep4LocalSkip = {
  scenario: 'A' | 'B' | 'C' | '?';
  flightItemId: string;
  startDate: string;
  pairingInstanceId: string | null;
  rotationCode: string | null;
  reason: 'no-pairing' | 'no-draft' | 'no-instance' | 'no-sig' | 'no-raw-detail';
};

export type Ep4LocalResult = { data: Ep4MonthResponse; skipped: Ep4LocalSkip[] };

/** Charge tous les vols EP4 du mois (3 scenarios) depuis Dexie. Renvoie un
 *  Ep4MonthResponse identique à `getEp4ForMonth` + la liste des flights filtrés
 *  (skipped) pour debug UI. Null si Dexie n'a aucune signature avec `raw_detail`
 *  pour le mois (cache lite ancien ou pas encore rempli). */
export async function loadEp4ForMonthLocal(month: string): Promise<Ep4LocalResult | null> {
  const [y, m] = month.split('-').map(Number);
  const prevMonth = shiftMonth(month, -1);
  const skipped: Ep4LocalSkip[] = [];
  const emptyData: Ep4MonthResponse = {
    scenarios: [{ name: 'A', flights: [] }, { name: 'B', flights: [] }, { name: 'C', flights: [] }],
  };

  const drafts = await db.drafts
    .where('target_month').anyOf([month, prevMonth])
    .toArray();
  if (drafts.length === 0) {
    return { data: emptyData, skipped };
  }

  const draftById = new Map(drafts.map(d => [d.id, d]));
  const draftIds = drafts.map(d => d.id);

  const items = await db.items.where('draft_id').anyOf(draftIds).toArray();

  // Filtre 1 : kind=flight. Track les flights sans pairing_instance_id (skip
  // identique au serveur, mais on l'expose en UI pour diagnostic).
  const allFlights = items.filter(it => it.kind === 'flight');
  const flightItems: typeof allFlights = [];
  for (const it of allFlights) {
    if (!it.pairing_instance_id) {
      const draft = draftById.get(it.draft_id);
      skipped.push({
        scenario: (draft?.name as 'A' | 'B' | 'C') ?? '?',
        flightItemId: it.id,
        startDate: it.start_date,
        pairingInstanceId: null,
        rotationCode: null,
        reason: 'no-pairing',
      });
      continue;
    }
    flightItems.push(it);
  }
  if (flightItems.length === 0) {
    return { data: emptyData, skipped };
  }

  const filteredItems = flightItems.filter(it => {
    const d = draftById.get(it.draft_id);
    if (!d) return false;
    const draftMonth = d.target_month;
    if (draftMonth === month) return true;
    return draftMonth === prevMonth && it.end_date.slice(0, 7) >= month;
  });

  // Index sig + instance depuis toutes les rotations cachées en Dexie (light,
  // ~1 kB / sig — raw_detail est dans rotation_details, chargé à la demande).
  const allRotations = await db.rotations.toArray();
  type SigSubset = { id: string; rotation_code: string; zone: string | null };
  type InstSubset = { id: string; signature_id: string; depart_at: string | null; arrivee_at: string | null;
                      scheduled_begin_duty_at: string | null; scheduled_end_duty_at: string | null; };
  const sigById  = new Map<string, SigSubset>();
  // Map<pairing_instance_id, candidates[]> — une instance peut apparaître nestée
  // dans plusieurs sigs Dexie (cas où AF a re-scrapé et déplacé l'instance d'une
  // sig vers une autre : l'ancienne sig reste cachée avec la version stale, la
  // nouvelle est apportée par le rescue de getRotationsForMonth). On garde tous
  // les candidats et on choisit plus loin par proximité au start_date de l'item.
  const instCandidates = new Map<string, InstSubset[]>();
  for (const sig of allRotations) {
    sigById.set(sig.id, { id: sig.id, rotation_code: sig.rotation_code ?? '', zone: sig.zone ?? null });
    for (const inst of sig.instances) {
      const candidate: InstSubset = {
        id: inst.id,
        signature_id: sig.id,
        depart_at: inst.depart_at ?? null,
        arrivee_at: inst.arrivee_at ?? null,
        scheduled_begin_duty_at: inst.scheduled_begin_duty_at ?? null,
        scheduled_end_duty_at: inst.scheduled_end_duty_at ?? null,
      };
      const list = instCandidates.get(inst.id);
      if (list) list.push(candidate);
      else instCandidates.set(inst.id, [candidate]);
    }
  }
  /** Choisit le candidat dont `depart_at` est le plus proche de `it.start_date`.
   *  Sans depart_at → départage par index naturel (premier candidat). */
  const pickInstance = (instanceId: string, startDate: string): InstSubset | null => {
    const list = instCandidates.get(instanceId);
    if (!list || list.length === 0) return null;
    if (list.length === 1) return list[0];
    const targetMs = new Date(`${startDate}T00:00:00Z`).getTime();
    let best = list[0];
    let bestDelta = Infinity;
    for (const c of list) {
      if (!c.depart_at) continue;
      const delta = Math.abs(new Date(c.depart_at).getTime() - targetMs);
      if (delta < bestDelta) { best = c; bestDelta = delta; }
    }
    return best;
  };
  // Charge en bulk les raw_detail des sigs utilisés dans les flights filtrés.
  const neededSigIds = new Set<string>();
  for (const it of filteredItems) {
    const inst = pickInstance(it.pairing_instance_id as string, it.start_date);
    if (inst) neededSigIds.add(inst.signature_id);
  }
  const detailRows = await db.rotation_details.bulkGet([...neededSigIds]);
  const detailById = new Map<string, PairingDetail>();
  for (const row of detailRows) {
    if (row?.raw_detail) detailById.set(row.id, row.raw_detail as PairingDetail);
  }
  if (detailById.size === 0) return null;

  const annexeRows = await loadAnnexeRowsLocal();
  const tauxRows   = await loadTauxAppLocal();
  const irRates    = pickIrRates(annexeRows, month);

  const result: Ep4MonthResponse = {
    scenarios: [
      { name: 'A', flights: [] },
      { name: 'B', flights: [] },
      { name: 'C', flights: [] },
    ],
  };

  const trackSkip = (
    it: typeof filteredItems[number],
    reason: Ep4LocalSkip['reason'],
    rotationCode: string | null,
  ) => {
    const draft = draftById.get(it.draft_id);
    skipped.push({
      scenario: (draft?.name as 'A' | 'B' | 'C') ?? '?',
      flightItemId: it.id,
      startDate: it.start_date,
      pairingInstanceId: (it.pairing_instance_id as string | null) ?? null,
      rotationCode,
      reason,
    });
  };

  for (const it of filteredItems) {
    const draft = draftById.get(it.draft_id);
    if (!draft) { trackSkip(it, 'no-draft', null); continue; }
    const scenarioName = draft.name as 'A' | 'B' | 'C';
    if (scenarioName !== 'A' && scenarioName !== 'B' && scenarioName !== 'C') continue;

    const inst = pickInstance(it.pairing_instance_id as string, it.start_date);
    if (!inst) { trackSkip(it, 'no-instance', null); continue; }
    const sig = sigById.get(inst.signature_id);
    if (!sig) { trackSkip(it, 'no-sig', null); continue; }
    const rawDetail = detailById.get(sig.id);
    if (!rawDetail) { trackSkip(it, 'no-raw-detail', sig.rotation_code); continue; }

    const briefMs = inst.scheduled_begin_duty_at ? new Date(inst.scheduled_begin_duty_at).getTime()
                   : inst.depart_at  ? new Date(inst.depart_at).getTime()  - MANEX_BRIEF_MS : null;
    const closeMs = inst.scheduled_end_duty_at   ? new Date(inst.scheduled_end_duty_at).getTime()
                   : inst.arrivee_at ? new Date(inst.arrivee_at).getTime() + MANEX_CLOSE_MS : null;
    const blockOffMs = inst.depart_at  ? new Date(inst.depart_at).getTime()  : undefined;
    const blockOnMs  = inst.arrivee_at ? new Date(inst.arrivee_at).getTime() : undefined;
    const override = (briefMs != null && closeMs != null)
      ? { beginActivityMs: briefMs, endActivityMs: closeMs, beginBlockMs: blockOffMs, endBlockMs: blockOnMs }
      : undefined;

    const ep4 = buildEp4Rotation(
      rawDetail,
      sig.rotation_code,
      sig.zone,
      y, m, tauxRows, irRates, override,
    );

    result.scenarios.find(s => s.name === scenarioName)!.flights.push({
      flight_item_id: it.id,
      start_date: it.start_date,
      end_date: it.end_date,
      is_spillover: draft.target_month === prevMonth,
      ep4,
    });
  }

  for (const s of result.scenarios) {
    s.flights.sort((a, b) => a.start_date.localeCompare(b.start_date));
  }

  if (skipped.length > 0) {
    console.warn('[ep4-local] flights skipped', { month, count: skipped.length, items: skipped });
  }

  // DEBUG TEMP : dump structure drafts+items pour identifier les drafts stale
  // qui causent l'italique fantôme (item HND draft de mai apparait en spillover
  // alors que le serveur l'a deja deplace vers juin). À retirer une fois fixé.
  const dumpDrafts = drafts.map(d => ({ id: d.id.slice(0, 8), name: d.name, tm: d.target_month }));
  const dumpItemsByDraft = drafts.map(d => {
    const dItems = items.filter(it => it.draft_id === d.id && it.kind === 'flight').map(it => ({
      id: it.id.slice(0, 8),
      sd: it.start_date,
      ed: it.end_date,
      inst: it.pairing_instance_id?.slice(0, 8) ?? null,
    }));
    return { draft: `${d.name}@${d.target_month}`, flights: dItems };
  });
  console.warn('[ep4-local DIAG] ' + JSON.stringify({ month, drafts: dumpDrafts, itemsByDraft: dumpItemsByDraft }));

  return { data: result, skipped };
}

/** Charge raw_detail + taux_app + irRates pour une signature donnée depuis
 *  Dexie. Mirroir client de `getEp4Detail` (utilisé par le panneau détail du
 *  /comparatif). Retourne soit la data, soit un objet `{ reason }` taggué qui
 *  permet à l'UI d'afficher un message précis.
 *
 *  Note : taux_app peut être vide (la table n'est pas seedée en prod côté
 *  serveur — getEp4Detail retourne aussi taux=[] dans ce cas). buildEp4Rotation
 *  fonctionne avec un taux vide (les calculs principaux n'en dépendent pas) ;
 *  on ne bloque donc pas si taux est vide. */
export type Ep4DetailLocalFail =
  | { reason: 'sig-absent' }
  | { reason: 'raw-detail-absent' };

export type Ep4DetailLocalResult =
  | { raw_detail: PairingDetail; taux: TauxAppRow[]; irRates: IrMfRate[] }
  | Ep4DetailLocalFail;

export async function loadEp4DetailLocal(sigId: string): Promise<Ep4DetailLocalResult> {
  const [sig, rawDetail, annexeRows, taux] = await Promise.all([
    db.rotations.get(sigId),
    loadRawDetailLocal(sigId),
    loadAnnexeRowsLocal(),
    loadTauxAppLocal(),
  ]);
  if (!sig) { console.warn('[ep4-local] sig absent en Dexie', sigId); return { reason: 'sig-absent' }; }
  if (!rawDetail) { console.warn('[ep4-local] raw_detail manquant pour sig', sigId, sig.rotation_code); return { reason: 'raw-detail-absent' }; }
  // ir_mf_rates : pas de contexte mois ici — on prend la version la plus récente.
  const latestIr = annexeRows
    .filter(r => r.slug === 'ir_mf_rates')
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0];
  return {
    raw_detail: rawDetail as PairingDetail,
    taux:       taux as TauxAppRow[],
    irRates:    ((latestIr?.data ?? []) as IrMfRate[]),
  };
}
