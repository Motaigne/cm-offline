-- ============================================================
-- 0021_pairing_instance_activity_dates
-- Stocke les timestamps de début et fin d'activité par instance.
-- Permet de calculer rest_after_h = end_activity - end_block en client
-- (les champs restPostHaulDuration des endpoints AF sont incohérents).
--
-- Backfill : NULL pour les instances existantes. À ré-alimenter via le
-- bouton "Backfill RPC" admin qui inclura ces colonnes.
-- ============================================================

alter table pairing_instance
  add column if not exists scheduled_begin_activity_at timestamptz,
  add column if not exists scheduled_end_activity_at   timestamptz;
