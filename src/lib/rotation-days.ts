/**
 * Nombre de jours calendaires UTC couverts par une rotation, du premier
 * block-off au dernier block-on.
 *
 * Source de vérité partagée entre :
 *  - `scraper/pipeline.ts` (au scrape — écrit `pairing_signature.nb_on_days`)
 *  - `ep4/build.ts`        (pour `ON` / `ONm` dans EP4)
 *
 * Plus fiable que `pairingDetail.pairingValue[0].nbOnDays` renvoyé par CrewBidd,
 * qui peut être stale (cache AF) — observé sur signatures JFK pré-mig 0033 dont
 * le `nbOnDays` du raw_detail diverge des instances réelles.
 */
export function computeNbOnDays(beginBlockDateMs: number, endBlockDateMs: number): number {
  if (!beginBlockDateMs || !endBlockDateMs || endBlockDateMs < beginBlockDateMs) return 0;
  const begin = new Date(beginBlockDateMs);
  const end   = new Date(endBlockDateMs);
  const beginDay = Date.UTC(begin.getUTCFullYear(), begin.getUTCMonth(), begin.getUTCDate());
  const endDay   = Date.UTC(end.getUTCFullYear(),   end.getUTCMonth(),   end.getUTCDate());
  return Math.round((endDay - beginDay) / 86_400_000) + 1;
}
