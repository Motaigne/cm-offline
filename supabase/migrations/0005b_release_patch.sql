-- ============================================================
-- 0005b_release_patch
-- Rattrape les morceaux de 0005 non appliqués lors du premier passage :
--   * RPC next_release_version (idempotent via CREATE OR REPLACE)
--   * extension de auth_log.kind pour accepter 'release_published' et
--     'release_downloaded' (drop + recreate du check)
-- ============================================================

create or replace function public.next_release_version(month date)
returns int
language sql
security definer
set search_path = public
as $$
  select coalesce(max(version), 0) + 1
  from public.monthly_release
  where target_month = month;
$$;

grant execute on function public.next_release_version(date) to authenticated;

alter table auth_log
  drop constraint if exists auth_log_kind_check;

alter table auth_log
  add constraint auth_log_kind_check check (kind in (
    'signin_denied',
    'signin_requested',
    'signin_success',
    'signout',
    'db_download',
    'release_published',
    'release_downloaded'
  ));
