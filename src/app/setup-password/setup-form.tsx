'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { setupPassword } from '@/app/actions/auth';

export function SetupPasswordForm({ next }: { next: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setMessage({ type: 'error', text: 'Les mots de passe ne correspondent pas.' });
      return;
    }
    setPending(true);
    setMessage(null);
    const result = await setupPassword(password);
    if ('error' in result) {
      setMessage({ type: 'error', text: result.error! });
      setPending(false);
    } else {
      setMessage({ type: 'success', text: 'Mot de passe enregistré !' });
      router.push(next);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="password" className="block text-sm font-medium mb-1">
          Nouveau mot de passe
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
      </div>
      <div>
        <label htmlFor="confirm" className="block text-sm font-medium mb-1">
          Confirmer le mot de passe
        </label>
        <input
          id="confirm"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
      </div>

      {message && (
        <p className={`text-sm ${message.type === 'error' ? 'text-red-500' : 'text-green-600 dark:text-green-400'}`}>
          {message.text}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {pending ? 'Enregistrement…' : 'Créer mon mot de passe'}
      </button>
    </form>
  );
}
