-- ============================================================
-- 0044_annexe_monthly_targets
-- Insère dans `annexe_table` (slug='monthly_targets') les cibles
-- mensuelles publiées par l'élabo sur Crew Mobile, par mois :
--   * eHS  = écart au seuil HS recherché, en intervalle [min ; max]
--   * HC   = heures créditées cibles pour un plein temps sans absence
--
-- Pourquoi : la cible cadre la paie « de base » du mois (l'élabo ajoute
-- un vol pour amener le pilote à la cible). Le score d'optimisation du
-- Gantt (panneau Détail) compare l'eHS réel du scénario à cette cible,
-- corrigée du régime et des absences (congés/TAF abaissent le seuil HS).
--
-- Les valeurs sont recopiées à la main depuis Crew Mobile (aucun scrape),
-- éditables via /annexe, et hydratées en Dexie comme le reste de
-- l'annexe (offline-first). Elles valent pour le profil actif
-- (fonction × avion du profil) — pas de dimension fonction/avion ici.
--
-- Seed : exemple connu (OPL A335, août 2026 : eHS [1 ; 11], HC 81).
-- ============================================================

insert into annexe_table (slug, name, description, data) values (
  'monthly_targets',
  'Cibles mensuelles élabo (eHS / HC)',
  'Cibles publiées sur Crew Mobile par mois : eHS = écart au seuil HS en intervalle [min ; max], HC = heures créditées cibles plein temps sans absence. Saisies à la main, pour le profil actif (fonction × avion). Utilisées par le score d''optimisation du Gantt.',
  '{
    "version": "2026-07-02",
    "targets": [
      { "month": "2026-08", "ehs_min": 1, "ehs_max": 11, "hc": 81 }
    ]
  }'::jsonb
)
on conflict do nothing;
