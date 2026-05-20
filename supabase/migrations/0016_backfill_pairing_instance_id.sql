-- ============================================================
-- 0016_backfill_pairing_instance_id
-- Backfill planning_item.pairing_instance_id pour les vols
-- ajoutés via la recherche AVANT le fix de SearchPanel (qui
-- ne passait pas pairing_instance_id à addPlanningItem, ce qui
-- cassait EP4/IR/Article 81 pour tous ces items).
--
-- Match : meta->>'destination' = pairing_signature.rotation_code
--      ET start_date = pairing_instance.depart_date
-- Snapshot : le plus récent (status=success) en cas d'ambiguïté.
-- ============================================================

with candidates as (
  select
    pi.id as item_id,
    pinst.id as inst_id,
    row_number() over (
      partition by pi.id
      order by snap.started_at desc nulls last
    ) as rn
  from planning_item pi
  join pairing_instance pinst   on pinst.depart_date = pi.start_date
  join pairing_signature psig   on psig.id = pinst.signature_id
  join scrape_snapshot snap     on snap.id = psig.snapshot_id
  where pi.kind = 'flight'
    and pi.pairing_instance_id is null
    and pi.meta is not null
    and (pi.meta->>'destination') = psig.rotation_code
    and snap.status = 'success'
)
update planning_item pi
set pairing_instance_id = c.inst_id
from candidates c
where c.item_id = pi.id
  and c.rn = 1;
