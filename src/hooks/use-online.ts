'use client';

import { useSyncExternalStore } from 'react';

function subscribe(callback: () => void): () => void {
  window.addEventListener('online',  callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online',  callback);
    window.removeEventListener('offline', callback);
  };
}

/** Vrai statut réseau (navigator.onLine).
 *  Utilisé uniquement pour activer/désactiver les opérations réseau (bouton Sync).
 *  L'app est offline-first : toutes les écritures passent par la queue locale.
 *
 *  Implémenté en useSyncExternalStore : pas de setState-in-effect, pas de
 *  cascade de renders. SSR snapshot = `true` (navigator absent côté serveur).
 *  Côté client, première lecture via getSnapshot = vrai navigator.onLine. */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}
