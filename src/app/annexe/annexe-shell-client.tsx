'use client';

// Pendant client de l'ancien Server Component `/annexe/page.tsx`. Charge les
// rows annexe depuis Dexie, isAdmin depuis localStorage. Permet à /annexe
// d'être servie comme une coquille statique précachée par le service worker.

import { useEffect, useState } from 'react';
import { useAuthGuard } from '@/hooks/use-auth-guard';
import { loadAnnexeRowsLocal } from '@/lib/local-db';
import { NavBar } from '@/app/components/nav';
import { AnnexeClient } from './annexe-client';
import type { Json } from '@/types/supabase';

const IS_ADMIN_CACHE_KEY = 'cm-is-admin';

// Noms affichés en titre de chaque Card. La table DB `annexe_table.name` n'est
// pas mise en cache dans Dexie (le type AnnexeRow client ne porte que slug +
// valid_from + data). On rétablit ici une étiquette stable par slug.
const SLUG_NAMES: Record<string, string> = {
  cat_anciennete:        'Coefficient d’ancienneté',
  coef_classe:           'Coefficient de classe',
  taux_avion:            'Taux avion',
  prime_incitation:      'Prime d’incitation',
  prime_incitation_330:  'Prime A330 / A350',
  traitement_base:       'Traitement de base',
  prorata:               'Prorata régimes',
  prime_instruction:     'Prime d’instruction',
  article_81:            'Article 81',
  ir_mf_rates:           'IR + MF',
  dda_rules:             'Règles DDA',
  vol_p_rules:           'Règles Vol P',
  definitions:           'Définitions',
  monthly_targets:       'Cibles mensuelles élabo (eHS / HC)',
};

type AnnexeClientRow = {
  slug: string;
  valid_from: string;
  name: string;
  description: string | null;
  data: Json;
  updated_at: string;
};

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

export function AnnexeShellClient() {
  const { status } = useAuthGuard();
  const [rows, setRows] = useState<AnnexeClientRow[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);

  useEffect(() => {
    if (status !== 'authed') return;
    let cancelled = false;
    void (async () => {
      try {
        const cached = await loadAnnexeRowsLocal();
        if (cancelled) return;
        const mapped: AnnexeClientRow[] = cached.map(r => ({
          slug:        r.slug,
          valid_from:  r.valid_from,
          name:        SLUG_NAMES[r.slug] ?? r.slug,
          description: null,
          data:        r.data as Json,
          updated_at:  '',
        }));
        // Trie comme l'ancien Server Component : slug asc, valid_from desc.
        mapped.sort((a, b) => a.slug.localeCompare(b.slug) || b.valid_from.localeCompare(a.valid_from));
        setRows(mapped);

        const cachedAdmin = typeof window !== 'undefined'
          ? localStorage.getItem(IS_ADMIN_CACHE_KEY) === '1'
          : false;
        setCanEdit(cachedAdmin);
      } catch (e) {
        console.error('[annexe-shell] load failed', e);
        setRows([]);
      }
    })();
    return () => { cancelled = true; };
  }, [status]);

  // Revalide isAdmin en background si online — silencieux en cas d'échec.
  useEffect(() => {
    if (status !== 'authed' || typeof window === 'undefined') return;
    if (!navigator.onLine) return;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentUserScrapeRights } = await import('@/app/actions/auth');
        const r = await Promise.race([
          getCurrentUserScrapeRights(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('isAdmin timeout')), 5000)),
        ]);
        if (cancelled) return;
        localStorage.setItem(IS_ADMIN_CACHE_KEY, r.is_admin ? '1' : '0');
        setCanEdit(r.is_admin);
      } catch { /* offline / captif : on garde le cache */ }
    })();
    return () => { cancelled = true; };
  }, [status]);

  if (status === 'loading' || status === 'redirecting' || !rows) {
    return <SkeletonShell />;
  }

  return (
    <div className="flex flex-col h-screen bg-zinc-50 dark:bg-zinc-950 overflow-hidden">
      <NavBar />
      <div className="flex-1 overflow-y-auto">
        <AnnexeClient rows={rows} canEdit={canEdit} />
      </div>
    </div>
  );
}
