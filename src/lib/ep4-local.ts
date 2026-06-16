// Équivalent client (lecture Dexie) de `getEp4ForMonth` / `getEp4Detail`.
// Permet à la page /ep4 et au panneau détail du /comparatif de tourner offline
// (raw_detail + taux_app pré-cachés en Dexie).
//
// Logique métier alignée mot-à-mot sur `src/app/actions/ep4.ts` :
//   - MANEX_BRIEF_MS / MANEX_CLOSE_MS pour fallback briefing/closeout
//   - scénario A/B/C, spillovers M-1 dont end_date ≥ M
//   - tri chrono par scenario

import { db, loadAnnexeRowsLocal, loadTauxAppLocal } from '@/lib/local-db';
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

/** Charge tous les vols EP4 du mois (3 scenarios) depuis Dexie. Renvoie un
 *  Ep4MonthResponse identique à `getEp4ForMonth`. Null si Dexie n'a aucune
 *  signature avec `raw_detail` pour le mois (cache lite ancien ou pas encore
 *  rempli). */
export async function loadEp4ForMonthLocal(month: string): Promise<Ep4MonthResponse | null> {
  const [y, m] = month.split('-').map(Number);
  const prevMonth = shiftMonth(month, -1);

  const drafts = await db.drafts
    .where('target_month').anyOf([month, prevMonth])
    .toArray();
  if (drafts.length === 0) {
    return { scenarios: [{ name: 'A', flights: [] }, { name: 'B', flights: [] }, { name: 'C', flights: [] }] };
  }

  const draftById = new Map(drafts.map(d => [d.id, d]));
  const draftIds = drafts.map(d => d.id);

  const items = await db.items.where('draft_id').anyOf(draftIds).toArray();
  const flightItems = items.filter(it => it.kind === 'flight' && it.pairing_instance_id);
  if (flightItems.length === 0) {
    return { scenarios: [{ name: 'A', flights: [] }, { name: 'B', flights: [] }, { name: 'C', flights: [] }] };
  }

  const filteredItems = flightItems.filter(it => {
    const d = draftById.get(it.draft_id);
    if (!d) return false;
    const draftMonth = d.target_month;
    if (draftMonth === month) return true;
    return draftMonth === prevMonth && it.end_date.slice(0, 7) >= month;
  });

  // Index sig + instance depuis toutes les rotations cachées en Dexie.
  const allRotations = await db.rotations.toArray();
  type SigSubset = { id: string; rotation_code: string; zone: string | null; raw_detail: PairingDetail | null };
  type InstSubset = { id: string; signature_id: string; depart_at: string | null; arrivee_at: string | null;
                      scheduled_begin_duty_at: string | null; scheduled_end_duty_at: string | null; };
  const sigById  = new Map<string, SigSubset>();
  const instById = new Map<string, InstSubset>();
  let anyRawDetail = false;
  for (const sig of allRotations) {
    const rd = (sig.raw_detail ?? null) as PairingDetail | null;
    if (rd) anyRawDetail = true;
    sigById.set(sig.id, { id: sig.id, rotation_code: sig.rotation_code ?? '', zone: sig.zone ?? null, raw_detail: rd });
    for (const inst of sig.instances) {
      instById.set(inst.id, {
        id: inst.id,
        signature_id: sig.id,
        depart_at: inst.depart_at ?? null,
        arrivee_at: inst.arrivee_at ?? null,
        scheduled_begin_duty_at: inst.scheduled_begin_duty_at ?? null,
        scheduled_end_duty_at: inst.scheduled_end_duty_at ?? null,
      });
    }
  }
  if (!anyRawDetail) return null;

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

  for (const it of filteredItems) {
    const draft = draftById.get(it.draft_id);
    if (!draft) continue;
    const scenarioName = draft.name as 'A' | 'B' | 'C';
    if (scenarioName !== 'A' && scenarioName !== 'B' && scenarioName !== 'C') continue;

    const inst = instById.get(it.pairing_instance_id as string);
    if (!inst) continue;
    const sig = sigById.get(inst.signature_id);
    if (!sig?.raw_detail) continue;

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
      sig.raw_detail,
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

  return result;
}

/** Charge raw_detail + taux_app + irRates pour une signature donnée depuis
 *  Dexie. Mirroir client de `getEp4Detail` (utilisé par le panneau détail du
 *  /comparatif). Retourne soit la data, soit un objet `{ reason }` taggué qui
 *  permet à l'UI d'afficher un message précis (sig manquante / raw_detail
 *  manquant / taux_app vide). */
export type Ep4DetailLocalFail =
  | { reason: 'sig-absent' }
  | { reason: 'raw-detail-absent' }
  | { reason: 'taux-app-empty' };

export type Ep4DetailLocalResult =
  | { raw_detail: PairingDetail; taux: TauxAppRow[]; irRates: IrMfRate[] }
  | Ep4DetailLocalFail;

export async function loadEp4DetailLocal(sigId: string): Promise<Ep4DetailLocalResult> {
  const sig = await db.rotations.get(sigId);
  if (!sig) { console.warn('[ep4-local] sig absent en Dexie', sigId); return { reason: 'sig-absent' }; }
  if (!sig.raw_detail) { console.warn('[ep4-local] raw_detail manquant pour sig', sigId, sig.rotation_code); return { reason: 'raw-detail-absent' }; }
  const [annexeRows, taux] = await Promise.all([
    loadAnnexeRowsLocal(),
    loadTauxAppLocal(),
  ]);
  if (taux.length === 0) { console.warn('[ep4-local] taux_app vide en Dexie'); return { reason: 'taux-app-empty' }; }
  // ir_mf_rates : pas de contexte mois ici — on prend la version la plus récente.
  const latestIr = annexeRows
    .filter(r => r.slug === 'ir_mf_rates')
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0];
  return {
    raw_detail: sig.raw_detail as PairingDetail,
    taux:       taux as TauxAppRow[],
    irRates:    ((latestIr?.data ?? []) as IrMfRate[]),
  };
}
