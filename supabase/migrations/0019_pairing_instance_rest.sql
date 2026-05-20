-- ============================================================
-- 0019_pairing_instance_rest
-- Ajoute rest_before_h et rest_after_h à pairing_instance pour stocker
-- les valeurs PAR INSTANCE (et non par signature).
--
-- Contexte : pairing_signature.rest_*_h représente le RPC d'UNE instance
-- "représentative", donc faux pour les autres instances de la même rotation
-- ayant un RPC différent (ex. LAX-PPT-LAX, certaines instances ont 60.8h,
-- d'autres 108.75h selon le créneau de la semaine). On stocke désormais
-- la valeur correcte par instance.
--
-- Backfill : NULL pour les instances existantes. À ré-alimenter via le
-- bouton "Backfill RPC" admin (qui sera mis à jour pour cibler les
-- instances par activity_id).
-- ============================================================

alter table pairing_instance
  add column if not exists rest_before_h numeric(6,2),
  add column if not exists rest_after_h  numeric(6,2);
