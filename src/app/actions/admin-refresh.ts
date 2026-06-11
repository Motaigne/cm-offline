'use server';

import { createClient } from '@/lib/supabase/server';
import { fetchAllPairings } from '@/lib/scraper/crewbidd';

export type RefreshResult =
  | { error: string }
  | { updated_instances: number; updated_duty_dates: number; total_summaries: number; matched_sigs: number };

/**
 * Refresh `pairing_instance.raw_summary` + `scheduled_begin/end_duty_at`
 * pour toutes les instances d'un mois, depuis un nouveau fetch
 * `pairingsearch` CrewBidd.
 *
 * Cas d'usage : récupérer le payload complet (_raw) sur des instances
 * scrapées avant que crewbidd.ts capture _raw, sans devoir wipe + re-scrape
 * (qui re-fetcherait tous les détails, coûteux en quota).
 *
 * NB : ne touche PAS à pairing_signature.raw_detail ni aux champs dérivés
 * stockés sur la signature (hc, hcr_crew, tsv_nuit, temps_sej, prime...).
 * Pour rafraîchir ceux-ci il faut un re-scrape complet.
 */
export async function refreshRawSummaryForMonth(
  month: string,
  cookie: string,
  sn: string,
  userId: string,
): Promise<RefreshResult> {
  if (!/^\d{4}-\d{2}$/.test(month)) return { error: 'Format mois invalide (YYYY-MM)' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Non authentifié' };

  const { data: profile } = await supabase
    .from('user_profile').select('is_admin').eq('user_id', user.id).single();
  if (!profile?.is_admin) return { error: 'Admin requis' };

  // Snapshot du mois (le plus récent en success)
  const { data: snap } = await supabase
    .from('scrape_snapshot')
    .select('id')
    .eq('target_month', `${month}-01`)
    .eq('status', 'success')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!snap) return { error: 'Aucun snapshot success pour ce mois' };

  // Fresh pairingsearch
  const summaries = await fetchAllPairings(month, { cookie, sn, userId });

  // Sigs du snapshot
  const { data: sigs } = await supabase
    .from('pairing_signature')
    .select('id')
    .eq('snapshot_id', snap.id);
  const sigIds = (sigs ?? []).map(s => s.id);
  if (sigIds.length === 0) return { error: 'Aucune signature pour ce snapshot' };

  // Toutes les instances de ces sigs, indexées par activity_id
  const { data: insts } = await supabase
    .from('pairing_instance')
    .select('id, activity_id, signature_id')
    .in('signature_id', sigIds);
  const instIdByActId = new Map<string, string>();
  const matchedSigs   = new Set<string>();
  for (const i of (insts ?? [])) {
    instIdByActId.set(String(i.activity_id), i.id);
  }

  // Update par instance (séquentiel pour éviter de surcharger Supabase REST)
  let updatedInst = 0;
  let updatedDuty = 0;
  for (const summary of summaries) {
    const instId = instIdByActId.get(String(summary.actId));
    if (!instId) continue;
    matchedSigs.add(instId);

    const beginDuty = summary.beginDutyDate;
    const endDuty   = summary.endDutyDate;

    const beginDutyIso = beginDuty > 0 ? new Date(beginDuty).toISOString() : null;
    const endDutyIso   = endDuty   > 0 ? new Date(endDuty).toISOString()   : null;
    if (beginDutyIso) updatedDuty++;

    const { error } = await supabase.from('pairing_instance').update({
      raw_summary:             (summary._raw ?? summary) as never,
      scheduled_begin_duty_at: beginDutyIso,
      scheduled_end_duty_at:   endDutyIso,
    }).eq('id', instId);
    if (!error) updatedInst++;
  }

  return {
    updated_instances: updatedInst,
    updated_duty_dates: updatedDuty,
    total_summaries: summaries.length,
    matched_sigs: matchedSigs.size,
  };
}
