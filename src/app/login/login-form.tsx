'use client';

import { useState } from 'react';
import { signInWithMagicLink, signInWithPassword } from '@/app/actions/auth';

type Mode = 'magic' | 'password';
type Message = { type: 'success' | 'error'; text: string };

export function LoginForm({ urlError }: { urlError?: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<Mode>('password');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<Message | null>(
    urlError ? { type: 'error', text: 'Lien de connexion invalide ou expiré.' } : null
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setMessage(null);

    if (mode === 'magic') {
      const result = await signInWithMagicLink(email);
      if ('error' in result) {
        setMessage({ type: 'error', text: result.error! });
      } else {
        setMessage({ type: 'success', text: 'Lien envoyé — vérifie ta boîte mail.' });
      }
    } else {
      const result = await signInWithPassword(email, password);
      if (result && 'error' in result) {
        setMessage({ type: 'error', text: result.error });
      }
    }

    setPending(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium mb-1">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          placeholder="pilote@airfrance.fr"
        />
      </div>

      {mode === 'password' && (
        <div>
          <label htmlFor="password" className="block text-sm font-medium mb-1">
            Mot de passe
          </label>
          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
      )}

      {message && (
        <p
          className={`text-sm ${
            message.type === 'error'
              ? 'text-red-500'
              : 'text-green-600 dark:text-green-400'
          }`}
        >
          {message.text}
        </p>
      )}

      <div className="flex gap-2">
        {mode === 'magic' ? (
          <>
            <button
              type="submit"
              disabled={pending}
              className="flex-1 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {pending ? 'Envoi…' : 'Envoyer un lien magique'}
            </button>
            <button
              type="button"
              onClick={() => { setMode('password'); setMessage(null); }}
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Mot de passe
            </button>
          </>
        ) : (
          <>
            <button
              type="submit"
              disabled={pending}
              className="flex-1 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {pending ? 'Connexion…' : 'Se connecter'}
            </button>
            <button
              type="button"
              onClick={() => { setMode('magic'); setMessage(null); }}
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Nouveau compte
            </button>
          </>
        )}
      </div>
    </form>
  );
}
