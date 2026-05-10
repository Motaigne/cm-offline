-- ============================================================
-- 0009_valeur_jour_a81
-- Ajoute valeur_jour au profil utilisateur — montant en euros par
-- jour utilisé dans le calcul de l'Article 81 (montantPrimeSej).
-- Défaut 600 € selon la spec instructions.md.
-- ============================================================

alter table user_profile
  add column if not exists valeur_jour numeric not null default 600;
