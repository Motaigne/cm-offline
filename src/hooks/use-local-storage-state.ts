'use client';

import { useEffect, useState } from 'react';

/**
 * Hook : state local synchronisé avec localStorage. Évite que chaque consommateur
 * ait à écrire `useState(default) + useEffect(localStorage.getItem)` (= warning
 * `react-hooks/set-state-in-effect` × N). Ici on absorbe ce pattern une seule
 * fois avec un disable documenté ; le consommateur a une API hook propre.
 *
 * SSR-safe : initial render = `defaultValue` (côté serveur localStorage absent,
 * côté client identique au 1er render → pas de hydration mismatch). Le useEffect
 * recale ensuite vers la valeur réelle de localStorage après le mount.
 *
 * Cross-tab : écoute l'event `storage` (navigateur déclenche pour les AUTRES
 * onglets uniquement → un onglet qui change la clé met à jour ses copains).
 *
 * Si `key` change (cas typique : index par mois courant), le useEffect re-fire
 * et lit la nouvelle clé.
 *
 * @param key            clé localStorage
 * @param defaultValue   valeur retournée tant que localStorage n'a pas été lu
 *                       (SSR + 1er render client) ou si la clé est absente
 * @param deserialize    fonction de parsing du raw string. Défaut JSON.parse.
 *                       Throw silencieusement = fallback à defaultValue.
 * @param serialize      fonction d'écriture. Défaut JSON.stringify.
 */
type SetStateAction<T> = T | ((prev: T) => T);

export function useLocalStorageState<T>(
  key: string,
  defaultValue: T,
  deserialize: (raw: string) => T = (raw) => JSON.parse(raw) as T,
  serialize:   (v: T) => string  = (v)   => JSON.stringify(v),
): [T, (next: SetStateAction<T>) => void] {
  const [value, setValue] = useState<T>(defaultValue);

  /* eslint-disable react-hooks/set-state-in-effect -- Lecture localStorage post-hydration : on ne peut pas init en synchrone sans risquer le hydration mismatch côté SSR. Pattern accepté ici, isolé dans ce hook. */
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      try { setValue(deserialize(raw)); } catch { /* corrompu : on garde le défaut */ }
    } else {
      // Clé absente sur ce key précis → re-applique defaultValue (utile si key change).
      setValue(defaultValue);
    }
    const handler = (e: StorageEvent) => {
      if (e.key !== key) return;
      if (e.newValue === null) setValue(defaultValue);
      else { try { setValue(deserialize(e.newValue)); } catch { /* skip */ } }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
    // Volontaire : on ne dépend QUE de la clé. deserialize/defaultValue sont
    // supposés stables (callers en module-scope).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const set = (next: SetStateAction<T>) => {
    setValue(prev => {
      const resolved = typeof next === 'function' ? (next as (prev: T) => T)(prev) : next;
      if (typeof localStorage !== 'undefined') {
        try { localStorage.setItem(key, serialize(resolved)); } catch { /* quota dépassé etc */ }
      }
      return resolved;
    });
  };

  return [value, set];
}
