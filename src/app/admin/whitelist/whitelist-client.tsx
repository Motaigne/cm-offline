'use client';

import { useState, useTransition } from 'react';
import { addAllowedEmail, removeAllowedEmail } from '@/app/actions/admin';
import type { Database } from '@/types/supabase';

type AllowedEmail = Pick<Database['public']['Tables']['allowed_email']['Row'], 'email' | 'added_at' | 'note'>;
type AuthLog      = Pick<Database['public']['Tables']['auth_log']['Row'], 'id' | 'email' | 'kind' | 'created_at' | 'meta'>;

const KIND_LABELS: Record<AuthLog['kind'], { label: string; cls: string }> = {
  signin_denied:      { label: 'Refusé',     cls: 'text-red-500' },
  signin_requested:   { label: 'Demande',    cls: 'text-zinc-500' },
  signin_success:     { label: 'Connecté',   cls: 'text-emerald-500' },
  signout:            { label: 'Déconnecté', cls: 'text-zinc-400' },
  db_download:        { label: 'Download',   cls: 'text-blue-500' },
  release_published:  { label: 'Publication', cls: 'text-violet-500' },
  release_downloaded: { label: 'Release ↓',  cls: 'text-cyan-500' },
};

export function WhitelistClient({ emails, logs }: { emails: AllowedEmail[]; logs: AuthLog[] }) {
  const [newEmail, setNewEmail] = useState('');
  const [newNote,  setNewNote]  = useState('');
  const [err,      setErr]      = useState('');
  const [isPending, start]      = useTransition();

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
  );
}
