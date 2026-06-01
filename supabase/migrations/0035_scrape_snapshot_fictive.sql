-- 0035 — Snapshots fictifs (projection sur mois non encore déployés)
--
-- Un admin peut matérialiser des snapshots fictifs pour des mois futurs (les
-- rotations M sont déployées par AF le 25 de M-3). Permet aux utilisateurs de
-- se projeter sur l'année entière côté calendrier + A81.
--
-- Conventions :
--   - is_fictive = true : snapshot synthétique, exclu de catalogue/comparatif
--     par défaut, et exclu du sync Lite (opt-in via Perso).
--   - Quand un VRAI snapshot arrive pour le même target_month, le fictif est
--     supprimé via cleanup_fictive_snapshots_for_month, qui efface aussi les
--     planning_item pointant sur les instances effacées (cross-user → fonction
--     SECURITY DEFINER, sinon les RLS planning_item bloquent).

alter table scrape_snapshot
  add column is_fictive boolean not null default false;

create index scrape_snapshot_fictive_idx
  on scrape_snapshot (target_month)
  where is_fictive = true;

-- DELETE policy : nécessaire pour idempotence (regen écrase fictif existant)
-- et pour la fonction de cleanup. Admin ou scraper uniquement.
create policy "snapshot_delete_admin_or_scraper" on scrape_snapshot
  for delete using (
    exists (select 1 from user_profile where user_id = auth.uid() and (is_admin or is_scraper))
  );

-- Fonction de cleanup appelée :
--   1) Avant chaque scrape (route /api/scrape) : nuke tout fictif sur le mois.
--   2) Idempotence dans le générateur (regen écrase l'existant).
-- SECURITY DEFINER pour pouvoir supprimer des planning_item d'autres users
-- (RLS planning_item = self-only) sans exposer un service_role côté serveur.
create or replace function cleanup_fictive_snapshots_for_month(p_target_month date)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snap_count int;
begin
  -- Garde-fou : SECURITY DEFINER bypass RLS, donc on vérifie le rôle ici.
  if not exists (
    select 1 from user_profile
    where user_id = auth.uid() and (is_admin or is_scraper)
  ) then
    raise exception 'Forbidden: admin or scraper required';
  end if;

  -- 1) Effacer les planning_item de TOUS les users qui pointent vers les
  --    instances des snapshots fictifs sur ce mois (cascade ne suffit pas :
  --    pas de ON DELETE CASCADE sur planning_item.pairing_instance_id).
  delete from planning_item
  where pairing_instance_id in (
    select pi.id
    from pairing_instance pi
    join pairing_signature ps on ps.id = pi.signature_id
    join scrape_snapshot ss on ss.id = ps.snapshot_id
    where ss.target_month = p_target_month
      and ss.is_fictive = true
  );

  -- 2) Effacer les snapshots fictifs (cascade ON DELETE → sigs + instances).
  delete from scrape_snapshot
  where target_month = p_target_month
    and is_fictive = true;
  get diagnostics v_snap_count = row_count;

  return v_snap_count;
end;
$$;

grant execute on function cleanup_fictive_snapshots_for_month(date) to authenticated;
