-- ============================================================
-- 0006_drop_is_scraper
-- Unification du concept de privilège : `is_admin` devient le seul
-- flag qui donne le droit d'écrire dans les tables de scraping.
--
-- Étapes :
--   1. Drop les 6 policies qui gatent sur `is_scraper`
--   2. Recrée les mêmes policies en gatant sur `is_admin`
--   3. Drop la colonne `user_profile.is_scraper`
--
-- Pré-requis : tous les comptes qui avaient besoin de scraper ont déjà
-- `is_admin = true` (sinon l'écriture sera bloquée après cette migration).
-- ============================================================

-- 1. Drop des policies existantes ----------------------------------------
drop policy if exists "snapshot_write_scraper"  on scrape_snapshot;
drop policy if exists "snapshot_update_scraper" on scrape_snapshot;
drop policy if exists "sig_write_scraper"       on pairing_signature;
drop policy if exists "inst_write_scraper"      on pairing_instance;
drop policy if exists "taux_write_scraper"      on taux_app;
drop policy if exists "prorata_write_scraper"   on prorata_dda_off;
-- annexe_table : policy créée hors-migration via Studio
drop policy if exists "scraper write annexe"    on annexe_table;

-- 2. Recréation sur is_admin ---------------------------------------------
create policy "snapshot_write_admin" on scrape_snapshot
  for insert with check (
    exists (select 1 from user_profile where user_id = auth.uid() and is_admin)
  );

create policy "snapshot_update_admin" on scrape_snapshot
  for update using (
    exists (select 1 from user_profile where user_id = auth.uid() and is_admin)
  );

create policy "sig_write_admin" on pairing_signature
  for all using (
    exists (select 1 from user_profile where user_id = auth.uid() and is_admin)
  );

create policy "inst_write_admin" on pairing_instance
  for all using (
    exists (select 1 from user_profile where user_id = auth.uid() and is_admin)
  );

create policy "taux_write_admin" on taux_app
  for all using (
    exists (select 1 from user_profile where user_id = auth.uid() and is_admin)
  );

create policy "prorata_write_admin" on prorata_dda_off
  for all using (
    exists (select 1 from user_profile where user_id = auth.uid() and is_admin)
  );

create policy "annexe_write_admin" on annexe_table
  for all using (
    exists (select 1 from user_profile where user_id = auth.uid() and is_admin)
  );

-- 3. Suppression de la colonne -------------------------------------------
alter table user_profile drop column if exists is_scraper;
