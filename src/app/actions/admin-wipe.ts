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

  // Instances à supprimer
  const { data: instsToDelete } = await supabase
    .from('pairing_instance')
    .select('id')
    .in('signature_id', sigIds);
  const instanceIds = (instsToDelete ?? []).map(i => i.id);

  // Nullify les refs planning_item.pairing_instance_id qui pointent sur ces
  // instances — sinon FK constraint planning_item_pairing_instance_id_fkey
  // bloque le DELETE. Les planning_items survivent (les vols utilisateur)
  // mais perdent leur lien. À ré-binder après re-scrape (par activity_id).
  // Batché par chunks de 200 pour éviter la limite URL Supabase REST (~8KB).
  const CHUNK = 200;
  for (let i = 0; i < instanceIds.length; i += CHUNK) {
    const chunk = instanceIds.slice(i, i + CHUNK);
    const { error: nullifyErr } = await supabase
      .from('planning_item')
      .update({ pairing_instance_id: null })
      .in('pairing_instance_id', chunk);
    if (nullifyErr) return { error: `Nullify planning_item refs (chunk ${i / CHUNK + 1}) : ${nullifyErr.message}` };
  }

  // DELETE en ordre dépendance : instances → sigs → snapshot.
  // Idem : batché par chunks de 200.
  let deletedInstances = 0;
  for (let i = 0; i < sigIds.length; i += CHUNK) {
    const chunk = sigIds.slice(i, i + CHUNK);
    const { count, error } = await supabase
      .from('pairing_instance')
      .delete({ count: 'exact' })
      .in('signature_id', chunk);
    if (error) return { error: `Suppression instances (chunk ${i / CHUNK + 1}) : ${error.message}` };
    deletedInstances += count ?? 0;
  }

  // Pour les sigs et snapshots, les listes sont petites (≤ qq centaines) → 1 call OK.
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
