'use client';

// Coquille statique précachée pour /profil (style /, /comparatif, /ep4,
// /annexe, /a81, /catalogue). Aucun fetch serveur au boot — auth client +
// Dexie dans ProfilShellClient.

import { Suspense } from 'react';
import { ProfilShellClient } from './profil-shell-client';
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

export default function ProfilPage() {
  return (
    <Suspense fallback={<ShellFallback />}>
      <ProfilShellClient />
    </Suspense>
  );
}
