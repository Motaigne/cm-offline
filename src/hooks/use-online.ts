'use client';

import { useState, useEffect } from 'react';

export function useOnlineStatus(): boolean {
  // Toujours initialiser à `true` pour que le rendu SSR et le premier rendu client
  // soient identiques (évite l'hydration mismatch). On lit l'état réel après mount.
  const [online, setOnline] = useState<boolean>(true);

  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const dn = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', dn);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', dn);
    };
  }, []);

  return online;
}
