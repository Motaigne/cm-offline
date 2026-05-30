-- ============================================================
-- 0032_user_a81_year_data
-- Stocke les données A81 saisies par l'utilisateur au niveau année.
-- Pour l'instant : plafond_exo_brut (Montant brut fiscal pris en compte
-- pour le calcul du plafond d'exonération), saisi manuellement par
-- l'utilisateur depuis sa fiche de paie annuelle.
-- ============================================================

create table if not exists user_a81_year_data (
  user_id          uuid not null references auth.users(id) on delete cascade,
  year             int  not null,
  plafond_exo_brut numeric,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (user_id, year)
);

alter table user_a81_year_data enable row level security;

create policy "user reads own a81 year data"
  on user_a81_year_data for select
  using (auth.uid() = user_id);

create policy "user inserts own a81 year data"
  on user_a81_year_data for insert
  with check (auth.uid() = user_id);

create policy "user updates own a81 year data"
  on user_a81_year_data for update
  using (auth.uid() = user_id);

create policy "user deletes own a81 year data"
  on user_a81_year_data for delete
  using (auth.uid() = user_id);

create or replace function user_a81_year_data_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;

drop trigger if exists trg_uayd_updated_at on user_a81_year_data;
create trigger trg_uayd_updated_at before update on user_a81_year_data
  for each row execute function user_a81_year_data_set_updated_at();
