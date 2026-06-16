'use client';

// Pendant client de l'ancien Server Component `/catalogue/page.tsx`. Auth
// client via useAuthGuard. Signatures + months + profile + annexe lus depuis
// Dexie. CatalogueTable gère ses propres switches de mois (loadRotationsFromDB)
// et re-fetch online si Dexie vide — on lui passe juste l'état initial.

import { useEffect, useState } from 'react';
import { useAuthGuard } from '@/hooks/use-auth-guard';
import {
  db, loadAnnexeRowsLocal, loadProfileVersionsLocal,
} from '@/lib/local-db';
import type { AnnexeRow } from '@/lib/annexe';
import type { Article81Data } from '@/lib/article81';
import type { ProfileVersion } from '@/app/actions/profile-version';
import type { RotationSignature } from '@/app/actions/search';
import { NavBar } from '@/app/components/nav';
import { CatalogueTable } from './catalogue-table';

const IS_ADMIN_CACHE_KEY = 'cm-is-admin';

// Sig type tel qu'attendu par CatalogueTable (sous-ensemble de RotationSignature).
type Sig = {
  id: string;
  rotation_code: string | null;
  zone: string | null;
  aircraft_code: string;
  hc: number;
  hcr_crew: number;
  tsv_nuit: number | null;
  prime: number | null;
  nb_on_days: number;
  first_layover: string | null;
  layovers: number;
  rest_before_h: number | null;
  rest_after_h: number | null;
  a81: boolean | null;
  heure_debut: string | null;
  heure_fin: string | null;
  temps_sej: number | null;
};

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

/** Même dédup que comparatif-shell : sigs identiques (champs paie) fusionnées. */
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
    if (!map.has(key)) map.set(key, s);
  }
  return Array.from(map.values());
}

function rotToSig(s: RotationSignature): Sig {
  return {
    id:             s.id,
    rotation_code:  s.rotation_code,
    zone:           s.zone,
    aircraft_code:  s.aircraft_code,
    hc:             s.hc,
    hcr_crew:       s.hcr_crew,
    tsv_nuit:       s.tsv_nuit,
    prime:          s.prime,
    nb_on_days:     s.nb_on_days,
    first_layover:  s.first_layover,
    layovers:       s.layovers,
    rest_before_h:  s.rest_before_h,
    rest_after_h:   s.rest_after_h,
    a81:            s.a81,
    heure_debut:    s.heure_debut,
    heure_fin:      s.heure_fin,
    temps_sej:      s.temps_sej ?? null,
  };
}

interface ShellData {
  signatures: Sig[];
  months: string[];
  currentMonth: string;
  article81Data: Article81Data | null;
  profileVersions: ProfileVersion[];
  annexeRows: AnnexeRow[];
  isAdmin: boolean;
}

async function loadCatalogueShellData(requestedMonth: string): Promise<ShellData> {
  const [allRotations, annexeRows, profileVersions] = await Promise.all([
    db.rotations.toArray(),
    loadAnnexeRowsLocal(),
    loadProfileVersionsLocal(),
  ]);

  // Months disponibles : exclut les fictifs (catalogue n'expose que le réel,
  // parité avec l'ancien Server Component qui filtrait is_fictive = false).
  const monthsSet = new Set<string>();
  for (const r of allRotations) {
    if (r.is_fictive) continue;
    monthsSet.add(r.target_month);
  }
  const months = [...monthsSet].sort().reverse();

  // Fallback sur mois le plus récent si demandé indisponible.
  const month = months.includes(requestedMonth) ? requestedMonth : (months[0] ?? requestedMonth);

  // Signatures du mois (dédup pour fusionner sigs identiques).
  const sigsForMonth = allRotations.filter(r => r.target_month === month && !r.is_fictive);
  const dedupedSigs = dedupSignatures(sigsForMonth).map(rotToSig);

  // Article 81 applicable au mois.
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

export function CatalogueShellClient() {
  const month = useInitialMonth();
  const { status } = useAuthGuard();
  const [data, setData] = useState<ShellData | null>(null);

  useEffect(() => {
    if (status !== 'authed') return;
    let cancelled = false;
    void (async () => {
      try {
        const d = await loadCatalogueShellData(month);
        if (cancelled) return;
        setData(d);
      } catch (e) {
        console.error('[catalogue-shell] load failed', e);
      }
    })();
    return () => { cancelled = true; };
  }, [status, month]);

  // Revalide isAdmin en background si online.
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
        setData(d => d && d.isAdmin !== r.is_admin ? { ...d, isAdmin: r.is_admin } : d);
      } catch { /* offline : on garde le cache */ }
    })();
    return () => { cancelled = true; };
  }, [status]);

  if (status === 'loading' || status === 'redirecting' || !data) {
    return <SkeletonShell />;
  }

  return (
    <div className="flex flex-col h-screen bg-zinc-50 dark:bg-zinc-950 overflow-hidden">
      <NavBar />
      <div className="flex-1 overflow-hidden flex flex-col">
        <CatalogueTable
          signatures={data.signatures}
          months={data.months}
          currentMonth={data.currentMonth}
          isAdmin={data.isAdmin}
          article81Data={data.article81Data}
          profileVersions={data.profileVersions}
          annexeRows={data.annexeRows}
        />
      </div>
    </div>
  );
}
