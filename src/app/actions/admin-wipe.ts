'use server';

import { createClient } from '@/lib/supabase/server';

export type WipeResult =
  | { error: string }
  | {
      deleted_snapshots: number;
      deleted_sigs: number;
      deleted_instances: number;
      unlinked_items: number;
      deleted_releases: number;
    };

/**
 * Wipe complet du snapshot d'un mois (snapshot + signatures + instances).
 * Admin only. Permet de re-scraper de zéro — utile pour profiter d'une
 * migration (mig 0033 split-par-durée, 0034 raw_summary, 0039 duty_at)
 * ou d'un changement de formule au niveau du scraper sur des données existantes.
 *
 * Délègue tout à la RPC `wipe_snapshots_for_month` (SECURITY DEFINER, mig
 * 0043). Indispensable : le nullify de planning_item.pairing_instance_id doit
 * toucher les items de TOUS les users, or la RLS planning_item est self-only —
 * sous le client user, les FK des autres users bloquaient le DELETE des
 * instances (bug « wipe app ne marche pas », workaround SQL Studio).
 * Le garde-fou admin est DANS la fonction SQL.
 *
 * Coût : 1 RPC. Le re-scrape qui suit refera ~N calls détails
 * (= nb sigs uniques) + 1 call pairingsearch.
 */
export async function wipeSnapshotForMonth(month: string): Promise<WipeResult> {
  if (!/^\d{4}-\d{2}$/.test(month)) return { error: 'Format mois invalide (YYYY-MM)' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Non authentifié' };

  const { data, error } = await supabase.rpc('wipe_snapshots_for_month', {
    p_target_month: `${month}-01`,
  });
  if (error) return { error: error.message };

  const r = data as {
    deleted_snapshots: number;
    deleted_sigs: number;
    deleted_instances: number;
    unlinked_items: number;
    deleted_releases: number;
  };
  return {
    deleted_snapshots: r?.deleted_snapshots ?? 0,
    deleted_sigs:      r?.deleted_sigs      ?? 0,
    deleted_instances: r?.deleted_instances ?? 0,
    unlinked_items:    r?.unlinked_items    ?? 0,
    deleted_releases:  r?.deleted_releases  ?? 0,
  };
}
