-- ============================================================
-- 0008_prime_330_count
-- Remplace la colonne booléenne `prime_330` par `prime_330_count`
-- (smallint nullable). NULL = prime désactivée. Valeur attendue
-- 5, 7 ou 9 — correspond au seuil "<5 avions", "<7 avions",
-- "<9 avions" choisi dans le profil.
-- ============================================================

alter table user_profile
  drop column if exists prime_330;

alter table user_profile
  add column if not exists prime_330_count smallint;
