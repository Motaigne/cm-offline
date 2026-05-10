-- ============================================================
-- 0010_tmi
-- Ajoute user_profile.tmi (Taux Marginal d'Imposition) — utilisé
-- pour calculs de défiscalisation (Article 81). Valeurs autorisées :
-- 0, 11, 30, 41, 45 (%). Défaut 41.
-- ============================================================

alter table user_profile
  add column if not exists tmi smallint not null default 41
  check (tmi in (0, 11, 30, 41, 45));
