'use client';

// Pendant client de l'ancien Server Component `/profil/page.tsx`. Auth client
// via useAuthGuard. ProfileVersions + annexeRows lus depuis Dexie. Le legacy
// user_profile row (initialData) n'est pas caché en Dexie — on passe
// undefined : la forme utilise la version sélectionnée comme source. Si
// aucune version (cas d'un user qui n'a jamais sauvegardé), la forme part
// sur les défauts — acceptable car ce cas est marginal et offline-only.

import { useEffect, useState } from 'react';
import { useAuthGuard } from '@/hooks/use-auth-guard';
import { loadAnnexeRowsLocal, loadProfileVersionsLocal, cacheProfileVersions, cacheAnnexeRows } from '@/lib/local-db';
import type { AnnexeRow } from '@/lib/annexe';
import type { ProfileVersion } from '@/app/actions/profile-version';
import { NavBar } from '@/app/components/nav';
import { ProfilForm } from './profil-form';

interface ShellData {
  annexeRows: AnnexeRow[];
  allVersions: ProfileVersion[];
  isNew: boolean;
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

export function ProfilShellClient() {
  const { status, session } = useAuthGuard();
  const [data, setData] = useState<ShellData | null>(null);

  useEffect(() => {
    if (status !== 'authed') return;
    let cancelled = false;
    void (async () => {
      try {
        const [annexeRows, allVersions] = await Promise.all([
          loadAnnexeRowsLocal(),
          loadProfileVersionsLocal(),
        ]);
        if (cancelled) return;
        setData({
          annexeRows,
          allVersions,
          isNew: allVersions.length === 0,
        });
      } catch (e) {
        console.error('[profil-shell] load failed', e);
      }
    })();
    return () => { cancelled = true; };
  }, [status]);

  // Revalide profileVersions + annexeRows en background si online — silencieux
  // en cas d'échec. Cache Dexie mis à jour pour les prochaines visites offline.
  useEffect(() => {
    if (status !== 'authed' || typeof window === 'undefined') return;
    if (!navigator.onLine) return;
    const userId = session?.user.id;
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { loadAllProfileVersions } = await import('@/app/actions/profile-version');
        const { loadAllAnnexeRows } = await import('@/app/actions/annexe');
        const [versions, annexe] = await Promise.race([
          Promise.all([loadAllProfileVersions(userId), loadAllAnnexeRows()]),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('profil revalidate timeout')), 8000)),
        ]);
        if (cancelled) return;
        await Promise.all([
          cacheProfileVersions(versions),
          cacheAnnexeRows(annexe),
        ]);
        setData({
          annexeRows: annexe,
          allVersions: versions,
          isNew: versions.length === 0,
        });
      } catch { /* offline / captif : on garde le cache */ }
    })();
    return () => { cancelled = true; };
  }, [status, session]);

  if (status === 'loading' || status === 'redirecting' || !data) {
    return <SkeletonShell />;
  }

  return (
    <div className="flex flex-col h-screen bg-zinc-50 dark:bg-zinc-950 overflow-hidden">
      <NavBar />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto p-6 space-y-6">
          <div>
            <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
              {data.isNew ? 'Créer mon profil' : 'Mon profil'}
            </h1>
            <p className="text-sm text-zinc-400 mt-0.5">
              Les éléments de paie sont versionnés par date d&apos;application. Le calendrier
              utilise la version applicable au mois affiché.
            </p>
          </div>
          <ProfilForm
            isNew={data.isNew}
            annexeRows={data.annexeRows}
            allVersions={data.allVersions}
          />
        </div>
      </div>
    </div>
  );
}
