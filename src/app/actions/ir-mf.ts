'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { computeIRandMF } from '@/lib/ep4';
import type { PairingDetail } from '@/lib/scraper/types';
import type { IrMfRate } from '@/lib/ir-rates';

export interface MonthlyIrMfTotal {
  ir: number;       // compte
  mf: number;
  ir_eur: number;
  mf_eur: number;
  /** Compte de flights ignorés (pas de raw_detail). */
  skipped: number;
}

export interface MonthlyIrMfResponse {
  byScenario: Record<'A' | 'B' | 'C', MonthlyIrMfTotal>;
  /** Escales pour lesquelles aucun taux n'a été trouvé (déduplique cross-scénarios). */
  missingRateEscales: string[];
}

const EMPTY_TOTAL: MonthlyIrMfTotal = { ir: 0, mf: 0, ir_eur: 0, mf_eur: 0, skipped: 0 };

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Résume les totaux IR + MF (compte + €) par scénario A/B/C pour le mois M.
 *  Inclut les vols à cheval venus du mois précédent (compte UNIQUEMENT pour la
 *  partie qui chevauche M, en proratant via temps_sej). */
export async function getMonthlyIrMfEuros(month: string): Promise<MonthlyIrMfResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const prevMonth = shiftMonth(month, -1);

  // 1. Drafts mois courant + précédent (pour spillovers)
  const { data: drafts } = await supabase
    .from('planning_draft')
    .select('id, name, target_month')
    .eq('user_id', user.id)
    .in('target_month', [`${month}-01`, `${prevMonth}-01`]);

  const empty: MonthlyIrMfResponse = {
    byScenario: { A: { ...EMPTY_TOTAL }, B: { ...EMPTY_TOTAL }, C: { ...EMPTY_TOTAL } },
    missingRateEscales: [],
  };
  if (!drafts?.length) return empty;

  const draftById = new Map(drafts.map(d => [d.id, d]));
  const draftIds = drafts.map(d => d.id);

  // 2. Flight items
  const { data: items } = await supabase
    .from('planning_item')
    .select('id, draft_id, start_date, end_date, pairing_instance_id')
    .in('draft_id', draftIds)
    .eq('kind', 'flight')
    .not('pairing_instance_id', 'is', null);

  if (!items?.length) return empty;

  const monthPrefix = month;
  const filteredItems = items.filter(it => {
    const d = draftById.get(it.draft_id);
    if (!d) return false;
    const draftMonth = (d.target_month as string).slice(0, 7);
    if (draftMonth === month) return true;
    return draftMonth === prevMonth && it.end_date.slice(0, 7) >= monthPrefix;
  });

  // 3. instances → signatures
  const instanceIds = [...new Set(filteredItems.map(it => it.pairing_instance_id as string))];
  const { data: instances } = await supabase
    .from('pairing_instance')
    .select('id, signature_id')
    .in('id', instanceIds);
  const instById = new Map((instances ?? []).map(i => [i.id, i]));

  const sigIds = [...new Set((instances ?? []).map(i => i.signature_id))];
  const { data: sigs } = await supabase
    .from('pairing_signature')
    .select('id, raw_detail')
    .in('id', sigIds);
  const sigById = new Map((sigs ?? []).map(s => [s.id, s]));

  // 4. ir_mf_rates depuis annexe
  const { data: irRow } = await supabase
    .from('annexe_table')
    .select('data')
    .eq('slug', 'ir_mf_rates')
    .single();
  const irRates = (irRow?.data ?? []) as unknown as IrMfRate[];

  // 5. Agrégat par scénario
  const result: MonthlyIrMfResponse = {
    byScenario: { A: { ...EMPTY_TOTAL }, B: { ...EMPTY_TOTAL }, C: { ...EMPTY_TOTAL } },
    missingRateEscales: [],
  };
  const missingSet = new Set<string>();

  for (const it of filteredItems) {
    const draft = draftById.get(it.draft_id);
    if (!draft) continue;
    const name = draft.name as 'A' | 'B' | 'C';
    if (name !== 'A' && name !== 'B' && name !== 'C') continue;

    const inst = instById.get(it.pairing_instance_id as string);
    if (!inst) continue;
    const sig = sigById.get(inst.signature_id);
    if (!sig?.raw_detail) {
      result.byScenario[name].skipped += 1;
      continue;
    }

    const irMf = computeIRandMF(sig.raw_detail as unknown as PairingDetail, irRates);
    result.byScenario[name].ir     += irMf.ir;
    result.byScenario[name].mf     += irMf.mf;
    result.byScenario[name].ir_eur += irMf.ir_eur;
    result.byScenario[name].mf_eur += irMf.mf_eur;
    irMf.missingRateEscales.forEach(e => missingSet.add(e));
  }

  // Round € aux 2 décimales
  for (const name of ['A','B','C'] as const) {
    result.byScenario[name].ir_eur = Math.round(result.byScenario[name].ir_eur * 100) / 100;
    result.byScenario[name].mf_eur = Math.round(result.byScenario[name].mf_eur * 100) / 100;
  }

  result.missingRateEscales = [...missingSet].sort();
  return result;
}
