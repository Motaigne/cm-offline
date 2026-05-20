-- ============================================================
-- 0022_refresh_planning_item_activity
-- Rafraîchit planning_item.meta avec :
--   - rest_before_h / rest_after_h (depuis pairing_instance, source par-instance)
--   - scheduled_begin_activity_at / scheduled_end_activity_at (nouveaux,
--     pour calculer les barres pré/post du Gantt depuis les timestamps réels).
--
-- À pousser APRÈS un Backfill RPC qui aura rempli pairing_instance avec les
-- valeurs correctes (timestamps activity + rest_*_h calculé depuis ces timestamps).
-- ============================================================

update planning_item pi
set meta = coalesce(pi.meta, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
  'rest_before_h',                inst.rest_before_h,
  'rest_after_h',                 inst.rest_after_h,
  'scheduled_begin_activity_at',  inst.scheduled_begin_activity_at,
  'scheduled_end_activity_at',    inst.scheduled_end_activity_at
))
from pairing_instance inst
where pi.pairing_instance_id = inst.id
  and pi.kind = 'flight';
