-- 0014_ensure_ir_mf_rates
-- Garantit que la ligne ir_mf_rates existe dans annexe_table.
-- Si la ligne manque (0011 non appliqué), on crée une ligne vide.
-- Si elle existe déjà, on ne touche pas à la data (do nothing).

insert into annexe_table (slug, name, description, data) values (
  'ir_mf_rates',
  'IR + MF — Tableau récapitulatif (€)',
  'Indemnités Repas + Menus Frais par escale, en euros. Importer via l''interface Annexe → Importer CSV.',
  '[]'::jsonb
)
on conflict (slug) do nothing;
