'use client';

import { useState, useEffect } from 'react';

const STORAGE_KEY = 'cm-force-offline';
const EVENT_NAME  = 'cm-force-offline-change';

function readForceOffline(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(STORAGE_KEY) === '1';
}

/** Online "effectif" : navigator.onLine ET pas de force-offline manuel.
 *  Toujours initialiser à `true` pour aligner SSR + premier rendu client. */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(true);

  useEffect(() => {
    function update() {
      setOnline(navigator.onLine && !readForceOffline());
    }
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    window.addEventListener(EVENT_NAME, update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      window.removeEventListener(EVENT_NAME, update);
    };
  }, []);

  return online;
}

/** Permet à l'UI (NavBar) de forcer le mode offline manuellement.
 *  Persisté dans localStorage. La modification émet un événement custom pour
 *  que useOnlineStatus se mette à jour partout. */
export function useForceOffline(): [boolean, (v: boolean) => void] {
  const [forceOffline, setForceOfflineState] = useState<boolean>(false);

  useEffect(() => {
    setForceOfflineState(readForceOffline());
    function update() {
      setForceOfflineState(readForceOffline());
    }
    window.addEventListener(EVENT_NAME, update);
    return () => window.removeEventListener(EVENT_NAME, update);
  }, []);

  function setForceOffline(v: boolean) {
    if (v) localStorage.setItem(STORAGE_KEY, '1');
    else   localStorage.removeItem(STORAGE_KEY);
    // Mise à jour synchrone du local state → bouton (couleur) instantané.
    // Le dispatchEvent qui propage à tous les autres consumers est différé
    // d'une tick → React peut peindre le frame du clic avant d'attaquer la
    // cascade de re-render (gantt-view, etc.).
    setForceOfflineState(v);
    setTimeout(() => window.dispatchEvent(new Event(EVENT_NAME)), 0);
  }

  return [forceOffline, setForceOffline];
}
