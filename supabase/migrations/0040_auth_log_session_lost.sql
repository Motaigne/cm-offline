-- ============================================================
-- 0040_auth_log_session_lost
-- Ajout du kind 'session_lost' à auth_log pour instrumenter les users qui
-- retombent sur /login sans avoir cliqué signOut.
--
-- Contexte : un user iPad rapporte se reconnecter SYSTÉMATIQUEMENT (parfois
-- plusieurs fois par jour). Pas un ITP iOS 7j (qui serait moins fréquent).
-- Hypothèses à mesurer : catch silencieux dans server.ts setAll, cookies
-- non transférés Safari → PWA standalone, ou réseau qui casse le refresh.
--
-- Le proxy logge 1 session_lost par redirect /login (throttle 5min via cookie
-- pour éviter le spam) avec email last-known (cookie cm-last-email posé à
-- chaque signin réussi) + meta { user_agent, path }.
-- ============================================================

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
    'release_downloaded',
    'session_lost'
  ));
