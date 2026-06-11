'use server';

import { createClient } from '@/lib/supabase/server';

export type WipeResult =
  | { error: string }
  | { deleted_snapshots: number; deleted_sigs: number; deleted_instances: number };

/**
 * Wipe complet du snapshot d'un mois (snapshot + signatures + instances).
 * Admin only. Permet de re-scraper de zéro — utile pour profiter d'une
 * migration (mig 0033 split-par-durée, 0034 raw_summary, 0039 duty_at)
 * ou d'un changement de formule au niveau du scraper sur des données existantes.
 *
 * Coût : 1 transaction DB. Le re-scrape qui suit refera ~N calls détails
 * (= nb sigs uniques) + 1 call pairingsearch.
 */
export async function wipeSnapshotForMonth(month: string): Promise<WipeResult> {
  if (!/^\d{4}-\d{2}$/.test(month)) return { error: 'Format mois invalide (YYYY-MM)' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Non authentifié' };

  const { data: profile } = await supabase
    .from('user_profile').select('is_admin').eq('user_id', user.id).single();
  if (!profile?.is_admin) return { error: 'Admin requis' };

  // Tous les snapshots du mois (success, error, etc. — on wipe tout)
  const { data: snapshots } = await supabase
    .from('scrape_snapshot')
    .select('id')
    .eq('target_month', `${month}-01`);

  if (!snapshots?.length) {
    return { deleted_snapshots: 0, deleted_sigs: 0, deleted_instances: 0 };
  }
  const snapshotIds = snapshots.map(s => s.id);

  // Sigs des snapshots
  const { data: sigs } = await supabase
    .from('pairing_signature')
    .select('id')
    .in('snapshot_id', snapshotIds);
  const sigIds = (sigs ?? []).map(s => s.id);

  // DELETE en ordre dépendance : instances → sigs → snapshot.
  // Si les FK ont ON DELETE CASCADE c'est redondant, mais explicit > implicit.
  let deletedInstances = 0;
  if (sigIds.length > 0) {
    const { count, error } = await supabase
      .from('pairing_instance')
      .delete({ count: 'exact' })
      .in('signature_id', sigIds);
    if (error) return { error: `Suppression instances : ${error.message}` };
    deletedInstances = count ?? 0;
  }

  const { count: sigCount, error: sigErr } = await supabase
    .from('pairing_signature')
    .delete({ count: 'exact' })
    .in('snapshot_id', snapshotIds);
  if (sigErr) return { error: `Suppression sigs : ${sigErr.message}` };

  const { count: snapCount, error: snapErr } = await supabase
    .from('scrape_snapshot')
    .delete({ count: 'exact' })
    .in('id', snapshotIds);
  if (snapErr) return { error: `Suppression snapshots : ${snapErr.message}` };

  return {
    deleted_snapshots: snapCount ?? 0,
    deleted_sigs:      sigCount  ?? 0,
    deleted_instances: deletedInstances,
  };
}
