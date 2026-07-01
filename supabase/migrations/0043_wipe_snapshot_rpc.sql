-- ============================================================
-- 0043_wipe_snapshot_rpc
-- Fixe le bouton « Wipe » admin (ROADMAP 🔴, cassé depuis ~2026-06-11).
--
-- Cause racine : wipeSnapshotForMonth (server action) tournait sous le client
-- RLS de l'admin. Le nullify de planning_item.pairing_instance_id ne touchait
-- que les lignes DE L'ADMIN (RLS planning_item = self-only) ; les items des
-- autres users gardaient leur FK vers pairing_instance → le DELETE échouait
-- en contrainte planning_item_pairing_instance_id_fkey. Workaround jusqu'ici :
-- SQL Studio (bypass RLS).
--
-- Fix : RPC SECURITY DEFINER (même pattern que
-- cleanup_fictive_snapshots_for_month, 0035) — garde-fou admin DANS la
-- fonction puisque SECURITY DEFINER bypasse RLS.
--
-- Sémantique du wipe (alignée sur l'ancienne server action + contraintes FK) :
--   1) planning_item.pairing_instance_id → null, TOUS users. Les vols posés
--      survivent (ré-binding par activity_id après re-scrape) — on ne DELETE
--      pas comme le cleanup fictif.
--   2) monthly_release du mois supprimées (FK snapshot_id ON DELETE RESTRICT
--      bloquerait sinon ; un wipe = re-scrape de zéro, une release pointant
--      sur des données effacées n'a plus de sens). release_download cascade.
--   3) scrape_snapshot du mois supprimés (tous statuts) — cascade → sigs →
--      instances → user_a81_override.
-- ============================================================

create or replace function wipe_snapshots_for_month(p_target_month date)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snapshots      int;
  v_sigs           int;
  v_instances      int;
  v_items_unlinked int;
  v_releases       int;
begin
  -- Garde-fou : SECURITY DEFINER bypasse RLS, on vérifie le rôle ici.
  if not exists (
    select 1 from user_profile
    where user_id = auth.uid() and is_admin
  ) then
    raise exception 'Forbidden: admin required';
  end if;

  -- Compteurs AVANT suppression (les cascades ne remontent pas de row_count).
  select count(*) into v_snapshots
  from scrape_snapshot where target_month = p_target_month;

  select count(*) into v_sigs
  from pairing_signature ps
  join scrape_snapshot ss on ss.id = ps.snapshot_id
  where ss.target_month = p_target_month;

  select count(*) into v_instances
  from pairing_instance pi
  join pairing_signature ps on ps.id = pi.signature_id
  join scrape_snapshot ss on ss.id = ps.snapshot_id
  where ss.target_month = p_target_month;

  -- 1) Détache les vols utilisateur (tous users) des instances à supprimer.
  update planning_item
  set pairing_instance_id = null
  where pairing_instance_id in (
    select pi.id
    from pairing_instance pi
    join pairing_signature ps on ps.id = pi.signature_id
    join scrape_snapshot ss on ss.id = ps.snapshot_id
    where ss.target_month = p_target_month
  );
  get diagnostics v_items_unlinked = row_count;

  -- 2) Releases publiées sur ce mois (FK RESTRICT vers scrape_snapshot).
  delete from monthly_release
  where target_month = p_target_month;
  get diagnostics v_releases = row_count;

  -- 3) Snapshots (tous statuts) — cascade sigs + instances + a81 overrides.
  delete from scrape_snapshot
  where target_month = p_target_month;

  return json_build_object(
    'deleted_snapshots', v_snapshots,
    'deleted_sigs',      v_sigs,
    'deleted_instances', v_instances,
    'unlinked_items',    v_items_unlinked,
    'deleted_releases',  v_releases
  );
end;
$$;

grant execute on function wipe_snapshots_for_month(date) to authenticated;
