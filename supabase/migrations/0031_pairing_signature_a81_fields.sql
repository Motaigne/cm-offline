-- ============================================================
-- 0031_pairing_signature_a81_fields
-- Ajoute 4 colonnes pré-calculées au moment du scrape pour permettre
-- de construire le tableau A81 SANS recharger raw_detail à chaque fois
-- (= compatible offline depuis le cache Dexie).
--
--   debut_sejour_at : datetime du 1er block-on de la rotation moins 5min
--                     (= atterrissage première escale).
--   fin_sejour_at   : datetime du dernier block-off de la rotation plus 10min
--                     (= décollage dernière escale).
--   escale_debut    : code IATA de l'escale en début de séjour (= arr. dernier
--                     leg du 1er service).
--   escale_fin      : code IATA de l'escale en fin de séjour (= dep. 1er leg
--                     du dernier service).
-- ============================================================

alter table pairing_signature
  add column if not exists debut_sejour_at timestamptz,
  add column if not exists fin_sejour_at   timestamptz,
  add column if not exists escale_debut    text,
  add column if not exists escale_fin      text;

create index if not exists idx_pairing_sig_debut_sejour
  on pairing_signature (debut_sejour_at);
