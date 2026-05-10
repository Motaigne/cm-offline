'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import type { PairingDetail } from '@/lib/scraper/types';
import type { Ep4Rotation, TauxAppRow } from '@/lib/ep4';
import { buildEp4Rotation } from '@/lib/ep4';

export type Ep4DetailResponse =
  | { raw_detail: PairingDetail; taux: TauxAppRow[] }
  | { error: string };

/** Charge le raw_detail JSONB d'une signature + la table taux_app pour
 *  alimenter buildEp4Rotation côté client. Auth user requis. */
export async function getEp4Detail(sigId: string): Promise<Ep4DetailResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Non authentifié' };

  const [{ data: sig, error: sigErr }, { data: taux, error: tauxErr }] = await Promise.all([
    supabase.from('pairing_signature').select('raw_detail').eq('id', sigId).single(),
    supabase.from('taux_app').select('rot_code, duree_min_h, duree_max_h, taux'),
  ]);

  if (sigErr || !sig)         return { error: sigErr?.message ?? 'Signature introuvable' };
  if (!sig.raw_detail)        return { error: 'raw_detail absent en DB pour cette signature' };
  if (tauxErr)                return { error: tauxErr.message };

  return {
    raw_detail: sig.raw_detail as unknown as PairingDetail,
    taux: (taux ?? []) as TauxAppRow[],
  };
}

// ─── Onglet EP4 (UI H) : tous les vols du planning du mois M ─────────────────

export type Ep4ScenarioFlight = {
  flight_item_id: string;
  start_date: string;
  end_date: string;
  is_spillover: boolean;
  ep4: Ep4Rotation;
};

export type Ep4MonthResponse = {
  scenarios: Array<{ name: 'A' | 'B' | 'C'; flights: Ep4ScenarioFlight[] }>;
};

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Charge tous les flights du planning A/B/C du mois M (incl. spillovers M-1)
 *  et renvoie pour chacun un Ep4Rotation pré-calculé. Lourd : N×raw_detail. */
export async function getEp4ForMonth(month: string): Promise<Ep4MonthResponse | { error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [y, m] = month.split('-').map(Number);
  const prevMonth = shiftMonth(month, -1);

  // 1. Drafts du mois courant + précédent (pour spillovers)
  const { data: drafts } = await supabase
    .from('planning_draft')
    .select('id, name, target_month')
    .eq('user_id', user.id)
    .in('target_month', [`${month}-01`, `${prevMonth}-01`]);

  if (!drafts?.length) {
    return { scenarios: [{ name: 'A', flights: [] }, { name: 'B', flights: [] }, { name: 'C', flights: [] }] };
  }

  const draftById = new Map(drafts.map(d => [d.id, d]));
  const draftIds = drafts.map(d => d.id);

  // 2. Flight items des drafts (kind=flight, pairing_instance_id non null)
  const { data: items } = await supabase
    .from('planning_item')
    .select('id, draft_id, start_date, end_date, pairing_instance_id')
    .in('draft_id', draftIds)
    .eq('kind', 'flight')
    .not('pairing_instance_id', 'is', null);

  if (!items?.length) {
    return { scenarios: [{ name: 'A', flights: [] }, { name: 'B', flights: [] }, { name: 'C', flights: [] }] };
  }

  // Pour les drafts du mois précédent : ne garder que les flights qui se prolongent dans M
  const monthPrefix = month;
  const filteredItems = items.filter(it => {
    const d = draftById.get(it.draft_id);
    if (!d) return false;
    const draftMonth = (d.target_month as string).slice(0, 7);
    if (draftMonth === month) return true;
    // Spillover : draft de M-1 ET end_date dans M ou plus tard
    return draftMonth === prevMonth && it.end_date.slice(0, 7) >= monthPrefix;
  });

  // 3. Récupère les pairing_instance pour mapper instance_id → signature_id
  const instanceIds = [...new Set(filteredItems.map(it => it.pairing_instance_id as string))];
  const { data: instances } = await supabase
    .from('pairing_instance')
    .select('id, signature_id, activity_id')
    .in('id', instanceIds);
  const instanceById = new Map((instances ?? []).map(i => [i.id, i]));

  // 4. Récupère les signatures avec raw_detail (dédupliqué)
  const sigIds = [...new Set((instances ?? []).map(i => i.signature_id))];
  const { data: sigs } = await supabase
    .from('pairing_signature')
    .select('id, rotation_code, zone, raw_detail')
    .in('id', sigIds);
  const sigById = new Map((sigs ?? []).map(s => [s.id, s]));

  // 5. Charge taux_app
  const { data: taux } = await supabase
    .from('taux_app')
    .select('rot_code, duree_min_h, duree_max_h, taux');
  const tauxRows = (taux ?? []) as TauxAppRow[];

  // 6. Construit la réponse — un Ep4Rotation par flight item
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

    const inst = instanceById.get(it.pairing_instance_id as string);
    if (!inst) continue;
    const sig = sigById.get(inst.signature_id);
    if (!sig?.raw_detail) continue;

    const ep4 = buildEp4Rotation(
      sig.raw_detail as unknown as PairingDetail,
      sig.rotation_code ?? '',
      sig.zone,
      y, m, tauxRows,
    );

    result.scenarios.find(s => s.name === scenarioName)!.flights.push({
      flight_item_id: it.id,
      start_date: it.start_date,
      end_date: it.end_date,
      is_spillover: (draft.target_month as string).slice(0, 7) === prevMonth,
      ep4,
    });
  }

  // Tri chrono par scenario
  for (const s of result.scenarios) {
    s.flights.sort((a, b) => a.start_date.localeCompare(b.start_date));
  }

  return result;
}

