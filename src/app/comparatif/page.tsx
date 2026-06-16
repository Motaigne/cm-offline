'use client';

// Coquille statique précachée pour /comparatif (style /page.tsx). Aucun fetch
// serveur au boot — toutes les data viennent de Dexie via ComparatifShellClient.
// Permet à /comparatif de fonctionner sur wifi captif / SIM filtrée comme `/`.

import { Suspense } from 'react';
import { ComparatifShellClient } from './comparatif-shell-client';
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

export default function ComparatifPage() {
  return (
    <Suspense fallback={<ShellFallback />}>
      <ComparatifShellClient />
    </Suspense>
  );
}
