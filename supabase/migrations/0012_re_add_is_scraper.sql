-- ============================================================
-- 0012_re_add_is_scraper
-- Réintroduit user_profile.is_scraper (annule en partie 0006).
-- Permet à un utilisateur non-admin d'alimenter la DB de vols.
--
-- Les policies des tables scrape_snapshot, pairing_signature et
-- pairing_instance acceptent désormais (is_admin OR is_scraper).
-- Les autres tables (taux_app, prorata_dda_off, annexe_table)
-- restent réservées à is_admin.
--
-- Une limite de 50 rotations max par run est enforcée APPLICATION-
-- SIDE (pas via RLS) — pour pouvoir afficher l'erreur clairement.
-- ============================================================

-- 1. Re-add column ------------------------------------------------------
alter table user_profile
  add column if not exists is_scraper boolean not null default false;

-- 2. Drop existing admin-only policies ----------------------------------
drop policy if exists "snapshot_write_admin"  on scrape_snapshot;
drop policy if exists "snapshot_update_admin" on scrape_snapshot;
drop policy if exists "sig_write_admin"       on pairing_signature;
drop policy if exists "inst_write_admin"      on pairing_instance;

-- 3. Recreate as (is_admin OR is_scraper) -------------------------------
create policy "snapshot_write_admin_or_scraper" on scrape_snapshot
  for insert with check (
    exists (select 1 from user_profile where user_id = auth.uid() and (is_admin or is_scraper))
  );

create policy "snapshot_update_admin_or_scraper" on scrape_snapshot
  for update using (
    exists (select 1 from user_profile where user_id = auth.uid() and (is_admin or is_scraper))
  );

create policy "sig_write_admin_or_scraper" on pairing_signature
  for all using (
    exists (select 1 from user_profile where user_id = auth.uid() and (is_admin or is_scraper))
  );

create policy "inst_write_admin_or_scraper" on pairing_instance
  for all using (
    exists (select 1 from user_profile where user_id = auth.uid() and (is_admin or is_scraper))
  );
