'use client';

// Toggle Eruda (console debug iPad) — visible uniquement sur /admin.
// Lit/écrit le flag localStorage cm-eruda et charge/détruit le script CDN.

import { useEffect, useState } from 'react';

const FLAG_KEY = 'cm-eruda';
const ERUDA_CDN = 'https://cdn.jsdelivr.net/npm/eruda';

declare global {
  interface Window {
    eruda?: { init: () => void; destroy?: () => void };
  }
}

export function ErudaToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    setEnabled(localStorage.getItem(FLAG_KEY) === '1');
  }, []);

  function toggle() {
    if (enabled) {
      localStorage.removeItem(FLAG_KEY);
      window.eruda?.destroy?.();
      setEnabled(false);
      return;
    }
    localStorage.setItem(FLAG_KEY, '1');
    if (window.eruda) { window.eruda.init(); setEnabled(true); return; }
    const s = document.createElement('script');
    s.src = ERUDA_CDN;
    s.async = true;
    s.onload = () => { window.eruda?.init(); setEnabled(true); };
    s.onerror = () => { alert('Eruda : chargement CDN échoué (hors ligne ?)'); };
    document.head.appendChild(s);
  }

  if (enabled === null) return null;

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={toggle}
        className={[
          'px-4 py-2 rounded-lg text-sm font-medium',
          enabled
            ? 'bg-red-600 hover:bg-red-700 text-white'
            : 'bg-zinc-900 hover:bg-zinc-700 text-white dark:bg-zinc-100 dark:hover:bg-zinc-300 dark:text-zinc-900',
        ].join(' ')}
      >
        {enabled ? 'Désactiver Eruda' : 'Activer Eruda console'}
      </button>
      <span className="text-xs text-zinc-500">
        {enabled
          ? 'Cercle gris en bas à droite — clique-le pour ouvrir.'
          : 'Active une console JS overlay (utile sur iPad PWA sans Mac).'}
      </span>
    </div>
  );
}
