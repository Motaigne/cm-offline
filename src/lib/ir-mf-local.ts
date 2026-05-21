// Agrégation IR/MF client-side depuis le cache rotations IndexedDB.
// Permet de rafraîchir IR/MF offline et à chaque ajout/suppression d'item
// sans aller-retour serveur. Les valeurs ir_eur/mf_eur par signature sont
// pré-calculées au scrape (cf. getRotationsForMonth).

import { db } from './local-db';
import type { Scenario } from '@/app/page';

export interface MonthlyIrMfTotal {
  ir: number;
  mf: number;
  ir_eur: number;
  mf_eur: number;
  /** Items flight sans correspondance dans le cache rotations. */
  skipped: number;
}

export interface IrMfPerFlight {
  instance_id: string;
  destination: string;
  ir_eur: number;
  mf_eur: number;
}

export interface MonthlyIrMfResult {
  byScenario: Record<'A' | 'B' | 'C', MonthlyIrMfTotal>;
  perFlightByScenario: Record<'A' | 'B' | 'C', IrMfPerFlight[]>;
}

function emptyTotal(): MonthlyIrMfTotal {
  return { ir: 0, mf: 0, ir_eur: 0, mf_eur: 0, skipped: 0 };
}

function shiftMonthStr(m: string, delta: number): string {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Ratio (0..1) de la rotation qui tombe dans le mois M (proration spillover). */
function monthRatio(departAt: string, arriveeAt: string, month: string): number {
  const [y, mo] = month.split('-').map(Number);
  const monthStart = Date.UTC(y, mo - 1, 1);
  const monthEnd   = Date.UTC(y, mo,     1);
  const dep = new Date(departAt).getTime();
  const arr = new Date(arriveeAt).getTime();
  if (arr <= dep) return 1;
  return Math.max(0, (Math.min(arr, monthEnd) - Math.max(dep, monthStart)) / (arr - dep));
}

/** Agrégation IR/MF locale : iter sur les items.flight, lookup par
 *  pairing_instance_id dans le cache rotations (mois M + M-1 pour spillovers). */
export async function computeMonthlyIrMfFromLocalCache(
  scenarios: Scenario[],
  month: string,
): Promise<MonthlyIrMfResult> {
  const prevMonth = shiftMonthStr(month, -1);
  const cached = await db.rotations
    .where('target_month').anyOf([month, prevMonth]).toArray();

  // Map<instance_id, { sig info + depart_at/arrivee_at pour proration }>
  type Entry = {
    ir: number; mf: number; ir_eur: number; mf_eur: number;
    destination: string; depart_at: string; arrivee_at: string;
  };
  const byInstance = new Map<string, Entry>();
  for (const sig of cached) {
    for (const inst of sig.instances ?? []) {
      byInstance.set(inst.id, {
        ir:          sig.ir     ?? 0,
        mf:          sig.mf     ?? 0,
        ir_eur:      sig.ir_eur ?? 0,
        mf_eur:      sig.mf_eur ?? 0,
        destination: sig.rotation_code,
        depart_at:   inst.depart_at,
        arrivee_at:  inst.arrivee_at,
      });
    }
  }

  const result: MonthlyIrMfResult = {
    byScenario:          { A: emptyTotal(), B: emptyTotal(), C: emptyTotal() },
    perFlightByScenario: { A: [], B: [], C: [] },
  };

  for (const scn of scenarios) {
    const name = scn.name;
    if (name !== 'A' && name !== 'B' && name !== 'C') continue;
    for (const item of scn.items) {
      if (item.kind !== 'flight') continue;
      if (!item.pairing_instance_id) continue;
      const entry = byInstance.get(item.pairing_instance_id);
      if (!entry) {
        // Pas trouvé dans cache (rotation pas encore syncée) — skip plutôt
        // que d'afficher 0 sans signal.
        result.byScenario[name].skipped += 1;
        continue;
      }
      const ratio = monthRatio(entry.depart_at, entry.arrivee_at, month);
      const irEur = entry.ir_eur * ratio;
      const mfEur = entry.mf_eur * ratio;
      result.byScenario[name].ir     += entry.ir * ratio;
      result.byScenario[name].mf     += entry.mf * ratio;
      result.byScenario[name].ir_eur += irEur;
      result.byScenario[name].mf_eur += mfEur;
      result.perFlightByScenario[name].push({
        instance_id: item.pairing_instance_id,
        destination: entry.destination,
        ir_eur: Math.round(irEur * 100) / 100,
        mf_eur: Math.round(mfEur * 100) / 100,
      });
    }
  }

  for (const k of ['A', 'B', 'C'] as const) {
    result.byScenario[k].ir_eur = Math.round(result.byScenario[k].ir_eur * 100) / 100;
    result.byScenario[k].mf_eur = Math.round(result.byScenario[k].mf_eur * 100) / 100;
  }

  return result;
}
