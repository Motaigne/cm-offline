'use client';

import { useState, useEffect } from 'react';

/** Vrai statut réseau (navigator.onLine).
 *  Utilisé uniquement pour activer/désactiver les opérations réseau (bouton Sync).
 *  L'app est offline-first : toutes les écritures passent par la queue locale.
 *
 *  Init à `true` pour matcher le SSR (côté serveur navigator est absent → on
 *  considère que l'app est "en ligne" par défaut, vraie valeur lue côté client
 *  dans le useEffect). Évite tout mismatch d'hydration sur les consommateurs
 *  qui rendraient du JSX dépendant de cet état. */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(true);

  useEffect(() => {
    function update() { setOnline(navigator.onLine); }
    update();
    window.addEventListener('online',  update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online',  update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return online;
}
