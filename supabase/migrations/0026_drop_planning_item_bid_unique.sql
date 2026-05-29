-- ============================================================
-- 0026_drop_planning_item_bid_unique
-- Supprime la contrainte unique (draft_id, bid_category) sur planning_item.
--
-- Contexte : le champ bid_category a été détourné de sa sémantique initiale
-- (« 1 DDA par mois, 1 Vol P par mois, 1 DDA OFF par mois ») pour devenir
-- une simple CATÉGORIE attachée à chaque vol (DDA Vol / Vol P / Élabo-Suivi).
-- Cf. session 20260522 (commit 559cde5) + migration 0025.
--
-- Conséquence du bug : en mode offline puis sync, l'insertion de 2 vols
-- avec le même bid_category dans le même scénario échouait silencieusement
-- (côté server action) avec "duplicate key value violates unique constraint".
-- L'op était ensuite supprimée de la queue → vol perdu côté local au prochain
-- hydrateDB.
-- ============================================================

drop index if exists planning_item_one_bid_per_draft_idx;
