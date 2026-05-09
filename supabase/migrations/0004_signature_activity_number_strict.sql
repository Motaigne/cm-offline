-- ============================================================
-- 0004_signature_activity_number_strict
-- Verrou anti-doublons sur pairing_signature.
--
-- Pré-requis : toutes les lignes pairing_signature doivent avoir
-- activity_number rempli (re-scrape complet effectué après 0003).
-- À vérifier avant d'appliquer :
--   select count(*) from pairing_signature where activity_number is null;
--   -- doit retourner 0
--
-- Ce qu'on fait :
--   * Rend activity_number NOT NULL : garantit que toute insertion future
--     porte l'identifiant CrewBidd.
--   * Remplace l'index unique partiel par un index unique strict :
--     deux signatures du même snapshot ne peuvent plus partager le même
--     activity_number, peu importe le contexte d'insertion.
-- ============================================================

alter table pairing_signature
  alter column activity_number set not null;

drop index if exists pairing_signature_snap_actnum_idx;

create unique index pairing_signature_snap_actnum_idx
  on pairing_signature (snapshot_id, activity_number);
