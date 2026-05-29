-- ============================================================
-- 0027_user_notes
-- Notes utilisateur sur le calendrier (rappels, RDV, anniversaires, etc).
-- Cross-scénario : 1 note s'affiche sur les 3 lignes A/B/C du même utilisateur.
-- Stockées dans une table dédiée (pas planning_item) car non-rattachées à un
-- draft mensuel particulier — une note de plusieurs jours peut traverser les
-- mois sans duplication.
-- ============================================================

create table user_note (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  start_date  date not null,
  end_date    date not null,
  text        text not null,
  color       text,                    -- hex ou nom : null = défaut (jaune doux)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (end_date >= start_date)
);
create index user_note_user_dates_idx on user_note (user_id, start_date, end_date);

alter table user_note enable row level security;

create policy "note_self_rw" on user_note
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create trigger user_note_touch before update on user_note
  for each row execute function touch_updated_at();
