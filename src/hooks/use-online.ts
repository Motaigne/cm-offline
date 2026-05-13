'use client';

import { useState, useEffect } from 'react';

/** Vrai statut réseau (navigator.onLine).
 *  Utilisé uniquement pour activer/désactiver les opérations réseau (bouton Sync).
 *  L'app est offline-first : toutes les écritures passent par la queue locale. */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(false);

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
