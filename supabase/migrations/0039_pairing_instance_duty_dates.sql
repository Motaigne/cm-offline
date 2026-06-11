-- ============================================================
-- 0039_pairing_instance_duty_dates
-- Stocke scheduledBeginDutyDate / scheduledEndDutyDate par instance.
--
-- Sémantique CrewBidd (cf. optiP_CREWBIDD_V1.md L25+L28) :
--   beginDutyDate = début TSV au sens du Manex = briefing (~1h45 avant block-off)
--   endDutyDate   = fin TSV   au sens du Manex = closeout (~30min après block-on)
--
-- Pourquoi on en a besoin :
--   TA (= temps d'absence) = briefing → closeout. Jusqu'ici on dérivait depuis
--   les bornes block + constantes Manex (1h45 / 30min). Ces constantes sont
--   approximatives — les valeurs AF réelles peuvent varier (CC, instructeurs,
--   types de vol particuliers). Cette migration permet de stocker les valeurs
--   exactes par instance.
--
--   ATTENTION : `scheduled_*_activity_at` (mig 0021) ≠ briefing/closeout.
--   Ces colonnes stockent en fait `scheduledBeginActivityDate` =
--   « début du repos pré-courrier » (cf. V1 L31). Bug historique de naming —
--   on garde la colonne pour compat mais on ajoute les vraies DutyDate ici.
--
-- Backfill : depuis `raw_summary` (mig 0034) qui contient PairingSummary brute.
-- Les instances scrapées AVANT mig 0034 n'auront pas de raw_summary → NULL,
-- les consommateurs fallback aux constantes Manex via blocks.
-- ============================================================

alter table pairing_instance
  add column if not exists scheduled_begin_duty_at timestamptz,
  add column if not exists scheduled_end_duty_at   timestamptz;

-- Backfill depuis raw_summary.beginDutyDate / endDutyDate
update pairing_instance
set scheduled_begin_duty_at = to_timestamp((raw_summary->>'beginDutyDate')::bigint / 1000.0),
    scheduled_end_duty_at   = to_timestamp((raw_summary->>'endDutyDate')::bigint   / 1000.0)
where raw_summary is not null
  and raw_summary->>'beginDutyDate' is not null
  and raw_summary->>'endDutyDate'   is not null
  and (raw_summary->>'beginDutyDate')::bigint > 0
  and (raw_summary->>'endDutyDate')::bigint   > 0;
