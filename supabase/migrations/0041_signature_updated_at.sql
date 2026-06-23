-- ============================================================
-- 0041_signature_updated_at
-- Ajoute pairing_signature.updated_at (+ trigger) pour permettre au client de
-- détecter qu'une sig a été modifiée hors rescrape (backfill raw_detail,
-- enrichissements admin, etc.).
--
-- Contexte : le Pull NavBar va devenir différentiel — l'app demande au serveur
-- max(updated_at) par mois, skip les mois inchangés. Sans updated_at sur
-- pairing_signature, un backfill silencieux ne déclencherait jamais de re-pull
-- côté client.
--
-- Backfill : initialise updated_at à scrape_snapshot.started_at (= la date où
-- la sig a été créée par le scrape). Garantit que le 1er Pull différentiel
-- voit des timestamps cohérents.
-- ============================================================

alter table pairing_signature
  add column if not exists updated_at timestamptz not null default now();

-- Backfill : les sigs existantes prennent la date du snapshot qui les a créées.
update pairing_signature ps
set updated_at = ss.started_at
from scrape_snapshot ss
where ps.snapshot_id = ss.id
  and ps.updated_at > ss.started_at + interval '1 second';

create index if not exists pairing_signature_updated_at_idx
  on pairing_signature (updated_at desc);

-- Trigger : tout futur UPDATE bumpe automatiquement updated_at (idem pattern
-- planning_draft / planning_item, fonction touch_updated_at déjà définie en
-- 0001_init).
drop trigger if exists pairing_signature_touch on pairing_signature;
create trigger pairing_signature_touch
  before update on pairing_signature
  for each row execute function touch_updated_at();
