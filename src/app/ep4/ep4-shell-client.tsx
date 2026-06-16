'use client';

// Pendant client de l'ancien Server Component `/ep4/page.tsx`. Gère l'auth via
// useAuthGuard et délègue le rendu à Ep4PageClient qui lit Dexie d'abord.
// Permet à /ep4 d'être servie comme une coquille statique précachée par le
// service worker (cf `/`, `/comparatif`) — immédiate hors ligne / sur wifi
// captif, plus de page blanche cold-cold.

import { useState } from 'react';
import { useAuthGuard } from '@/hooks/use-auth-guard';
import { Ep4PageClient } from './ep4-page-client';
import { NavBar } from '@/app/components/nav';

function monthFromParam(raw: string | null): string {
  return raw && /^\d{4}-\d{2}$/.test(raw) ? raw : new Date().toISOString().slice(0, 7);
}

/** Lit `?m=YYYY-MM` une seule fois au mount. Ep4PageClient gère ensuite ses
 *  propres changements de mois via window.history.replaceState. */
function useInitialMonth(): string {
  const [month] = useState(() => {
    if (typeof window === 'undefined') return new Date().toISOString().slice(0, 7);
    const url = new URL(window.location.href);
    return monthFromParam(url.searchParams.get('m'));
  });
  return month;
}

function SkeletonShell() {
  return (
    <div className="flex flex-col min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <NavBar />
      <main className="flex-1 flex items-center justify-center text-sm text-zinc-400">
        Chargement…
      </main>
    </div>
  );
}

export function Ep4ShellClient() {
  const month = useInitialMonth();
  const { status } = useAuthGuard();

  if (status === 'loading' || status === 'redirecting') {
    return <SkeletonShell />;
  }

  return <Ep4PageClient month={month} />;
}
