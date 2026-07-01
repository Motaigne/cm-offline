/** Course une promesse réseau contre un timeout.
 *
 *  Rejette avec `Error('timeout: <label>')` si `ms` est dépassé — le caller
 *  DOIT avoir un try/catch avec repli offline (lecture Dexie / cache).
 *
 *  Pourquoi c'est systématique dans l'app : `navigator.onLine` ne détecte PAS
 *  le wifi captif ni la 4G AF (onLine=true alors que le serveur est injoignable,
 *  la requête hang). Tout appel réseau doit donc être borné pour ne jamais
 *  figer l'UI. Motif déjà présent inline dans plusieurs shells (annexe, profil,
 *  ep4, comparatif) ; ce helper unifie le reste. */
export function raceTimeout<T>(promise: Promise<T>, ms: number, label = 'net'): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ]);
}
