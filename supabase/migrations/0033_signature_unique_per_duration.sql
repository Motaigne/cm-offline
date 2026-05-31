-- ============================================================
-- 0033_signature_unique_per_duration
-- Permettre plusieurs signatures par activity_number, une par durée.
--
-- Contexte : CrewBidd réutilise le même `activity_number` pour des rotations
-- de durées calendaires différentes (cas JFK : un activityNumber recouvre des
-- 4ON, 5ON et 6ON). L'unique index (snapshot_id, activity_number) interdisait
-- d'avoir une signature distincte par durée, ce qui forçait à fusionner les
-- instances hétérogènes sous une seule signature et faussait l'affichage.
--
-- Ce qu'on fait :
--   * Drop de l'unique sur (snapshot_id, activity_number).
--   * Création d'un unique sur (snapshot_id, activity_number, nb_on_days) :
--     le scraper peut maintenant insérer une signature par durée réelle, et
--     chaque combinaison reste unique au sein d'un snapshot.
--
-- Les signatures pré-existantes (avec mix d'instances) ne sont pas migrées.
-- Le filet `getRotationsForMonth` (commit 80c458e) scinde déjà à l'affichage.
-- Un wipe + re-scrape les remplace par des rows propres.
-- ============================================================

drop index if exists pairing_signature_snap_actnum_idx;

create unique index pairing_signature_snap_actnum_dur_idx
  on pairing_signature (snapshot_id, activity_number, nb_on_days);
