'use client';

import { useEffect, useState, useCallback } from 'react';
import { downloadAndStoreRelease, getStoredReleases, dropExpiredReleases } from '@/lib/release/local';
import { usePushSubscription } from '@/hooks/use-push-subscription';

interface ServerRelease {
  id: string;
  target_month: string;        // "YYYY-MM-DD"
  version: number;
  released_at: string;
  notes: string | null;
}

interface PendingRelease extends ServerRelease {
  /** version en local pour ce mois (null = jamais téléchargé). */
  local_version: number | null;
}

function fmtMonth(targetMonth: string): string {
  const [y, m] = targetMonth.split('-').map(Number);
  const MOIS = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];
  return `${MOIS[(m ?? 1) - 1]} ${y}`;
}

export function ReleaseBanner() {
  const [pending, setPending] = useState<PendingRelease[]>([]);
  const [busy, setBusy]       = useState<string | null>(null);
  const [err, setErr]         = useState('');
  const { status: pushStatus, subscribe } = usePushSubscription();

  const refresh = useCallback(async (highlightId?: string) => {
    setErr('');
    try {
      // Drop releases expirées en local au passage
      void dropExpiredReleases();

      const [serverRes, local] = await Promise.all([
        fetch('/api/release').then(r => r.ok ? r.json() as Promise<{ releases: ServerRelease[] }> : { releases: [] }),
        getStoredReleases(),
      ]);

      const localByMonth = new Map(local.map(r => [r.target_month, r.version]));
      const list = serverRes.releases
        .map<PendingRelease>(r => ({ ...r, local_version: localByMonth.get(r.target_month) ?? null }))
        // Affiche : releases jamais téléchargées OU version serveur > version locale
        .filter(r => r.local_version == null || r.local_version < r.version);

      // Highlight d'une release ciblée par notification (URL ?release=...)
      if (highlightId) {
        const idx = list.findIndex(r => r.id === highlightId);
        if (idx > 0) { const [it] = list.splice(idx, 1); list.unshift(it); }
      }

      setPending(list);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    const highlightId = url.searchParams.get('release') ?? undefined;
    void refresh(highlightId);

    // Refresh en revenant en focus
    const onFocus = () => { if (navigator.onLine) void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  async function handleDownload(r: PendingRelease) {
    if (busy) return;
    setBusy(r.id);
    setErr('');
    try {
      await downloadAndStoreRelease(r.id);
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  if (pending.length === 0 && pushStatus === 'subscribed') return null;

  return (
    <div className="bg-blue-50 dark:bg-blue-950/40 border-b border-blue-200 dark:border-blue-900 text-[12px] flex flex-col gap-1 px-3 py-2">
      {pending.map(r => (
        <div key={r.id} className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-blue-900 dark:text-blue-200">
            <span className="font-medium">DB {fmtMonth(r.target_month)} v{r.version} disponible</span>
            {r.local_version != null && (
              <span className="text-blue-500 dark:text-blue-400 text-[11px]">
                (local : v{r.local_version})
              </span>
            )}
            {r.notes && <span className="text-blue-700 dark:text-blue-300 text-[11px] italic">— {r.notes}</span>}
          </div>
          <button
            onClick={() => handleDownload(r)}
            disabled={busy === r.id}
            className="px-3 h-6 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50 transition-colors"
          >
            {busy === r.id ? '…' : 'Télécharger'}
          </button>
        </div>
      ))}
      {pushStatus === 'default' && (
        <div className="flex items-center justify-between gap-2 text-blue-700 dark:text-blue-300">
          <span>Active les notifications pour être prévenu des nouvelles DBs.</span>
          <button
            onClick={() => void subscribe()}
            className="px-2 h-5 rounded-md bg-blue-100 dark:bg-blue-900 hover:bg-blue-200 dark:hover:bg-blue-800 text-blue-700 dark:text-blue-200 text-[11px] font-medium"
          >
            Activer
          </button>
        </div>
      )}
      {pushStatus === 'ios-not-installed' && (
        <p className="text-blue-700 dark:text-blue-300 text-[11px]">
          ℹ Pour recevoir les notifications sur iPhone/iPad, installe l'app : Safari → Partager → « Sur l'écran d'accueil ».
        </p>
      )}
      {err && <p className="text-red-500 text-[11px]">{err}</p>}
    </div>
  );
}
