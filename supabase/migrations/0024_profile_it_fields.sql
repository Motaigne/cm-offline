-- ============================================================
-- 0024_profile_it_fields
-- Ajoute les champs profil pour la prime d'Indemnité Transport (IT) :
--   * navigo_eur            — valeur mensuelle Navigo (défaut 81.40 €)
--   * voiture_km_aller      — distance aller en km (saisi par l'user)
--   * voiture_indemnite_km  — indemnité par km (défaut 0.3837 €)
-- Le mode est choisi via user_profile.transport ('Navigo' | 'Voiture').
-- Calcul effectué côté client (gantt-view) :
--   * Navigo  : IT = navigo_eur si ≥ 1 activité sur le mois, sinon 0.
--   * Voiture : IT = nbActivités × 2 × voiture_km_aller × voiture_indemnite_km
--               (vol à cheval = 0.5 activité par mois).
-- ============================================================

alter table user_profile
  add column if not exists navigo_eur            numeric default 81.40,
  add column if not exists voiture_km_aller      numeric,
  add column if not exists voiture_indemnite_km  numeric default 0.3837;
