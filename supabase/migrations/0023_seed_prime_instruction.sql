-- ============================================================
-- 0023_seed_prime_instruction
-- Seed/refresh de la prime mensuelle d'instruction.
-- Stockage compact : seuls a1 (ICPL) et b1 (TRI_OPL) sont stockés.
-- Les années 2..max_annee sont calculées côté code (compound depuis
-- la valeur arrondie : année N = round(année N-1 × multiplier, 2)).
-- Au-delà de max_annee → valeur figée (= prime de max_annee).
-- Idempotent : upsert sur annexe_table.slug = 'prime_instruction'.
-- ============================================================

insert into annexe_table (slug, name, description, data) values (
  'prime_instruction',
  'Prime mensuelle d''instruction',
  'Prime mensuelle pour les instructeurs (ICPL = TRI CDB, TRI OPL). Seules les valeurs année 1 (a1, b1) sont stockées ; les années suivantes sont calculées par la formule année N = round(année N-1 × multiplier, 2).',
  '{
    "icpl_a1": 1598.80,
    "tri_opl_b1": 1278.88,
    "multiplier": 1.05,
    "max_annee": 5
  }'::jsonb
)
on conflict (slug) do update set
  name = excluded.name,
  description = excluded.description,
  data = excluded.data,
  updated_at = now();
