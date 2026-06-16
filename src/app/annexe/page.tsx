'use client';

// Coquille statique précachée pour /annexe (style /, /comparatif, /ep4).
// Aucun fetch serveur au boot — auth client via useAuthGuard, data via Dexie
// dans AnnexeShellClient.

import { Suspense } from 'react';
import { AnnexeShellClient } from './annexe-shell-client';
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

export default function AnnexePage() {
  return (
    <Suspense fallback={<ShellFallback />}>
      <AnnexeShellClient />
    </Suspense>
  );
}
