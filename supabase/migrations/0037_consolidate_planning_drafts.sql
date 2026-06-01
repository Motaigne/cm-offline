-- 0037 — Consolide les planning_draft en doublon + ajoute un unique index
--
-- Bug historique : getOrCreateDraft utilisait `.single()` qui retourne
-- data=null aussi bien sur 0 rows que sur >1 rows. Si une race créait un
-- doublon `(user_id, target_month, name)`, chaque call subséquent voyait
-- null → INSERT → encore un doublon. Effet boule de neige : on a vu un user
-- accumuler 700+ drafts pour mai 2026. Les planning_item posés après chaque
-- render référencent un draft_id différent. La page rerender → getOrCreateDraft
-- crée le N+1ème draft → le scénario "courant" pointe vers ce dernier qui n'a
-- aucun item → le vol fraîchement posé semble disparaître après sync, alors
-- qu'il existe en DB mais sous un draft obsolète.
--
-- Cette migration :
--   1. Réassigne tous les planning_item vers le draft canonique
--      (le plus ancien par clé (user_id, target_month, name)).
--   2. Supprime les drafts non-canoniques.
--   3. Ajoute un unique index pour rendre toute récidive impossible.

-- 1. Migrate items orphelins vers le draft canonique.
with canonical as (
  select distinct on (user_id, target_month, name)
    id as canon_id, user_id, target_month, name
  from planning_draft
  order by user_id, target_month, name, created_at asc
)
update planning_item pi
set draft_id = c.canon_id
from planning_draft pd
join canonical c
  on pd.user_id      = c.user_id
 and pd.target_month = c.target_month
 and pd.name         = c.name
where pi.draft_id = pd.id
  and pd.id <> c.canon_id;

-- 2. Delete drafts non-canoniques (cascade vide : items déjà redirigés).
with canonical as (
  select distinct on (user_id, target_month, name)
    id as canon_id, user_id, target_month, name
  from planning_draft
  order by user_id, target_month, name, created_at asc
)
delete from planning_draft pd
using canonical c
where pd.user_id      = c.user_id
  and pd.target_month = c.target_month
  and pd.name         = c.name
  and pd.id <> c.canon_id;

-- 3. Unique index : empêche la récidive. Toute INSERT concurrente échouera
--    avec SQLSTATE 23505 → côté code, on catch et on re-SELECT.
create unique index planning_draft_user_month_name_uniq
  on planning_draft (user_id, target_month, name);
