'use client';

// Console debug pour iPad PWA quand on n'a pas de Mac pour Safari Inspector.
// Eruda = overlay JS qui affiche Console / Network / Resources / Info DIRECTEMENT
// dans la page. Fonctionne en SIM, wifi captif, offline — aucune dépendance
// réseau au moment de l'usage (le script CDN est chargé au moment où on active).
//
// Activation côté Safari (depuis URL bar) : `?eruda=1` une fois.
// Activation côté PWA installée (localStorage isolé d'iOS) : **5 taps rapides
// sur le coin haut-droit de l'écran** (zone invisible 40×40 px). Toast s'affiche.
// Désactivation : pareil (5 taps → toggle).

import { useEffect, useRef, useState } from 'react';

const FLAG_KEY = 'cm-eruda';
const ERUDA_CDN = 'https://cdn.jsdelivr.net/npm/eruda';
const TAP_THRESHOLD = 5;
const TAP_WINDOW_MS = 3000;

declare global {
  interface Window {
    eruda?: { init: () => void; destroy?: () => void };
  }
}

function loadAndInit(): void {
  if (window.eruda) { window.eruda.init(); return; }
  const s = document.createElement('script');
  s.src = ERUDA_CDN;
  s.async = true;
  s.onload = () => { window.eruda?.init(); };
  s.onerror = () => { console.warn('[eruda] CDN load failed (offline?)'); };
  document.head.appendChild(s);
}

function disable(): void {
  localStorage.removeItem(FLAG_KEY);
  window.eruda?.destroy?.();
}

function enable(): void {
  localStorage.setItem(FLAG_KEY, '1');
  loadAndInit();
}

export function ErudaDebug() {
  const tapsRef = useRef<number[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Activation via URL (utile depuis Safari, AVANT install PWA).
    const url = new URL(window.location.href);
    const param = url.searchParams.get('eruda');
    if (param === '1') {
      enable();
      url.searchParams.delete('eruda');
      window.history.replaceState(null, '', url.toString());
    } else if (param === '0') {
      disable();
      url.searchParams.delete('eruda');
      window.history.replaceState(null, '', url.toString());
      return;
    }

    if (localStorage.getItem(FLAG_KEY) === '1') loadAndInit();
  }, []);

  function onTap() {
    const now = Date.now();
    const recent = tapsRef.current.filter(t => now - t < TAP_WINDOW_MS);
    recent.push(now);
    tapsRef.current = recent;
    if (recent.length >= TAP_THRESHOLD) {
      tapsRef.current = [];
      if (localStorage.getItem(FLAG_KEY) === '1') {
        disable();
        setToast('Eruda désactivé');
      } else {
        enable();
        setToast('Eruda activé — voir le cercle gris en bas à droite');
      }
      setTimeout(() => setToast(null), 2500);
    }
  }

  return (
    <>
      {/* Zone tap invisible top-right (au-dessus de la nav, dans le safe-area).
          40×40 px, sans background, ne capture pas les events normaux du fait
          de pointer-events: auto ciblé. */}
      <div
        onClick={onTap}
        aria-hidden
        style={{
          position: 'fixed',
          top: 'env(safe-area-inset-top, 0px)',
          right: 0,
          width: 40,
          height: 40,
          zIndex: 9999,
          background: 'transparent',
        }}
      />
      {toast && (
        <div
          style={{
            position: 'fixed',
            top: 'calc(env(safe-area-inset-top, 0px) + 50px)',
            right: 10,
            zIndex: 10000,
            background: 'rgba(0,0,0,0.85)',
            color: 'white',
            padding: '8px 12px',
            borderRadius: 8,
            fontSize: 12,
            maxWidth: 240,
          }}
        >
          {toast}
        </div>
      )}
    </>
  );
}
