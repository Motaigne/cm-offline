-- 0036 — Activity kind 'conge_ss' (Congés Sans Solde)
--
-- Permet de poser un CSS dans le calendrier. Effet sur la paie :
--   nb30e = nb30eR - cssDays  (où nb30eR = REGIME_NB30E[regime], ou 30 en
--                              jul/août pour TAF*_10_12 full-prime)
-- Cette abatement réduit : primeInstruction, primeA330, tFixe, mga, hsSeuil.
-- (les congés classiques n'affectent que hsSeuil, pas les primes/fixe).

alter type activity_kind add value if not exists 'conge_ss';
