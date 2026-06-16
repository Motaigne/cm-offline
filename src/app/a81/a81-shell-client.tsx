'use client';

// Pendant client de l'ancien Server Component `/a81/page.tsx`. Auth client via
// useAuthGuard. Données A81 calculées localement via computeA81ForYearLocal
// (Dexie). Permet à /a81 d'être servie comme une coquille statique précachée.

import { useEffect, useState } from 'react';
import { useAuthGuard } from '@/hooks/use-auth-guard';
import { db, loadA81OverridesLocal } from '@/lib/local-db';
import { computeA81ForYearLocal } from '@/lib/a81-local';
import type { A81YearData } from '@/app/actions/a81';
import { NavBar } from '@/app/components/nav';
import { A81Client } from './a81-client';

function yearFromParam(raw: string | null): number {
  if (raw && /^\d{4}$/.test(raw)) return Number(raw);
  return new Date().getUTCFullYear();
}

function useInitialYear(): number {
  const [year] = useState(() => {
    if (typeof window === 'undefined') return new Date().getUTCFullYear();
    const url = new URL(window.location.href);
    return yearFromParam(url.searchParams.get('y'));
  });
  return year;
}

/** Mirroir client de getA81AvailableYears : extrait les années des drafts A
 *  cachés en Dexie. Fallback à l'année courante si Dexie vide. */
async function loadA81AvailableYearsLocal(): Promise<number[]> {
  const drafts = await db.drafts.toArray();
  const years = new Set<number>();
  for (const d of drafts) {
    if (d.name !== 'A') continue;
    const y = d.target_month.slice(0, 4);
    if (/^\d{4}$/.test(y)) years.add(Number(y));
  }
  if (years.size === 0) return [new Date().getUTCFullYear()];
  return [...years].sort((a, b) => b - a);
}

interface ShellData {
  data: A81YearData;
  availableYears: number[];
}

function SkeletonShell() {
  return (
    <div className="flex flex-col h-screen bg-zinc-50 dark:bg-zinc-950 overflow-hidden">
      <NavBar />
      <main className="flex-1 flex items-center justify-center text-sm text-zinc-400">
        Chargement…
      </main>
    </div>
  );
}

export function A81ShellClient() {
  const year = useInitialYear();
  const { status } = useAuthGuard();
  const [shell, setShell] = useState<ShellData | null>(null);

  useEffect(() => {
    if (status !== 'authed') return;
    let cancelled = false;
    void (async () => {
      try {
        const [overrides, availableYears] = await Promise.all([
          loadA81OverridesLocal(),
          loadA81AvailableYearsLocal(),
        ]);
        if (cancelled) return;
        const data = await computeA81ForYearLocal(year, overrides, null);
        if (cancelled) return;
        setShell({ data, availableYears });
      } catch (e) {
        console.error('[a81-shell] load failed', e);
      }
    })();
    return () => { cancelled = true; };
  }, [status, year]);

  if (status === 'loading' || status === 'redirecting' || !shell) {
    return <SkeletonShell />;
  }

  return (
    <div className="flex flex-col h-screen bg-zinc-50 dark:bg-zinc-950 overflow-hidden">
      <NavBar />
      <div className="flex-1 overflow-y-auto">
        <A81Client
          data={shell.data}
          availableYears={shell.availableYears}
          currentYear={year}
        />
      </div>
    </div>
  );
}
