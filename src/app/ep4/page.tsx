'use client';

// Coquille statique précachée pour /ep4 (style /page.tsx, /comparatif/page.tsx).
// Aucun fetch serveur au boot — auth client via useAuthGuard, data via Dexie
// dans Ep4PageClient. Permet à /ep4 de fonctionner sur wifi captif / SIM filtrée.

import { Suspense } from 'react';
import { Ep4ShellClient } from './ep4-shell-client';
import { NavBar } from '@/app/components/nav';

function ShellFallback() {
  return (
    <div className="flex flex-col min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <NavBar />
      <main className="flex-1 flex items-center justify-center text-sm text-zinc-400">
        Chargement…
      </main>
    </div>
  );
}

export default function Ep4Page() {
  return (
    <Suspense fallback={<ShellFallback />}>
      <Ep4ShellClient />
    </Suspense>
  );
}
