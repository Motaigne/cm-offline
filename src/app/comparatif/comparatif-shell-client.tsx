'use client';

// Pendant client de l'ancien Server Component `/comparatif/page.tsx`. Lit
// Dexie au lieu de Supabase pour les props initiales (months, article81Data,
// profileVersions, annexeRows). Les signatures du mois courant sont chargées
// ensuite par ComparatifClient lui-même via son loadMonth() — qui était déjà
// offline-first depuis le commit 87c2324.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthGuard } from '@/hooks/use-auth-guard';
import { db, loadAnnexeRowsLocal, loadProfileVersionsLocal } from '@/lib/local-db';
import { getAnnexeDataFromRows, type AnnexeRow } from '@/lib/annexe';
import type { Article81Data } from '@/lib/article81';
import type { ProfileVersion } from '@/app/actions/profile-version';
import type { RotationSignature } from '@/app/actions/search';
import { NavBar } from '@/app/components/nav';
import { ComparatifClient } from './comparatif-client';

const IS_ADMIN_CACHE_KEY = 'cm-is-admin';

interface ShellData {
  signatures: RotationSignature[];
  months: string[];
  currentMonth: string;
  article81Data: Article81Data | null;
  profileVersions: ProfileVersion[];
  annexeRows: AnnexeRow[];
  isAdmin: boolean;
}

function monthFromParam(raw: string | null): string {
  return raw && /^\d{4}-\d{2}$/.test(raw) ? raw : new Date().toISOString().slice(0, 7);
}

function useInitialMonth(): string {
  const [month] = useState(() => {
    if (typeof window === 'undefined') return new Date().toISOString().slice(0, 7);
    const url = new URL(window.location.href);
    return monthFromParam(url.searchParams.get('m'));
  });
  return month;
}

/** Dédup signatures par contenu (champs identiques sauf activity_id) et fusion
 *  des instances. Logique copiée de l'ancien Server Component pour préserver
 *  le comportement attendu par ComparatifClient. */
function dedupSignatures(sigs: RotationSignature[]): RotationSignature[] {
  function dedupKey(s: RotationSignature): string {
    return [
      s.rotation_code,
      Number(s.hc).toFixed(4),
      Number(s.hcr_crew).toFixed(4),
      Number(s.tsv_nuit ?? 0).toFixed(4),
      Number(s.rest_before_h ?? 0).toFixed(2),
      Number(s.rest_after_h ?? 0).toFixed(2),
      Number(s.prime ?? 0).toFixed(2),
      s.nb_on_days,
      s.aircraft_code,
    ].join('|');
  }
  const map = new Map<string, RotationSignature>();
  for (const s of sigs) {
    const key = dedupKey(s);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...s, instances: [...s.instances] });
    } else {
      prev.instances.push(...s.instances);
    }
  }
  for (const s of map.values()) {
    const seen = new Set<string>();
    s.instances = s.instances
      .filter(i => { if (seen.has(i.depart_at)) return false; seen.add(i.depart_at); return true; })
      .sort((a, b) => a.depart_at.localeCompare(b.depart_at));
  }
  return Array.from(map.values()).filter(s => s.instances.length > 0);
}

async function loadComparatifShellData(requestedMonth: string): Promise<ShellData> {
  const [allRotations, annexeRows, profileVersions] = await Promise.all([
    db.rotations.toArray(),
    loadAnnexeRowsLocal(),
    loadProfileVersionsLocal(),
  ]);

  // Months disponibles : on exclut les mois fictifs (projection admin),
  // comparatif n'expose que les snapshots réels (parité avec l'ancien
  // Server Component qui filtrait is_fictive = false).
  const monthsSet = new Set<string>();
  for (const r of allRotations) {
    if (r.is_fictive) continue;
    monthsSet.add(r.target_month);
  }
  const months = [...monthsSet].sort().reverse();

  // Si le mois demandé n'est pas dispo en cache, fallback sur le plus récent.
  const month = months.includes(requestedMonth) ? requestedMonth : (months[0] ?? requestedMonth);

  // Signatures du mois (avec dedup pour fusionner les sigs identiques).
  const sigsForMonth = allRotations.filter(r => r.target_month === month && !r.is_fictive);
  const dedupedSigs = dedupSignatures(sigsForMonth);

  // Article 81 : version applicable au mois.
  const annexe = getAnnexeDataFromRows(annexeRows, month);
  void annexe;
  const cutoff = `${month}-01`;
  let article81Data: Article81Data | null = null;
  let bestValidFrom = '';
  for (const r of annexeRows) {
    if (r.slug !== 'article_81') continue;
    if (r.valid_from > cutoff) continue;
    if (r.valid_from > bestValidFrom) {
      bestValidFrom = r.valid_from;
      article81Data = r.data as Article81Data | null;
    }
  }

  // isAdmin : cache localStorage (set après chaque online check). Default false.
  const cachedAdmin = typeof window !== 'undefined'
    ? localStorage.getItem(IS_ADMIN_CACHE_KEY) === '1'
    : false;

  return {
    signatures: dedupedSigs,
    months,
    currentMonth: month,
    article81Data,
    profileVersions,
    annexeRows,
    isAdmin: cachedAdmin,
  };
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

export function ComparatifShellClient() {
  const router = useRouter();
  const month = useInitialMonth();
  const { status } = useAuthGuard();
  const [data, setData] = useState<ShellData | null>(null);

  useEffect(() => {
    if (status !== 'authed') return;
    let cancelled = false;
    void (async () => {
      try {
        const d = await loadComparatifShellData(month);
        if (cancelled) return;
        setData(d);
      } catch (e) {
        console.error('[comparatif-shell] load failed', e);
      }
    })();
    return () => { cancelled = true; };
  }, [status, month]);

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
        // Met à jour seulement si data est déjà chargée et que la valeur change.
        setData(d => d && d.isAdmin !== r.is_admin ? { ...d, isAdmin: r.is_admin } : d);
      } catch { /* offline / captif : on garde le cache */ }
    })();
    return () => { cancelled = true; };
  }, [status]);

  if (status === 'loading' || status === 'redirecting' || !data) {
    return <SkeletonShell />;
  }

  // router est dispo si on veut faire de la nav programmatique plus tard.
  void router;

  return (
    <div className="flex flex-col h-screen bg-zinc-50 dark:bg-zinc-950 overflow-hidden">
      <NavBar />
      <div className="flex-1 overflow-y-auto">
        <ComparatifClient
          signatures={data.signatures}
          months={data.months}
          currentMonth={data.currentMonth}
          article81Data={data.article81Data}
          profileVersions={data.profileVersions}
          annexeRows={data.annexeRows}
          isAdmin={data.isAdmin}
        />
      </div>
    </div>
  );
}
