-- ============================================================
-- 0020_refresh_planning_item_rest_instance
-- Rafraîchit planning_item.meta.rest_*_h depuis pairing_instance (par-instance)
-- au lieu de pairing_signature (par-signature, imprécis).
--
-- À pousser APRÈS un Backfill RPC qui aura rempli pairing_instance.rest_*_h.
-- Si l'instance n'a pas encore de rest_*_h (NULL), on garde la valeur actuelle
-- de meta (coalesce) pour ne pas écraser ce que 0018 avait posé.
-- ============================================================

update planning_item pi
set meta = coalesce(pi.meta, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
  'rest_before_h', inst.rest_before_h,
  'rest_after_h',  inst.rest_after_h
))
from pairing_instance inst
where pi.pairing_instance_id = inst.id
  and pi.kind = 'flight'
  and (inst.rest_before_h is not null or inst.rest_after_h is not null);
