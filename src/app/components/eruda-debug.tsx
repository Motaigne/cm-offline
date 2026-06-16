'use client';

// Charge l'overlay Eruda au boot si le flag localStorage cm-eruda=1 est posé.
// Le toggle se fait depuis /admin (bouton dédié). Voir src/app/admin/eruda-toggle.tsx.
// L'URL ?eruda=1 reste supportée pour activation rapide depuis Safari avant
// installation de la PWA.

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

    // Activation/désactivation via URL (utile depuis Safari avant install).
    const url = new URL(window.location.href);
    const param = url.searchParams.get('eruda');
    if (param === '1') {
      localStorage.setItem(FLAG_KEY, '1');
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
    if (window.eruda) { window.eruda.init(); return; }

    const s = document.createElement('script');
    s.src = ERUDA_CDN;
    s.async = true;
    s.onload = () => { window.eruda?.init(); };
    s.onerror = () => { console.warn('[eruda] CDN load failed (offline?)'); };
    document.head.appendChild(s);
  }, []);

  return null;
}
