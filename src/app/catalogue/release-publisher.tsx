'use client';

import { useEffect, useState, useCallback } from 'react';

interface Release {
  id: string;
  target_month: string;
  version: number;
  released_at: string;
  notes: string | null;
}

export function ReleasePublisher({ month, isAdmin }: { month: string; isAdmin: boolean }) {
  const [releases, setReleases]       = useState<Release[]>([]);
  const [lastScrapeAt, setLastScrape] = useState<string | null>(null);
  const [showForm, setShowForm]       = useState(false);
  const [notes, setNotes]             = useState('');
  const [busy, setBusy]               = useState(false);
  const [msg, setMsg]                 = useState('');

  const refresh = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await fetch(`/api/admin/release?month=${month}`);
      if (!res.ok) return;
      const j = await res.json() as { releases: Release[]; lastScrapeAt: string | null };
      setReleases(j.releases);
      setLastScrape(j.lastScrapeAt);
    } catch { /* ignore */ }
  }, [month, isAdmin]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!isAdmin) return null;

  const latest = releases[0];
  const nextVersion = (latest?.version ?? 0) + 1;
  const hasNew = !latest
    || (!!lastScrapeAt && new Date(lastScrapeAt) > new Date(latest.released_at));

  async function handlePublish() {
    if (busy) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/admin/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month, notes: notes.trim() || null }),
      });
      if (!res.ok) {
        const txt = await res.text();
        setMsg(`Erreur : ${txt}`);
        return;
      }
      const j = await res.json() as { release: Release; push: { sent: number; failed: number } };
      setMsg(`✓ v${j.release.version} publiée — ${j.push.sent} push envoyé${j.push.sent > 1 ? 's' : ''}${j.push.failed ? `, ${j.push.failed} échec(s)` : ''}`);
      setNotes('');
      setShowForm(false);
      await refresh();
    } catch (e) {
      setMsg(`Erreur : ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => hasNew && setShowForm(s => !s)}
        disabled={!hasNew}
        className="text-xs px-2.5 py-1 rounded border transition-colors font-medium disabled:cursor-not-allowed border-violet-300 dark:border-violet-700 bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 hover:enabled:bg-violet-100 dark:hover:enabled:bg-violet-900/60 disabled:opacity-40"
        title={
          !hasNew
            ? `DB inchangée depuis la v${latest?.version ?? 0} (${latest ? new Date(latest.released_at).toLocaleDateString('fr-FR') : '—'})`
            : latest ? `Dernière release : v${latest.version}` : 'Aucune release publiée'
        }
      >
        Publier v{nextVersion}
      </button>
      {latest && (
        <span className="text-[10px] text-zinc-500" title={`Publié le ${new Date(latest.released_at).toLocaleString('fr-FR')}`}>
          v{latest.version} · {new Date(latest.released_at).toLocaleDateString('fr-FR')}
        </span>
      )}
      {showForm && (
        <div className="absolute z-30 mt-32 right-4 w-80 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg p-3 space-y-2">
          <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
            Publier la DB du mois courant comme release v{nextVersion} ?
          </p>
          <p className="text-[11px] text-zinc-500">
            Tous les utilisateurs whitelistés recevront un push.
          </p>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Notes (optionnel)"
            rows={2}
            className="w-full text-xs rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => { setShowForm(false); setMsg(''); }}
              className="text-xs px-2 py-1 rounded text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              Annuler
            </button>
            <button
              onClick={handlePublish}
              disabled={busy}
              className="text-xs px-3 py-1 rounded bg-violet-600 hover:bg-violet-700 text-white font-medium disabled:opacity-50"
            >
              {busy ? '…' : 'Publier'}
            </button>
          </div>
        </div>
      )}
      {msg && (
        <span className={`text-[10px] ml-2 ${msg.startsWith('✓') ? 'text-emerald-500' : 'text-red-500'}`}>
          {msg}
        </span>
      )}
    </div>
  );
}
