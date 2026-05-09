-- ============================================================
-- 0005_monthly_release
-- Workflow de publication manuelle d'une DB mensuelle (point A2 de la spec).
--
-- Ce qu'on ajoute :
--   * monthly_release      : 1 ligne par publication (versionné par mois,
--                            pointe sur un snapshot success)
--   * push_subscription    : abonnements Web Push par device/user
--   * release_download     : trace de chaque download (pour watermarking,
--                            expiration locale 60j, et logs de fuite)
--   * auth_log.kind étendu : 'release_published', 'release_downloaded'
--
-- Modèle : un admin "publie" un snapshot (target_month + version v(N+1)),
-- ce qui déclenche un push à tous les users whitelistés. Chaque user
-- télécharge un payload chiffré + watermarké, qui expire 60 jours après
-- en local.
-- ============================================================

-- ---------- monthly_release ----------
create table if not exists monthly_release (
  id            uuid primary key default gen_random_uuid(),
  target_month  date not null,                    -- 2026-07-01
  snapshot_id   uuid not null references scrape_snapshot(id) on delete restrict,
  version       int  not null,                    -- 1, 2, 3... incrémenté par mois
  released_at   timestamptz not null default now(),
  released_by   uuid references auth.users(id) on delete set null,
  notes         text,
  unique (target_month, version)
);

create index if not exists monthly_release_month_idx
  on monthly_release (target_month, version desc);

-- ---------- push_subscription ----------
create table if not exists push_subscription (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  endpoint    text not null,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  unique (user_id, endpoint)
);

create index if not exists push_subscription_user_idx
  on push_subscription (user_id);

-- ---------- release_download ----------
create table if not exists release_download (
  id            uuid primary key default gen_random_uuid(),
  release_id    uuid not null references monthly_release(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  watermark     text not null,                    -- HMAC(user_id || release_id || secret)
  downloaded_at timestamptz not null default now(),
  expires_at    timestamptz not null,             -- typiquement now() + 60j côté serveur
  user_agent    text
);

create index if not exists release_download_user_idx
  on release_download (user_id, downloaded_at desc);

create index if not exists release_download_release_idx
  on release_download (release_id);

-- ---------- auth_log.kind : ajout des nouveaux types ----------
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

-- ---------- RLS ----------
alter table monthly_release   enable row level security;
alter table push_subscription enable row level security;
alter table release_download  enable row level security;

-- monthly_release : tout user connecté lit (pour savoir quoi télécharger),
-- seul admin écrit (via endpoint serveur, contrôlé en code aussi).
create policy "authenticated reads monthly_release"
  on monthly_release for select
  using (auth.uid() is not null);

create policy "admin inserts monthly_release"
  on monthly_release for insert
  with check (exists(select 1 from user_profile where user_id = auth.uid() and is_admin = true));

-- push_subscription : chaque user gère ses propres lignes uniquement.
create policy "user reads own push_subscription"
  on push_subscription for select
  using (user_id = auth.uid());

create policy "user inserts own push_subscription"
  on push_subscription for insert
  with check (user_id = auth.uid());

create policy "user updates own push_subscription"
  on push_subscription for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "user deletes own push_subscription"
  on push_subscription for delete
  using (user_id = auth.uid());

-- Admin doit pouvoir lire toutes les subscriptions pour envoyer les pushes
-- (côté serveur on utilise le service role, donc bypass RLS — mais on
-- ouvre quand même un select pour outillage admin futur).
create policy "admin reads all push_subscription"
  on push_subscription for select
  using (exists(select 1 from user_profile where user_id = auth.uid() and is_admin = true));

-- release_download : user lit/écrit ses propres downloads ; admin lit tout
-- (audit de fuite).
create policy "user reads own release_download"
  on release_download for select
  using (user_id = auth.uid());

create policy "user inserts own release_download"
  on release_download for insert
  with check (user_id = auth.uid());

create policy "admin reads all release_download"
  on release_download for select
  using (exists(select 1 from user_profile where user_id = auth.uid() and is_admin = true));

-- ============================================================
-- Helper : prochaine version d'un mois (utilisé par l'endpoint admin)
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
