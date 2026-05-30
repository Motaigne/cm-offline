-- ============================================================
-- 0030_user_a81_override
-- Stocke les modifications utilisateur sur les lignes du tableau A81
-- (page /a81) : édition Début/Fin Séjour + suppression de ligne.
--
-- Une row par (user_id, pairing_instance_id) — overrides cumulatifs.
-- Champs override null = pas modifié → on garde la valeur calculée
-- depuis raw_detail. deleted = true → ligne masquée du tableau.
-- ============================================================

create table if not exists user_a81_override (
  user_id              uuid not null references auth.users(id) on delete cascade,
  pairing_instance_id  uuid not null references pairing_instance(id) on delete cascade,
  deleted              boolean not null default false,
  debut_sejour_at      timestamptz,   -- null = pas modifié
  fin_sejour_at        timestamptz,   -- null = pas modifié
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (user_id, pairing_instance_id)
);

create index if not exists idx_user_a81_override_user
  on user_a81_override (user_id);

alter table user_a81_override enable row level security;

create policy "user reads own a81 overrides"
  on user_a81_override for select
  using (auth.uid() = user_id);

create policy "user inserts own a81 overrides"
  on user_a81_override for insert
  with check (auth.uid() = user_id);

create policy "user updates own a81 overrides"
  on user_a81_override for update
  using (auth.uid() = user_id);

create policy "user deletes own a81 overrides"
  on user_a81_override for delete
  using (auth.uid() = user_id);

-- Trigger updated_at
create or replace function user_a81_override_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;

drop trigger if exists trg_uao_updated_at on user_a81_override;
create trigger trg_uao_updated_at before update on user_a81_override
  for each row execute function user_a81_override_set_updated_at();
