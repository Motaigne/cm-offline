-- ============================================================
-- 0034_pairing_instance_raw_summary
-- Police d'assurance : on stocke le PairingSummary brut de l'endpoint
-- CrewBidd `pairingsearch` sur chaque pairing_instance.
--
-- Pourquoi : aujourd'hui le scraper extrait des champs (depart_at, rest_*,
-- activity_id…) et les écrit en colonnes, mais le payload brut est jeté.
-- Si un bug d'exploitation apparaît ou si on découvre un nouveau champ utile,
-- il faut re-scraper CrewBidd. Avec raw_summary stocké, on peut ré-exécuter
-- la logique de dérivation hors-ligne sur les données existantes (un script
-- ou un endpoint admin), sans re-frapper CrewBidd ni risquer de wipe.
--
-- Coût : quelques KB de JSONB par instance. Le snapshot export-snapshot
-- l'embarque automatiquement (select *), donc la police est complète.
-- ============================================================

alter table pairing_instance
  add column if not exists raw_summary jsonb;
