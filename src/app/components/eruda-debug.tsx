'use client';

// Console debug pour iPad PWA quand on n'a pas de Mac pour Safari Inspector.
// Eruda = overlay JS qui affiche Console / Network / Resources / Info DIRECTEMENT
// dans la page. Fonctionne en SIM, wifi captif, offline — aucune dépendance
// réseau au moment de l'usage (le script CDN est chargé au moment où on active).
//
// Activation : ouvre l'app avec `?eruda=1` une fois. Persisté localStorage.
// Désactivation : `?eruda=0`. Ou bien `localStorage.removeItem('cm-eruda')` via
// console JS classique.
//
// L'icône d'Eruda (cercle gris en bas à droite) → toggle l'overlay.

import { useEffect } from 'react';

const FLAG_KEY = 'cm-eruda';
const ERUDA_CDN = 'https://cdn.jsdelivr.net/npm/eruda';

declare global {
  interface Window {
    eruda?: { init: () => void; destroy?: () => void };
  }
}

export function ErudaDebug() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Lecture du flag URL pour activer/désactiver.
    const url = new URL(window.location.href);
    const param = url.searchParams.get('eruda');
    if (param === '1') {
      localStorage.setItem(FLAG_KEY, '1');
      // Nettoie l'URL pour ne pas trainer le param.
      url.searchParams.delete('eruda');
      window.history.replaceState(null, '', url.toString());
    } else if (param === '0') {
      localStorage.removeItem(FLAG_KEY);
      url.searchParams.delete('eruda');
      window.history.replaceState(null, '', url.toString());
      window.eruda?.destroy?.();
      return;
    }

    if (localStorage.getItem(FLAG_KEY) !== '1') return;
    if (window.eruda) {
      window.eruda.init();
      return;
    }

    // Chargement async du script CDN. Si offline + jamais chargé → silent fail.
    const s = document.createElement('script');
    s.src = ERUDA_CDN;
    s.async = true;
    s.onload = () => { window.eruda?.init(); };
    s.onerror = () => { console.warn('[eruda] CDN load failed (offline?)'); };
    document.head.appendChild(s);
  }, []);

  return null;
}
