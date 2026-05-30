-- ============================================================
-- 0028_annexe_valid_from
-- Versionne annexe_table par date d'application.
--   * Ajoute la colonne valid_from (default 2025-04-01).
--   * Remplace la PK (slug) par (slug, valid_from).
--   * Reseed v2025-04-01 et v2026-04-01 pour les 4 tableaux de
--     rémunération versionnés : taux_avion, prime_incitation,
--     traitement_base, prime_instruction.
--
-- Les autres slugs (article_81, prorata, ir_mf_rates, dda_rules,
-- vol_p_rules, cat_anciennete, coef_classe, prime_incitation_330,
-- zone_escales) restent estampillés 2025-04-01 sans changement.
--
-- Sémantique runtime : pour un mois cible M, on prend la row dont
-- valid_from <= M (1er du mois), la plus récente.
-- ============================================================

alter table annexe_table
  add column if not exists valid_from date not null default '2025-04-01';

alter table annexe_table
  drop constraint if exists annexe_table_pkey;

alter table annexe_table
  add primary key (slug, valid_from);

-- ── taux_avion ────────────────────────────────────────────────
insert into annexe_table (slug, valid_from, name, description, data) values (
  'taux_avion', '2025-04-01',
  'Taux horaire de base des primes de vol',
  'Taux horaire par type d''avion (élément de rémunération). Date d''application : 1er avril 2025.',
  '[
    {"avion":"A350","taux":101.36},
    {"avion":"A335","taux":103.39},
    {"avion":"B787","taux":99.95},
    {"avion":"B777","taux":104.49}
  ]'::jsonb
) on conflict (slug, valid_from) do update set
  name = excluded.name, description = excluded.description, data = excluded.data, updated_at = now();

insert into annexe_table (slug, valid_from, name, description, data) values (
  'taux_avion', '2026-04-01',
  'Taux horaire de base des primes de vol',
  'Taux horaire par type d''avion (élément de rémunération). Date d''application : 1er avril 2026.',
  '[
    {"avion":"A350","taux":102.37},
    {"avion":"A335","taux":104.42},
    {"avion":"B787","taux":100.95},
    {"avion":"B777","taux":105.53}
  ]'::jsonb
) on conflict (slug, valid_from) do update set
  name = excluded.name, description = excluded.description, data = excluded.data, updated_at = now();

-- ── prime_incitation ──────────────────────────────────────────
insert into annexe_table (slug, valid_from, name, description, data) values (
  'prime_incitation', '2025-04-01',
  'Prime d''incitation',
  'Prime d''incitation mensuelle par fonction × réseau. Date d''application : 1er avril 2025.',
  '[
    {"role":"CDB","type":"LC","montant":613.16},
    {"role":"CDB","type":"MC","montant":445.94},
    {"role":"OPL","type":"LC","montant":423.63},
    {"role":"OPL","type":"MC","montant":301.01}
  ]'::jsonb
) on conflict (slug, valid_from) do update set
  name = excluded.name, description = excluded.description, data = excluded.data, updated_at = now();

insert into annexe_table (slug, valid_from, name, description, data) values (
  'prime_incitation', '2026-04-01',
  'Prime d''incitation',
  'Prime d''incitation mensuelle par fonction × réseau. Date d''application : 1er avril 2026.',
  '[
    {"role":"CDB","type":"LC","montant":619.29},
    {"role":"CDB","type":"MC","montant":450.40},
    {"role":"OPL","type":"LC","montant":427.87},
    {"role":"OPL","type":"MC","montant":304.02}
  ]'::jsonb
) on conflict (slug, valid_from) do update set
  name = excluded.name, description = excluded.description, data = excluded.data, updated_at = now();

-- ── traitement_base ───────────────────────────────────────────
insert into annexe_table (slug, valid_from, name, description, data) values (
  'traitement_base', '2025-04-01',
  'Traitement mensuel fixe de référence',
  'Base CDB échelon 1 + coefficient OPL. Date d''application : 1er avril 2025.',
  '{"base_cdb_a1": 2559.19, "coef_opl": 0.665}'::jsonb
) on conflict (slug, valid_from) do update set
  name = excluded.name, description = excluded.description, data = excluded.data, updated_at = now();

insert into annexe_table (slug, valid_from, name, description, data) values (
  'traitement_base', '2026-04-01',
  'Traitement mensuel fixe de référence',
  'Base CDB échelon 1 + coefficient OPL. Date d''application : 1er avril 2026.',
  '{"base_cdb_a1": 2584.78, "coef_opl": 0.665}'::jsonb
) on conflict (slug, valid_from) do update set
  name = excluded.name, description = excluded.description, data = excluded.data, updated_at = now();

-- ── prime_instruction ─────────────────────────────────────────
insert into annexe_table (slug, valid_from, name, description, data) values (
  'prime_instruction', '2025-04-01',
  'Prime mensuelle d''instruction',
  'a1 (ICPL = TRI CDB) + b1 (TRI OPL) ; années 2..max_annee calculées (compound depuis valeur arrondie). Date d''application : 1er avril 2025.',
  '{"icpl_a1": 1582.97, "tri_opl_b1": 1266.22, "multiplier": 1.05, "max_annee": 5}'::jsonb
) on conflict (slug, valid_from) do update set
  name = excluded.name, description = excluded.description, data = excluded.data, updated_at = now();

insert into annexe_table (slug, valid_from, name, description, data) values (
  'prime_instruction', '2026-04-01',
  'Prime mensuelle d''instruction',
  'a1 (ICPL = TRI CDB) + b1 (TRI OPL) ; années 2..max_annee calculées (compound depuis valeur arrondie). Date d''application : 1er avril 2026.',
  '{"icpl_a1": 1598.80, "tri_opl_b1": 1278.88, "multiplier": 1.05, "max_annee": 5}'::jsonb
) on conflict (slug, valid_from) do update set
  name = excluded.name, description = excluded.description, data = excluded.data, updated_at = now();
