'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { computeTSej24 } from '@/lib/article81';

export interface YearA81Cumul {
  /** Somme tSej24 par scénario, AVANT le mois donné (Jan → mois-1). */
  byScenarioBefore: Record<'A' | 'B' | 'C', number>;
}

/** Calcule le cumulJours (tSej24 sommé) par scénario A/B/C pour les
 *  rotations placées dans les mois Jan→mois-1 de l'année donnée.
 *  Utilisé pour appliquer le plafond annuel Article 81 dans le calendrier. */
export async function getYearA81CumulBefore(year: number, month: number): Promise<YearA81Cumul> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const yearStart = `${year}-01-01`;
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;

  // 1. Drafts du user pour les mois Jan..month-1
  const { data: drafts } = await supabase
    .from('planning_draft')
    .select('id, name, target_month')
    .eq('user_id', user.id)
    .gte('target_month', yearStart)
    .lt('target_month', monthStart);

  const empty: YearA81Cumul = { byScenarioBefore: { A: 0, B: 0, C: 0 } };
  if (!drafts?.length) return empty;

  const draftById = new Map(drafts.map(d => [d.id, d]));
  const draftIds = drafts.map(d => d.id);

  // 2. Flight items (kind=flight) avec pairing_instance_id non null
  const { data: items } = await supabase
    .from('planning_item')
    .select('draft_id, pairing_instance_id')
    .in('draft_id', draftIds)
    .eq('kind', 'flight')
    .not('pairing_instance_id', 'is', null);

  if (!items?.length) return empty;

  // 3. pairing_instance → signature_id
  const instIds = [...new Set(items.map(it => it.pairing_instance_id as string))];
  const { data: instances } = await supabase
    .from('pairing_instance')
    .select('id, signature_id')
    .in('id', instIds);
  const instById = new Map((instances ?? []).map(i => [i.id, i]));

  // 4. signature → temps_sej
  const sigIds = [...new Set((instances ?? []).map(i => i.signature_id))];
  const { data: sigs } = await supabase
    .from('pairing_signature')
    .select('id, temps_sej')
    .in('id', sigIds);
  const sigTSejById = new Map((sigs ?? []).map(s => [s.id, Number(s.temps_sej ?? 0)]));

  // 5. Somme tSej24 par scénario
  const result: YearA81Cumul = { byScenarioBefore: { A: 0, B: 0, C: 0 } };
  for (const it of items) {
    const draft = draftById.get(it.draft_id);
    if (!draft) continue;
    const name = draft.name as 'A' | 'B' | 'C';
    if (name !== 'A' && name !== 'B' && name !== 'C') continue;

    const inst = instById.get(it.pairing_instance_id as string);
    if (!inst) continue;
    const tSej = sigTSejById.get(inst.signature_id);
    if (tSej == null) continue;

    result.byScenarioBefore[name] += computeTSej24(tSej);
  }

  return result;
}
