'use client';

// Coquille statique précachée pour /catalogue (style /, /comparatif, /ep4,
// /annexe, /a81). Aucun fetch serveur au boot — auth client + Dexie dans
// CatalogueShellClient.

import { Suspense } from 'react';
import { CatalogueShellClient } from './catalogue-shell-client';
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

export default function CataloguePage() {
  return (
    <Suspense fallback={<ShellFallback />}>
      <CatalogueShellClient />
    </Suspense>
  );
}
