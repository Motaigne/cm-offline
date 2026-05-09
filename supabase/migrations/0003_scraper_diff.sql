-- ============================================================
-- 0003_scraper_diff
-- Pipeline scrape additif :
--   Le scrape ne re-télécharge plus tout — il ne récupère que les
--   rotations (activityNumber CrewBidd) absentes du snapshot du mois.
--
-- Ce qu'on ajoute :
--   * pairing_signature.activity_number : identifiant CrewBidd qui groupe
--     les instances datées d'une même rotation. Permet la diff fiable
--     "déjà en DB" vs "à télécharger".
--   * index unique partiel (snapshot_id, activity_number) : empêche les
--     doublons à l'insertion. Partiel pour tolérer les anciennes lignes
--     pour lesquelles le champ n'a pas été rempli.
--
-- Stratégie pour les lignes pré-existantes :
--   activity_number reste NULL. Le pipeline applique un fallback dual-check
--   sur pairing_instance.activity_id pour ne pas re-télécharger ce qui est
--   déjà là, et il "répare" la ligne (UPDATE activity_number) au passage.
-- ============================================================

alter table pairing_signature
  add column if not exists activity_number text;

create unique index if not exists pairing_signature_snap_actnum_idx
  on pairing_signature (snapshot_id, activity_number)
  where activity_number is not null;

create index if not exists pairing_signature_actnum_idx
  on pairing_signature (activity_number);
