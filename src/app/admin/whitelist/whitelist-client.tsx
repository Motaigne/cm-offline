'use client';

import { useState, useTransition, useEffect } from 'react';
import { addAllowedEmail, removeAllowedEmail, setUserScraperRole, backfillTsvNuit } from '@/app/actions/admin';
import type { Database } from '@/types/supabase';

type AllowedEmail = Pick<Database['public']['Tables']['allowed_email']['Row'], 'email' | 'added_at' | 'note'>;
type AuthLog      = Pick<Database['public']['Tables']['auth_log']['Row'], 'id' | 'email' | 'kind' | 'created_at' | 'meta'>;
type UserProfile  = { user_id: string; display_name: string | null; is_admin: boolean; is_scraper: boolean };

const KIND_LABELS: Record<AuthLog['kind'], { label: string; cls: string }> = {
  signin_denied:      { label: 'Refusé',     cls: 'text-red-500' },
  signin_requested:   { label: 'Demande',    cls: 'text-zinc-500' },
  signin_success:     { label: 'Connecté',   cls: 'text-emerald-500' },
  signout:            { label: 'Déconnecté', cls: 'text-zinc-400' },
  db_download:        { label: 'Download',   cls: 'text-blue-500' },
  release_published:  { label: 'Publication', cls: 'text-violet-500' },
  release_downloaded: { label: 'Release ↓',  cls: 'text-cyan-500' },
};

export function WhitelistClient({ emails, logs, profiles }: { emails: AllowedEmail[]; logs: AuthLog[]; profiles: UserProfile[] }) {
  const [newEmail, setNewEmail] = useState('');
  const [newNote,  setNewNote]  = useState('');
  const [err,      setErr]      = useState('');
  const [isPending, start]      = useTransition();
  const [profileList, setProfileList] = useState(profiles);

  const [backfillStatus, setBackfillStatus] = useState<string>('');

  // Backfill RPC (rest_before_h / rest_after_h)
  const [showRpcForm, setShowRpcForm]   = useState(false);
  const [rpcMonth,  setRpcMonth]        = useState('');
  const [rpcCookie, setRpcCookie]       = useState('');
  const [rpcSn,     setRpcSn]           = useState('');
  const [rpcUserId, setRpcUserId]       = useState('');
  const [rpcStatus, setRpcStatus]       = useState('');
  const [rpcBusy,   setRpcBusy]         = useState(false);

  useEffect(() => {
    setRpcSn(localStorage.getItem('af_sn') ?? '');
    setRpcUserId(localStorage.getItem('af_userid') ?? '');
    // Mois courant par défaut
    const now = new Date();
    setRpcMonth(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  }, []);

  async function handleBackfillRpc() {
    if (!rpcCookie || !rpcSn || !rpcUserId) return;
    localStorage.setItem('af_sn', rpcSn);
    localStorage.setItem('af_userid', rpcUserId);
    setRpcBusy(true);
    setRpcStatus('1 requête pairingsearch en cours…');
    try {
      const res = await fetch('/api/admin/backfill-rest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month: rpcMonth, cookie: rpcCookie, sn: rpcSn, userId: rpcUserId }),
      });
      if (!res.ok) { setRpcStatus(`! ${await res.text()}`); return; }
      const j = await res.json() as { updated: number; unchanged: number; missing: number; total: number };
      setRpcStatus(`✓ ${j.updated} mises à jour · ${j.unchanged} inchangées · ${j.missing} absentes search · ${j.total} totales`);
      setShowRpcForm(false);
    } catch (e) {
      setRpcStatus(`! ${String(e)}`);
    } finally {
      setRpcBusy(false);
    }
  }

  function handleBackfillTsvNuit() {
    if (!window.confirm('Recalculer tsv_nuit pour toutes les signatures avec raw_detail ?\n\nFormule alignée sur EP4 (per-service avec padding 1.5h). Pas de re-scrape AF, juste DB read+write.')) return;
    setBackfillStatus('en cours…');
    start(async () => {
      try {
        const res = await backfillTsvNuit();
        setBackfillStatus(`✓ ${res.updated} mises à jour · ${res.unchanged} inchangées · ${res.errors} erreurs · ${res.total} totales`);
      } catch (e) {
        setBackfillStatus(`! ${String(e)}`);
      }
    });
  }

  function handleToggleScraper(userId: string, current: boolean) {
    const next = !current;
    // Optimistic
    setProfileList(prev => prev.map(p => p.user_id === userId ? { ...p, is_scraper: next } : p));
    start(async () => {
      const res = await setUserScraperRole(userId, next);
      if (res?.error) {
        setErr(res.error);
        // Revert
        setProfileList(prev => prev.map(p => p.user_id === userId ? { ...p, is_scraper: current } : p));
      }
    });
  }

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    start(async () => {
      const res = await addAllowedEmail(newEmail, newNote);
      if (res?.error) setErr(res.error);
      else { setNewEmail(''); setNewNote(''); }
    });
  }

  function handleRemove(email: string) {
    if (!window.confirm(`Retirer ${email} de la whitelist ?`)) return;
    start(async () => {
      const res = await removeAllowedEmail(email);
      if (res?.error) setErr(res.error);
    });
  }

  return (
    <div className="space-y-6">

      {/* Outils admin */}
      <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4">
        <h2 className="text-sm font-semibold mb-1">Outils</h2>
        <p className="text-[11px] text-zinc-400 mb-3">Maintenance DB.</p>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={handleBackfillTsvNuit}
            disabled={isPending}
            className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold disabled:opacity-40 transition-colors"
          >
            Recalculer tsv_nuit (formule EP4)
          </button>
          {backfillStatus && (
            <span className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">{backfillStatus}</span>
          )}

          {/* Backfill RPC */}
          <button
            onClick={() => { setShowRpcForm(s => !s); setRpcStatus(''); }}
            className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition-colors"
          >
            Backfill RPC (repos avant/après)
          </button>
        </div>

        {showRpcForm && (
          <div className="mt-3 p-3 rounded-lg border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/30 space-y-2">
            <p className="text-[11px] text-sky-700 dark:text-sky-300">
              1 requête pairingsearch → mise à jour rest_before_h / rest_after_h sur le dernier snapshot success du mois.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-zinc-500 mb-0.5">Mois (YYYY-MM)</label>
                <input value={rpcMonth} onChange={e => setRpcMonth(e.target.value)}
                  className="w-full text-xs rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1" />
              </div>
              <div>
                <label className="block text-[10px] text-zinc-500 mb-0.5">SN</label>
                <input value={rpcSn} onChange={e => setRpcSn(e.target.value)}
                  className="w-full text-xs rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1" />
              </div>
              <div>
                <label className="block text-[10px] text-zinc-500 mb-0.5">User ID</label>
                <input value={rpcUserId} onChange={e => setRpcUserId(e.target.value)}
                  className="w-full text-xs rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1" />
              </div>
              <div>
                <label className="block text-[10px] text-zinc-500 mb-0.5">Cookie AF</label>
                <input value={rpcCookie} onChange={e => setRpcCookie(e.target.value)} type="password"
                  placeholder="JSESSIONID=…"
                  className="w-full text-xs rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1" />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleBackfillRpc}
                disabled={rpcBusy || !rpcCookie || !rpcSn || !rpcUserId}
                className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold disabled:opacity-40 transition-colors"
              >
                {rpcBusy ? '…' : 'Lancer'}
              </button>
              {rpcStatus && (
                <span className={`text-[11px] font-mono ${rpcStatus.startsWith('✓') ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
                  {rpcStatus}
                </span>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Scrapers : toggle per profile */}
      <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800">
        <header className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">Scrapers ({profileList.filter(p => p.is_scraper || p.is_admin).length} actifs)</h2>
          <p className="text-[11px] text-zinc-400 mt-0.5">
            Les admins peuvent toujours scraper. Les scrapers non-admin sont limités à 50 rotations par run.
          </p>
        </header>
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800 max-h-[40vh] overflow-y-auto">
          {profileList.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-zinc-400">Aucun profil enregistré.</li>
          )}
          {profileList.map(p => (
            <li key={p.user_id} className="flex items-center justify-between px-4 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
              <div className="min-w-0 flex items-center gap-2 flex-wrap">
                <span className="font-medium text-zinc-800 dark:text-zinc-100 truncate">
                  {p.display_name || <span className="text-zinc-400 italic">sans nom</span>}
                </span>
                {p.is_admin && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 font-semibold">
                    ADMIN
                  </span>
                )}
              </div>
              {p.is_admin ? (
                <span className="text-[11px] text-zinc-400">scraper auto (admin)</span>
              ) : (
                <button
                  onClick={() => handleToggleScraper(p.user_id, p.is_scraper)}
                  disabled={isPending}
                  className={[
                    'px-3 py-1 rounded-full text-xs font-semibold transition-colors disabled:opacity-40',
                    p.is_scraper
                      ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                      : 'bg-zinc-200 hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-zinc-600 dark:text-zinc-300',
                  ].join(' ')}
                >
                  {p.is_scraper ? '✓ Scraper' : 'Inactif'}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Liste des emails autorisés */}
      <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800">
        <header className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">Emails autorisés ({emails.length})</h2>
        </header>

        <form onSubmit={handleAdd} className="p-4 space-y-2 border-b border-zinc-100 dark:border-zinc-800">
          <div className="flex gap-2">
            <input
              type="email"
              value={newEmail}
              onChange={e => setNewEmail(e.target.value)}
              placeholder="email@exemple.com"
              required
              className="flex-1 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm"
            />
            <input
              type="text"
              value={newNote}
              onChange={e => setNewNote(e.target.value)}
              placeholder="note (facultative)"
              className="flex-1 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm"
            />
            <button
              type="submit"
              disabled={isPending}
              className="rounded bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-3 py-1 text-sm font-medium disabled:opacity-40"
            >
              Ajouter
            </button>
          </div>
          {err && <p className="text-xs text-red-500">{err}</p>}
        </form>

        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800 max-h-[60vh] overflow-y-auto">
          {emails.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-zinc-400">
              Aucun email autorisé pour l'instant.
            </li>
          )}
          {emails.map(e => (
            <li key={e.email} className="flex items-center justify-between px-4 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
              <div className="min-w-0">
                <p className="font-mono text-zinc-800 dark:text-zinc-100 truncate">{e.email}</p>
                {e.note && <p className="text-[11px] text-zinc-400 truncate">{e.note}</p>}
                <p className="text-[10px] text-zinc-400">
                  {new Date(e.added_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}
                </p>
              </div>
              <button
                onClick={() => handleRemove(e.email)}
                disabled={isPending}
                className="text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 px-2 py-1 rounded disabled:opacity-40"
              >
                Retirer
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* Journal d'authentification */}
      <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800">
        <header className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">Journal d'authentification (100 derniers)</h2>
        </header>
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800 max-h-[68vh] overflow-y-auto">
          {logs.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-zinc-400">
              Pas encore d'événement.
            </li>
          )}
          {logs.map(l => {
            const k = KIND_LABELS[l.kind];
            return (
              <li key={l.id} className="px-4 py-2 text-xs flex items-center gap-3">
                <span className={`font-semibold w-20 flex-shrink-0 ${k.cls}`}>{k.label}</span>
                <span className="font-mono text-zinc-700 dark:text-zinc-200 truncate flex-1">{l.email}</span>
                <span className="text-[10px] text-zinc-400 flex-shrink-0">
                  {new Date(l.created_at).toLocaleString('fr-FR', {
                    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
      </div>
    </div>
  );
}
