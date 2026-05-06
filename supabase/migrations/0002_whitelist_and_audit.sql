-- ============================================================
-- 0002 : Whitelist d'emails autorisés + journal d'authentification
-- (point K de la spec cm-offline-modifications)
-- ============================================================

-- ---------- Rôle admin ----------
alter table user_profile
  add column if not exists is_admin boolean not null default false;

-- ---------- Whitelist ----------
create table if not exists allowed_email (
  email       text primary key,
  added_by    uuid references auth.users(id) on delete set null,
  added_at    timestamptz not null default now(),
  note        text
);

create index if not exists allowed_email_added_idx on allowed_email (added_at desc);

-- ---------- Journal d'authentification ----------
create table if not exists auth_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete set null,
  email       text not null,
  kind        text not null check (kind in (
    'signin_denied',     -- email pas en whitelist
    'signin_requested',  -- magic link demandé / mot de passe envoyé
    'signin_success',    -- session établie
    'signout',
    'db_download'        -- téléchargement d'export CSV (à utiliser plus tard)
  )),
  meta        jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists auth_log_created_idx on auth_log (created_at desc);
create index if not exists auth_log_email_idx   on auth_log (email);

-- ---------- RPC public : vérifie sans authentification ----------
-- Permet au formulaire de login de bloquer un email non-whitelisté
-- avant même d'appeler supabase.auth.signInWithOtp.
create or replace function public.is_email_allowed(check_email text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists(
    select 1 from allowed_email where lower(email) = lower(check_email)
  );
$$;

grant execute on function public.is_email_allowed(text) to anon, authenticated;

-- ---------- RLS ----------
alter table allowed_email enable row level security;
alter table auth_log      enable row level security;

-- allowed_email : seul admin peut lire/écrire
create policy "admin selects allowed_email"
  on allowed_email for select
  using (exists(select 1 from user_profile where user_id = auth.uid() and is_admin = true));

create policy "admin inserts allowed_email"
  on allowed_email for insert
  with check (exists(select 1 from user_profile where user_id = auth.uid() and is_admin = true));

create policy "admin deletes allowed_email"
  on allowed_email for delete
  using (exists(select 1 from user_profile where user_id = auth.uid() and is_admin = true));

-- auth_log : tout le monde peut INSERT (pour logger même les denied), seul admin lit
create policy "anyone inserts auth_log"
  on auth_log for insert
  with check (true);

create policy "admin selects auth_log"
  on auth_log for select
  using (exists(select 1 from user_profile where user_id = auth.uid() and is_admin = true));

-- ============================================================
-- BOOTSTRAP — à exécuter manuellement APRÈS la migration :
--
-- 1. Te désigner admin (remplace par ton email) :
--      update user_profile
--      set is_admin = true
--      where user_id = (select id from auth.users where email = 'julienmickael81@gmail.com');
--
-- 2. T'ajouter à la whitelist (sinon tu seras bloqué à la prochaine connexion) :
--      insert into allowed_email (email, note) values
--        ('julienmickael81@gmail.com', 'admin principal');
-- ============================================================
