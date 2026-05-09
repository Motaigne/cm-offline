-- ============================================================
-- 0007_profile_extras
-- Ajoute deux champs au profil utilisateur :
--   * tri_niveau : niveau d'instruction (1 à 5+) pour TRI OPL / TRI CDB,
--                  alimente la lookup `prime_instruction`
--   * prime_330  : opt-in à la prime A330 (table annexe `prime_incitation_330`)
-- ============================================================

alter table user_profile
  add column if not exists tri_niveau smallint,
  add column if not exists prime_330  boolean not null default false;
