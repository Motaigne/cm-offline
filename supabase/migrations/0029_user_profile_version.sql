-- ============================================================
-- 0029_user_profile_version
-- Versionne le profil individuel par date d'application.
--   * Nouvelle table user_profile_version : snapshot des champs paie du
--     profil, indexé par (user_id, valid_from). PK composite.
--   * Contrainte : valid_from doit être le 1er du mois.
--   * Seed initial : copie le profil courant de chaque user avec
--     valid_from = '2026-01-01'.
--   * RLS : user peut select/insert/update/delete ses propres versions
--     SANS restriction de date (le propriétaire gère son historique).
--     Admin peut tout faire sur n'importe quel user.
--
-- Sémantique runtime : pour un mois M, on prend la row dont valid_from
-- <= 1er du M, la plus récente.
--
-- Cohabite avec user_profile : les champs versionnés restent dupliqués
-- là pour compat backward le temps de bascule complète. user_profile
-- garde aussi display_name, base, is_admin, is_scraper (non versionnés).
-- ============================================================

create table if not exists user_profile_version (
  user_id              uuid not null references auth.users(id) on delete cascade,
  valid_from           date not null,
  -- Champs versionnés (mêmes types que user_profile)
  fonction             fonction_enum not null,
  regime               regime_enum not null,
  qualifs_avion        text[] not null default '{}',
  instructeur          boolean not null default false,
  tri_niveau           int,
  prime_330_count      int,
  valeur_jour          numeric not null default 600,
  tmi                  numeric,
  classe               int,
  categorie            text,
  echelon              int,
  bonus_atpl           boolean not null default false,
  transport            text,
  navigo_eur           numeric,
  voiture_km_aller     numeric,
  voiture_indemnite_km numeric,
  aircraft_principal   text,
  cng_pv               numeric,
  cng_hs               numeric,
  base                 text not null default 'PAR',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (user_id, valid_from),
  constraint upv_valid_from_first_of_month check (extract(day from valid_from) = 1)
);

create index if not exists idx_user_profile_version_user_valid_from
  on user_profile_version (user_id, valid_from desc);

-- ── Seed depuis user_profile pour chaque user existant ────────────────
insert into user_profile_version (
  user_id, valid_from, fonction, regime, qualifs_avion, instructeur,
  tri_niveau, prime_330_count, valeur_jour, tmi, classe, categorie, echelon,
  bonus_atpl, transport, navigo_eur, voiture_km_aller, voiture_indemnite_km,
  aircraft_principal, cng_pv, cng_hs, base
)
select user_id, '2026-01-01'::date, fonction, regime, qualifs_avion, instructeur,
  tri_niveau, prime_330_count, coalesce(valeur_jour, 600), tmi, classe, categorie, echelon,
  coalesce(bonus_atpl, false), transport, navigo_eur, voiture_km_aller, voiture_indemnite_km,
  aircraft_principal, cng_pv, cng_hs, coalesce(base, 'PAR')
from user_profile
on conflict (user_id, valid_from) do nothing;

-- ── RLS ──────────────────────────────────────────────────────────────
alter table user_profile_version enable row level security;

-- SELECT : user own + admin all
create policy "user reads own profile versions"
  on user_profile_version for select
  using (auth.uid() = user_id);

create policy "admin reads all profile versions"
  on user_profile_version for select
  using (exists(select 1 from user_profile up where up.user_id = auth.uid() and up.is_admin = true));

-- INSERT : user own (any valid_from) + admin all
create policy "user inserts own profile versions"
  on user_profile_version for insert
  with check (auth.uid() = user_id);

create policy "admin inserts any profile versions"
  on user_profile_version for insert
  with check (exists(select 1 from user_profile up where up.user_id = auth.uid() and up.is_admin = true));

-- UPDATE : user own (any valid_from — le propriétaire gère son historique)
create policy "user updates own profile versions"
  on user_profile_version for update
  using (auth.uid() = user_id);

create policy "admin updates any profile versions"
  on user_profile_version for update
  using (exists(select 1 from user_profile up where up.user_id = auth.uid() and up.is_admin = true));

-- DELETE : user own (any valid_from) + admin all
create policy "user deletes own profile versions"
  on user_profile_version for delete
  using (auth.uid() = user_id);

create policy "admin deletes any profile versions"
  on user_profile_version for delete
  using (exists(select 1 from user_profile up where up.user_id = auth.uid() and up.is_admin = true));

-- Trigger updated_at
create or replace function user_profile_version_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;

drop trigger if exists trg_upv_updated_at on user_profile_version;
create trigger trg_upv_updated_at before update on user_profile_version
  for each row execute function user_profile_version_set_updated_at();
