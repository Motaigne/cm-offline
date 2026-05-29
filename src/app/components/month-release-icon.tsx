'use client';

import { useEffect, useState, useCallback } from 'react';
import { downloadAndStoreRelease, getStoredReleases, dropExpiredReleases } from '@/lib/release/local';

interface ServerRelease {
  id: string;
  target_month: string;        // "YYYY-MM-DD"
  version: number;
  released_at: string;
  notes: string | null;
}

interface MonthState {
  server?: ServerRelease;
  local_version: number | null;
}

/** Icône à côté du label mois dans le header calendrier.
 *  - rien si pas de release serveur pour ce mois
 *  - ☁️↑ (clic = download) si release dispo, pas en local ou local < server
 *  - ✓ si à jour
 *  - spinner pendant le download
 *
 *  Le composant fetch /api/release une fois au mount (+ au focus) — pas par
 *  changement de mois — pour éviter de marteler l'API. */
export function MonthReleaseIcon({ month }: { month: string }) {
  // map "YYYY-MM-DD" → état pour rendu rapide au changement de mois
  const [states, setStates] = useState<Map<string, MonthState>>(new Map());
  const [busy, setBusy]     = useState(false);

  const refresh = useCallback(async () => {
    try {
      void dropExpiredReleases();
      const [serverRes, local] = await Promise.all([
        fetch('/api/release').then(r => r.ok ? r.json() as Promise<{ releases: ServerRelease[] }> : { releases: [] }),
        getStoredReleases(),
      ]);
      const localByMonth = new Map(local.map(r => [r.target_month, r.version]));
      const next = new Map<string, MonthState>();
      for (const r of serverRes.releases) {
        next.set(r.target_month, { server: r, local_version: localByMonth.get(r.target_month) ?? null });
      }
      setStates(next);
    } catch {
      /* offline / erreur : laisse l'état précédent */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => { if (navigator.onLine) void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const monthKey = month.length === 7 ? `${month}-01` : month;
  const st = states.get(monthKey);
  if (!st?.server) return null;

  const upToDate = st.local_version != null && st.local_version >= st.server.version;

  if (busy) {
    return (
      <span className="inline-flex items-center justify-center w-6 h-6 text-blue-500" aria-label="Téléchargement…">
        <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      </span>
    );
  }

  if (upToDate) {
    return (
      <span className="inline-flex items-center justify-center w-6 h-6 text-emerald-500"
        title={`DB v${st.server.version} téléchargée${st.server.notes ? ` — ${st.server.notes}` : ''}`}>
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    );
  }

  // Disponible mais non téléchargée (ou version locale < serveur)
  return (
    <button
      onClick={async () => {
        if (busy || !st.server) return;
        setBusy(true);
        try {
          await downloadAndStoreRelease(st.server.id);
          await refresh();
        } catch (e) {
          console.error('[release-icon] download failed', e);
        } finally {
          setBusy(false);
        }
      }}
      title={`DB v${st.server.version} disponible — clic pour télécharger${st.local_version != null ? ` (local : v${st.local_version})` : ''}${st.server.notes ? ` — ${st.server.notes}` : ''}`}
      className="inline-flex items-center justify-center w-6 h-6 rounded text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors animate-pulse"
    >
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </button>
  );
}
