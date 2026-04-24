-- ============================================================
-- CM-OFFLINE : schéma initial
-- Cible : Supabase (Postgres 15+), extensions pgsodium actives
-- ============================================================

-- ---------- Extensions ----------
create extension if not exists "pgcrypto";

-- ---------- Enums ----------
create type regime_enum as enum (
  'TP',             -- temps plein
  'TAF7_10_12',     -- 7 jours OFF × 10 mois/12 (hors juillet/août)
  'TAF7_12_12',     -- 7 jours OFF tous les mois
  'TAF10_10_12',    -- 10 jours OFF × 10 mois/12
  'TAF10_12_12',    -- 10 jours OFF tous les mois
  'TTA92',          -- 1 mois off/an
  'TTA83',          -- 2 mois off/an
  'TTA75'           -- 4 mois off/an
);

create type fonction_enum as enum ('CDB', 'OPL', 'INSTR');

create type activity_kind as enum (
  'flight',    -- vol                   bleu
  'conge',     -- congés                vert foncé
  'off',       -- jour OFF              vert clair
  'sol',       -- sol / réserve         rose
  'taf',       -- jour TAF7 OFF         jaune
  'medical',   -- visite médicale       rose foncé
  'instr'      -- instruction           rose clair
);

create type bid_category as enum (
  'dda_vol',   -- 1 par mois : bid sur un vol
  'vol_p',     -- 1 par mois : vol prioritaire
  'dda_off'    -- 1 par mois : bid sur une plage OFF (0-6 jours)
);

create type snapshot_status as enum ('running', 'success', 'error');

-- ============================================================
-- PROFIL & SESSION AF
-- ============================================================
create table user_profile (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  display_name   text,
  base           text not null default 'PAR',
  fonction       fonction_enum not null,
  regime         regime_enum not null,
  qualifs_avion  text[] not null default '{}',       -- ['359', '777', '330']
  instructeur    boolean not null default false,
  is_scraper     boolean not null default false,     -- rôle pour run du scrape
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table user_af_session (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  cookie_encrypted    bytea not null,
  sn_token            text,
  af_user_id          text,
  last_refreshed_at   timestamptz not null,
  expires_hint        timestamptz
);

-- ============================================================
-- RÉFÉRENCES GLOBALES
-- ============================================================
create table taux_app (
  id            serial primary key,
  rot_code      text not null,            -- PAC, AFR, AME, CSA, MGI, APC...
  duree_min_h   numeric not null,
  duree_max_h   numeric not null,
  taux          numeric not null,
  valid_from    date not null default '2020-01-01',
  valid_to      date
);
create index taux_app_rot_idx on taux_app (rot_code, duree_min_h);

-- prorata DDA OFF : nombre de jours OFF en fonction des congés/TTA/TAF posés
create table prorata_dda_off (
  id                 serial primary key,
  total_off_days     int not null,        -- congés + TTA/TAF7/TAF10
  dda_off_max_days   int not null,        -- 0 à 6
  note               text
);

-- ============================================================
-- SNAPSHOTS DE SCRAPE (1 run global = 1 mois cible)
-- ============================================================
create table scrape_snapshot (
  id                   uuid primary key default gen_random_uuid(),
  scraped_by           uuid references auth.users(id),
  target_month         date not null,                     -- YYYY-MM-01
  started_at           timestamptz not null default now(),
  finished_at          timestamptz,
  status               snapshot_status not null default 'running',
  flights_found        int,
  unique_signatures    int,
  http_requests        int,
  error_message        text
);
create index scrape_snapshot_month_idx on scrape_snapshot (target_month desc);

-- ============================================================
-- DONNÉES DE VOL
-- ============================================================
create table pairing_signature (
  id                   uuid primary key default gen_random_uuid(),
  snapshot_id          uuid not null references scrape_snapshot(id) on delete cascade,

  -- clé de dédup (14 champs issus du pipeline Python script 2)
  dead_head            boolean not null,
  legs_number          int not null,
  station_code         text not null,
  stopovers            text not null,         -- ex "LAX-PPT-LAX"
  layovers             int not null,
  first_layover        text,
  first_flight_number  text,
  aircraft_code        text not null,          -- 359, 777, 330
  heure_debut          time not null,
  heure_fin            time not null,
  nb_on_days           int not null,
  tdv_total            numeric not null,
  hc                   numeric not null,
  hcr_crew             numeric not null,
  hdv                  numeric not null,

  -- calculs pré-mâchés (Edge Function pendant scrape — formules serveur only)
  rotation_code        text,                   -- "8ON LAX PPT LAX"
  zone                 text,                   -- PAC, AFR, AME...
  temps_sej            numeric,
  h2hc                 numeric,
  pv_base              numeric,
  prime                numeric,

  -- JSON brut AF — police d'assurance pour retraitement sans re-scrape
  raw_detail           jsonb,

  created_at           timestamptz not null default now()
);
create index pairing_signature_snapshot_idx on pairing_signature (snapshot_id);
create index pairing_signature_rotation_idx on pairing_signature (rotation_code);
create index pairing_signature_aircraft_idx on pairing_signature (aircraft_code);
create index pairing_signature_ondays_idx on pairing_signature (nb_on_days);

create table pairing_instance (
  id             uuid primary key default gen_random_uuid(),
  signature_id   uuid not null references pairing_signature(id) on delete cascade,
  activity_id    text not null,               -- ID AF (unique par occurrence)
  depart_date    date not null,
  depart_at      timestamptz not null,
  arrivee_at     timestamptz not null,
  unique (signature_id, activity_id)
);
create index pairing_instance_date_idx on pairing_instance (depart_date);
create index pairing_instance_signature_idx on pairing_instance (signature_id);

-- ============================================================
-- PLANNING UTILISATEUR (brouillons / scénarios)
-- ============================================================
create table planning_draft (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  target_month   date not null,           -- YYYY-MM-01
  name           text not null default 'Scénario',
  is_primary     boolean not null default false,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index planning_draft_user_month_idx on planning_draft (user_id, target_month);

create table planning_item (
  id                    uuid primary key default gen_random_uuid(),
  draft_id              uuid not null references planning_draft(id) on delete cascade,
  kind                  activity_kind not null,
  bid_category          bid_category,     -- NULL sauf si c'est un slot DDA

  -- référence au vol réel (si kind = 'flight')
  pairing_instance_id   uuid references pairing_instance(id),

  start_date            date not null,
  end_date              date not null,
  meta                  jsonb,             -- stockage libre (commentaire, code custom)
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index planning_item_draft_date_idx on planning_item (draft_id, start_date);
create index planning_item_pairing_idx    on planning_item (pairing_instance_id);

-- Un draft ne peut avoir qu'un seul item par catégorie de bid (dda_vol, vol_p, dda_off)
create unique index planning_item_one_bid_per_draft_idx
  on planning_item (draft_id, bid_category)
  where bid_category is not null;

-- ============================================================
-- RLS
-- ============================================================
alter table user_profile         enable row level security;
alter table user_af_session      enable row level security;
alter table scrape_snapshot      enable row level security;
alter table pairing_signature    enable row level security;
alter table pairing_instance     enable row level security;
alter table planning_draft       enable row level security;
alter table planning_item        enable row level security;
alter table taux_app             enable row level security;
alter table prorata_dda_off      enable row level security;

-- user_profile : chacun voit et édite son profil
create policy "profile_self_rw" on user_profile
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- user_af_session : chacun voit et édite sa propre session AF
create policy "session_self_rw" on user_af_session
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- scrape_snapshot : tout authentifié lit, seul scraper écrit
create policy "snapshot_read_auth" on scrape_snapshot
  for select using (auth.role() = 'authenticated');
create policy "snapshot_write_scraper" on scrape_snapshot
  for insert with check (
    exists (select 1 from user_profile where user_id = auth.uid() and is_scraper)
  );
create policy "snapshot_update_scraper" on scrape_snapshot
  for update using (
    exists (select 1 from user_profile where user_id = auth.uid() and is_scraper)
  );

-- pairing_signature : lecture tous, écriture scraper
create policy "sig_read_auth" on pairing_signature
  for select using (auth.role() = 'authenticated');
create policy "sig_write_scraper" on pairing_signature
  for all using (
    exists (select 1 from user_profile where user_id = auth.uid() and is_scraper)
  );

-- pairing_instance : idem
create policy "inst_read_auth" on pairing_instance
  for select using (auth.role() = 'authenticated');
create policy "inst_write_scraper" on pairing_instance
  for all using (
    exists (select 1 from user_profile where user_id = auth.uid() and is_scraper)
  );

-- taux_app & prorata_dda_off : lecture tous, écriture scraper/admin
create policy "taux_read_auth" on taux_app
  for select using (auth.role() = 'authenticated');
create policy "taux_write_scraper" on taux_app
  for all using (
    exists (select 1 from user_profile where user_id = auth.uid() and is_scraper)
  );

create policy "prorata_read_auth" on prorata_dda_off
  for select using (auth.role() = 'authenticated');
create policy "prorata_write_scraper" on prorata_dda_off
  for all using (
    exists (select 1 from user_profile where user_id = auth.uid() and is_scraper)
  );

-- planning_draft & planning_item : chacun ses propres brouillons
create policy "draft_self_rw" on planning_draft
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "item_self_rw" on planning_item
  for all using (
    draft_id in (select id from planning_draft where user_id = auth.uid())
  ) with check (
    draft_id in (select id from planning_draft where user_id = auth.uid())
  );

-- ============================================================
-- Triggers updated_at
-- ============================================================
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger user_profile_touch     before update on user_profile     for each row execute function touch_updated_at();
create trigger planning_draft_touch   before update on planning_draft   for each row execute function touch_updated_at();
create trigger planning_item_touch    before update on planning_item    for each row execute function touch_updated_at();
