-- ============================================================
-- 0018_refresh_planning_item_rest
-- Rafraîchit planning_item.meta (rest_before_h / rest_after_h) depuis
-- pairing_signature pour tous les vols ayant un pairing_instance_id.
--
-- Contexte : ces valeurs sont copiées dans meta au moment de l'ajout
-- via la recherche, donc figées. Après un Backfill RPC qui corrige
-- pairing_signature.rest_*_h, les items existants gardent l'ancienne
-- valeur dans meta — la barre "post-courrier" du calendrier affiche
-- une longueur erronée (visuel seulement, pas d'impact financier).
--
-- Cette migration synchronise meta avec la DB pour les items existants.
-- ============================================================

update planning_item pi
set meta = coalesce(pi.meta, '{}'::jsonb) || jsonb_build_object(
  'rest_before_h', sig.rest_before_h,
  'rest_after_h',  sig.rest_after_h
)
from pairing_instance inst
join pairing_signature sig on sig.id = inst.signature_id
where pi.pairing_instance_id = inst.id
  and pi.kind = 'flight';
