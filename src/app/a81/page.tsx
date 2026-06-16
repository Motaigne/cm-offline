'use client';

// Coquille statique précachée pour /a81 (style /, /comparatif, /ep4, /annexe).
// Aucun fetch serveur au boot — auth client + Dexie computeA81ForYearLocal
// dans A81ShellClient.

import { Suspense } from 'react';
import { A81ShellClient } from './a81-shell-client';
import { NavBar } from '@/app/components/nav';

function ShellFallback() {
  return (
    <div className="flex flex-col h-screen bg-zinc-50 dark:bg-zinc-950 overflow-hidden">
      <NavBar />
      <main className="flex-1 flex items-center justify-center text-sm text-zinc-400">
        Chargement…
      </main>
    </div>
  );
}

export default function A81Page() {
  return (
    <Suspense fallback={<ShellFallback />}>
      <A81ShellClient />
    </Suspense>
  );
}
