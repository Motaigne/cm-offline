-- ============================================================
-- 0013_ir_mf_patch
-- Ajoute les escales manquantes dans ir_mf_rates :
--   NBJ (Angola), PPT (Polynésie), LAX (États-Unis)
-- Méthode : retire les entrées existantes pour ces 3 codes
--           puis les réinsère avec les valeurs correctes.
-- ============================================================

update annexe_table
set data = (
  select jsonb_agg(elem)
  from (
    -- Garde toutes les entrées sauf celles qu'on va corriger/ajouter
    select elem
    from jsonb_array_elements(data) as elem
    where elem->>'escale' not in ('NBJ', 'PPT', 'LAX')
    union all
    -- Nouvelles / corrigées
    select * from jsonb_array_elements('[
      {"escale":"NBJ","country":"ANGOLA","currency":"USD","ir_eur":24.70,"mf_eur":4.94},
      {"escale":"PPT","country":"POLYNESIE TAHITI","currency":"XPF","ir_eur":52.73,"mf_eur":10.55},
      {"escale":"LAX","country":"ETATS UNIS","currency":"USD","ir_eur":44.71,"mf_eur":8.94}
    ]'::jsonb)
  ) t
)
where slug = 'ir_mf_rates';
