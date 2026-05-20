-- ============================================================
-- 0017_activity_kinds_sim_autre
-- Ajoute les valeurs 'sim' (Simulateur) et 'autre' (Autre) à l'enum
-- activity_kind. Permet de saisir ces activités via le sheet "Ajouter".
--
-- Contribution PV (côté client) :
--   - sim   = 5 HCr / jour
--   - autre = 4 HCr / jour (groupé avec sol + medical)
-- ============================================================

alter type activity_kind add value if not exists 'sim';
alter type activity_kind add value if not exists 'autre';
