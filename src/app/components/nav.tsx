'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getAvailableMonths, getRotationsForMonth, type AvailableMonth } from '@/app/actions/search';
import { getScenariosWithItems } from '@/app/actions/planning';
import { getCurrentUserIsAdmin } from '@/app/actions/auth';
import { loadAllProfileVersions } from '@/app/actions/profile-version';
import { loadAllAnnexeRows } from '@/app/actions/annexe';
import { loadAllA81Overrides, loadAllA81YearData } from '@/app/actions/a81';
import { cacheRotations, hydrateDB, cacheProfileVersions, cacheAnnexeRows, cacheA81Overrides, cacheA81YearData } from '@/lib/local-db';
import { syncNow, pendingOpsCount, PENDING_CHANGED_EVENT } from '@/lib/sync-service';
import {
  downloadPlanning, downloadDatabase,
  parseBackupFile, importPlanning, importDatabase, importLegacyBackup,
} from '@/lib/backup';
import { useLocalStorageState } from '@/hooks/use-local-storage-state';
import { useOnlineStatus } from '@/hooks/use-online';

const TABS: { label: string; href: string; offlineDisabled?: boolean }[] = [
  { label: 'Profil',      href: '/profil'     },
  { label: 'Calendrier',  href: '/'           },
  // EP4 nécessite des calculs server-side (raw_detail) — pas dispo offline.
  { label: 'EP4',         href: '/ep4',         offlineDisabled: true },
  { label: 'Catalogue',   href: '/catalogue'  },
  { label: 'Comparatif',  href: '/comparatif' },
  { label: 'A81',         href: '/a81'        },
  { label: 'Annexe',      href: '/annexe'     },
];

const PAGES = ['/', '/ep4', '/catalogue', '/comparatif', '/a81', '/annexe', '/profil', '/login'];
// Pages qui acceptent ?m=YYYY-MM — à précacher en variantes par mois
const PAGES_MONTH = ['/', '/ep4', '/catalogue', '/comparatif'];
const DL_KEY = 'cm-last-download';

// Mode de sync sélective. Lite (défaut) = m + 3 mois suivants en intégralité +
// mois antérieurs filtrés sur les vols posés (drafts A/B/C). Perso = l'user
// coche les mois à télécharger en intégralité, le reste n'est pas téléchargé.
type SyncMode = 'lite' | 'perso';
const SYNC_MODE_KEY    = 'cm-sync-mode';
const SYNC_PERSO_KEY   = 'cm-sync-perso-months';
const DEFAULT_SYNC_MODE: SyncMode = 'lite';

/** "YYYY-MM" + delta mois → "YYYY-MM" (delta peut être négatif). */
function shiftMonthStr(m: string, delta: number): string {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface SyncPlan {
  /** Mois à télécharger en intégralité (toutes les rotations du mois). */
  full: string[];
  /** Mois à télécharger en mode planning_only (uniquement les vols A/B/C posés). */
  planningOnly: string[];
}

function buildSyncPlan(availableMonths: AvailableMonth[], mode: SyncMode, persoMonths: string[]): SyncPlan {
  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const available = new Map(availableMonths.map(a => [a.month, a.is_fictive]));

  if (mode === 'perso') {
    // Perso : on suit la sélection user, fictifs inclus s'ils sont cochés.
    return {
      full:         persoMonths.filter(m => available.has(m)),
      planningOnly: [],
    };
  }

  // Lite : m..m+3 full (HORS fictifs — auto-DL fictifs = off) ;
  // mois < m disponibles → planning_only.
  const liteFull = [0, 1, 2, 3]
    .map(d => shiftMonthStr(currentMonth, d))
    .filter(m => available.has(m) && !available.get(m));
  const liteFullSet = new Set(liteFull);
  const liteOnly = availableMonths
    .filter(a => a.month < currentMonth && !liteFullSet.has(a.month) && !a.is_fictive)
    .map(a => a.month);
  return { full: liteFull, planningOnly: liteOnly };
}

async function waitForSWController(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  if (navigator.serviceWorker.controller) return true;
  await navigator.serviceWorker.ready.catch(() => null);
  if (navigator.serviceWorker.controller) return true;
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(false), 5000);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      clearTimeout(t);
      resolve(true);
    }, { once: true });
  });
}

// Pré-cache : HTML + chunks JS/CSS référencés.
// Lit le body en string puis recrée la Response → évite les soucis de stream consumé.
async function precachePage(url: string): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  try {
    const response = await fetch(url, { credentials: 'include', redirect: 'follow', cache: 'reload' });
    if (!response.ok) return false;
    // Si le serveur a redirigé vers /login (pas authentifié) ou /profil
    // (profil pas encore créé), ne pas cacher la redirection sous l'URL
    // d'origine — sinon l'utilisateur reste piégé après auth/setup du profil.
    // Autoriser le cache explicite de /login et /profil eux-mêmes.
    const redirectedAway =
      (response.url.includes('/login')  && !url.endsWith('/login')) ||
      (response.url.includes('/profil') && !url.endsWith('/profil'));
    if (redirectedAway) return false;
    const ct = response.headers.get('content-type') ?? 'text/html; charset=utf-8';
    if (!ct.includes('html')) return false;

    const html = await response.text();
    const cache = await caches.open('others');
    const cached = new Response(html, {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': ct },
    });
    await cache.put(url, cached);

    // Récupère tous les chunks JS/CSS référencés et les fait passer par le SW
    const resources = new Set<string>();
    for (const m of html.matchAll(/(?:src|href)="(\/_next\/[^"]+)"/g)) {
      resources.add(m[1]);
    }
    await Promise.all(
      [...resources].map(r => fetch(r, { cache: 'reload' }).catch(() => {})),
    );

    // Pré-cache le RSC payload (Next.js soft navigation) — sans cela la
    // navigation entre onglets hors ligne échoue et provoque une page blanche.
    void fetch(url, {
      credentials: 'include',
      cache: 'reload',
      headers: { 'RSC': '1' },
    }).catch(() => {});

    // Vérifie que la page est bien dans le cache
    const verify = await cache.match(url);
    return !!verify;
  } catch { return false; }
}

async function clearAllCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
}

/** Wrap une promesse avec un timeout — résout à `fallback` si dépassé.
 *  Évite que Sync ne se bloque indéfiniment sur un fetch qui hang
 *  (wifi instable, server action lente, etc.). */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(fallback); } }, ms);
    p.then(v => { if (!done) { done = true; clearTimeout(t); resolve(v); } })
     .catch(() => { if (!done) { done = true; clearTimeout(t); resolve(fallback); } });
  });
}

export function NavBar() {
  const path = usePathname();
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'' | 'push' | 'pull' | 'ok' | 'err' | 'offline'>('');
  const [dlProgress, setDlProgress] = useState('');
  const [_swReady, setSwReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [backupMenuOpen, setBackupMenuOpen] = useState(false);
  const [backupStatus, setBackupStatus] = useState('');
  // Statut réseau via useSyncExternalStore (hook dédié) : pas de
  // set-state-in-effect et pas de mismatch d'hydration (SSR snapshot = true).
  const online = useOnlineStatus();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync mode (Lite / Perso) + sélection Perso (mois cochés)
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const [syncMode, setSyncMode] = useLocalStorageState<SyncMode>(
    SYNC_MODE_KEY, DEFAULT_SYNC_MODE,
    raw => (raw === 'lite' || raw === 'perso') ? raw : DEFAULT_SYNC_MODE,
    v => v,
  );
  const [persoMonths, setPersoMonths] = useLocalStorageState<string[]>(SYNC_PERSO_KEY, []);
  const [availableMonths, setAvailableMonths] = useState<AvailableMonth[]>([]);
  async function ensureAvailableMonths() {
    if (availableMonths.length > 0 || !navigator.onLine) return;
    const months = await withTimeout(getAvailableMonths(), 5000, [] as AvailableMonth[]);
    setAvailableMonths(months);
  }
  function persistMode(m: SyncMode) {
    setSyncMode(m);
  }
  function togglePersoMonth(m: string) {
    setPersoMonths(prev => prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m].sort().reverse());
  }

  useEffect(() => {
    void (async () => {
      const ready = await waitForSWController();
      setSwReady(ready);
      if (ready && navigator.onLine) {
        const currentMonth = localStorage.getItem('cm-selected-month')
          ?? new Date().toISOString().slice(0, 7);
        const targets: string[] = [...PAGES];
        for (const p of PAGES_MONTH) targets.push(`${p}?m=${currentMonth}`);
        for (const url of targets) { void precachePage(url); }

        // Hydrate Dexie pour le mois courant : sans ça, premier offline après
        // login = calendrier vide (loadScenariosForMonth retourne null tant
        // que l'user n'a pas cliqué Sync). Best-effort, silencieux, parallèle.
        void (async () => {
          try {
            const [scs, rots] = await Promise.all([
              withTimeout(getScenariosWithItems(currentMonth), 8000, [] as Awaited<ReturnType<typeof getScenariosWithItems>>),
              withTimeout(getRotationsForMonth(currentMonth, 'full'), 12000, [] as Awaited<ReturnType<typeof getRotationsForMonth>>),
            ]);
            await Promise.all([
              scs.length ? hydrateDB(scs, currentMonth) : Promise.resolve(),
              rots.length ? cacheRotations(rots, currentMonth) : Promise.resolve(),
            ]);
          } catch { /* silencieux : Sync explicite ré-essaiera */ }
        })();
      }
    })();
    void getCurrentUserIsAdmin().then(setIsAdmin).catch(() => setIsAdmin(false));
    void pendingOpsCount().then(setPendingCount);
    // Pré-cache silencieux profil + annexe + overrides A81 + year data A81
    // (offline pour A81 + finBase calendrier).
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      void loadAllProfileVersions().then(v => cacheProfileVersions(v)).catch(() => {});
      void loadAllAnnexeRows().then(r => cacheAnnexeRows(r)).catch(() => {});
      void loadAllA81Overrides().then(o => cacheA81Overrides(o)).catch(() => {});
      void loadAllA81YearData().then(y => cacheA81YearData(y)).catch(() => {});
    }
  }, []);

  // Refresh badge quand une op est enqueued ou syncée.
  useEffect(() => {
    const onChange = () => { void pendingOpsCount().then(setPendingCount); };
    window.addEventListener(PENDING_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(PENDING_CHANGED_EVENT, onChange);
  }, []);

  /** PUSH seul : envoie les opérations en attente (sync_queue Dexie) vers
   *  Supabase. Rapide (1 batch). Bouton visible uniquement si pendingCount>0. */
  async function handlePush() {
    if (!navigator.onLine) {
      setSyncStatus('offline');
      setTimeout(() => setSyncStatus(''), 3000);
      return;
    }
    setSyncing(true);
    try {
      setSyncStatus('push');
      await syncNow();
      setPendingCount(0);
      setSyncStatus('ok');
      setTimeout(() => { setSyncStatus(''); router.refresh(); }, 1200);
    } catch {
      setSyncStatus('err');
      setTimeout(() => setSyncStatus(''), 3000);
    } finally {
      setSyncing(false);
      void pendingOpsCount().then(setPendingCount);
    }
  }

  /** PULL : télécharge depuis Supabase et hydrate l'IndexedDB pour les mois
   *  du SyncPlan (Lite ou Perso). Mois traités en PARALLÈLE (Promise.allSettled)
   *  — gain ~5× sur la phase pull par rapport à la boucle séquentielle. */
  async function handlePull() {
    if (!navigator.onLine) {
      setSyncStatus('offline');
      setTimeout(() => setSyncStatus(''), 3000);
      return;
    }
    setSyncing(true);
    try {
      setSyncStatus('pull');
      // Cache profil + annexe + A81 versionnés en parallèle (légers, < 50KB).
      void withTimeout(loadAllProfileVersions(), 5000, [])
        .then(v => cacheProfileVersions(v)).catch(() => {});
      void withTimeout(loadAllAnnexeRows(), 5000, [])
        .then(r => cacheAnnexeRows(r)).catch(() => {});
      void withTimeout(loadAllA81Overrides(), 5000, [])
        .then(o => cacheA81Overrides(o)).catch(() => {});
      void withTimeout(loadAllA81YearData(), 5000, [])
        .then(y => cacheA81YearData(y)).catch(() => {});
      const ready = await waitForSWController();
      if (ready) {
        const months = await withTimeout(getAvailableMonths(), 8000, [] as AvailableMonth[]);
        const mode: SyncMode = (localStorage.getItem(SYNC_MODE_KEY) as SyncMode | null) ?? DEFAULT_SYNC_MODE;
        const persoRaw = localStorage.getItem(SYNC_PERSO_KEY);
        const persoMonthsLs: string[] = (() => {
          try { return JSON.parse(persoRaw ?? '[]') as string[]; } catch { return []; }
        })();
        const plan = buildSyncPlan(months, mode, persoMonthsLs);
        const planningMonths = new Set([...plan.full, ...plan.planningOnly]);
        const queue: Array<{ m: string; loadMode: 'full' | 'planning_only' }> = [
          ...plan.full.map(m => ({ m, loadMode: 'full' as const })),
          ...plan.planningOnly.map(m => ({ m, loadMode: 'planning_only' as const })),
        ];

        // Compteur de progression incrémenté par chaque mois terminé.
        let completed = 0;
        let failed = 0;
        setDlProgress(queue.length > 0 ? `0/${queue.length}` : '');

        const results = await Promise.allSettled(queue.map(async ({ m, loadMode }) => {
          try {
            const [rots, scs] = await Promise.all([
              withTimeout(
                getRotationsForMonth(m, loadMode),
                12000,
                [] as Awaited<ReturnType<typeof getRotationsForMonth>>,
              ),
              planningMonths.has(m)
                ? withTimeout(getScenariosWithItems(m), 8000, [] as Awaited<ReturnType<typeof getScenariosWithItems>>)
                : Promise.resolve([] as Awaited<ReturnType<typeof getScenariosWithItems>>),
            ]);
            if (rots.length === 0 && scs.length === 0) {
              failed++;
              return;
            }
            await withTimeout(
              Promise.all([cacheRotations(rots, m), hydrateDB(scs, m)]),
              8000,
              undefined,
            );
          } finally {
            completed++;
            setDlProgress(`${completed}/${queue.length}`);
          }
        }));
        // Rejections imprévues (hors withTimeout) : compte comme failed.
        for (const r of results) if (r.status === 'rejected') failed++;

        setDlProgress(queue.length > 0 ? `pages` : '');
        const urlVariants: string[] = [];
        const cachedMonths = queue.map(q => q.m);
        for (const url of PAGES) {
          urlVariants.push(url);
          if (PAGES_MONTH.includes(url)) {
            for (const m of cachedMonths) urlVariants.push(`${url}?m=${m}`);
          }
        }
        await Promise.all(urlVariants.map(url => withTimeout(precachePage(url), 10000, false)));
        setDlProgress('');
        if (failed > 0) {
          setSyncStatus('err');
          setTimeout(() => setSyncStatus(''), 4000);
          return;
        }
        localStorage.setItem(DL_KEY, String(Date.now()));
      }
      setSyncStatus('ok');
      setTimeout(() => { setSyncStatus(''); router.refresh(); }, 1500);
    } catch {
      setSyncStatus('err');
      setTimeout(() => setSyncStatus(''), 3000);
    } finally {
      setSyncing(false);
      setDlProgress('');
    }
  }

  async function handleExportPlanning() {
    setBackupMenuOpen(false);
    try {
      await downloadPlanning();
      setBackupStatus('✓ planning exporté');
    } catch (e) {
      setBackupStatus(`! ${String(e)}`);
    } finally {
      setTimeout(() => setBackupStatus(''), 3000);
    }
  }

  async function handleExportDatabase() {
    setBackupMenuOpen(false);
    try {
      await downloadDatabase();
      setBackupStatus('✓ DB exportée');
    } catch (e) {
      setBackupStatus(`! ${String(e)}`);
    } finally {
      setTimeout(() => setBackupStatus(''), 3000);
    }
  }

  async function handleImportBackupFile(file: File) {
    try {
      const text = await file.text();
      const backup = parseBackupFile(text);

      // Format legacy v1 (drafts/items/sync_queue uniquement, sans kind).
      if (!('kind' in backup)) {
        const months = Array.from(new Set(backup.drafts.map(d => d.target_month))).sort().join(', ');
        if (!confirm(`Restaurer le backup legacy ?\n\nMois remplacés : ${months || '(aucun)'}\nItems : ${backup.items.length}\nOps en queue : ${backup.sync_queue.length}\n\nLes autres mois resteront intacts.`)) return;
        const s = await importLegacyBackup(backup);
        setBackupStatus(`✓ ${s.itemsImported} items restaurés`);
        router.refresh();
        return;
      }

      if (backup.kind === 'planning') {
        const months = Array.from(new Set(backup.drafts.map(d => d.target_month))).sort().join(', ');
        const ok = confirm(
          `Restaurer le PLANNING (remplace tout) ?\n\n` +
          `Mois : ${months || '(aucun)'}\n` +
          `Items : ${backup.items.length}\n` +
          `Notes : ${backup.notes.length}\n` +
          `Ops en queue : ${backup.sync_queue.length}\n` +
          `Profil (versions) : ${backup.profile_versions.length}\n` +
          `A81 overrides : ${backup.a81_overrides.length}\n` +
          `A81 années : ${backup.a81_year_data.length}\n\n` +
          `⚠ Toutes les données perso actuelles seront écrasées.`,
        );
        if (!ok) return;
        const s = await importPlanning(backup);
        setBackupStatus(`✓ planning restauré (${s.items} items, ${s.notes} notes)`);
        router.refresh();
        return;
      }

      if (backup.kind === 'database') {
        const ok = confirm(
          `Restaurer la DATABASE (remplace tout) ?\n\n` +
          `Rotations : ${backup.rotations.length}\n` +
          `Releases chiffrées : ${backup.releases.length}\n` +
          `Annexe (rows versionnées) : ${backup.annexe_rows.length}\n\n` +
          `⚠ Tout le cache catalogue actuel sera écrasé.`,
        );
        if (!ok) return;
        const s = await importDatabase(backup);
        setBackupStatus(`✓ DB restaurée (${s.rotations} rotations, ${s.months.length} mois)`);
        router.refresh();
        return;
      }
    } catch (e) {
      setBackupStatus(`! ${String(e)}`);
    } finally {
      setTimeout(() => setBackupStatus(''), 4000);
    }
  }

  async function handleReset() {
    // Bloque le clear si des changements locaux n'ont pas encore été syncés :
    // le clear ne touche pas la queue Dexie mais le reload affichera l'état
    // serveur avant que la queue ne soit rejouée — risque visuel de "revert".
    const pending = await pendingOpsCount();
    if (pending > 0) {
      const proceed = confirm(
        `${pending} modification${pending > 1 ? 's' : ''} non synchronisée${pending > 1 ? 's' : ''}.\n\n` +
        `Vider le cache maintenant peut faire réapparaître des items supprimés (l'écran sera rechargé depuis le serveur avant que la queue ne soit rejouée).\n\n` +
        `Lance d'abord un Sync. Vider quand même ?`,
      );
      if (!proceed) return;
    }
    const offlineWarn = !navigator.onLine
      ? '\n\n⚠ Vous êtes hors ligne : l\'app risque d\'être inutilisable jusqu\'à la prochaine connexion. Continuer quand même ?'
      : '\n\nSi la connexion est instable, l\'app peut devenir partiellement inutilisable jusqu\'à la prochaine bonne connexion.';
    if (!confirm(`Vider tout le cache et recharger l'app ?${offlineWarn}`)) return;
    await clearAllCaches();
    localStorage.removeItem(DL_KEY);
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    window.location.reload();
  }

  const syncColor = syncStatus === 'ok'
    ? 'text-emerald-500'
    : syncStatus === 'err' || syncStatus === 'offline'
    ? 'text-red-500'
    : 'text-zinc-400 hover:text-zinc-100';

  return (
    <div className="bg-zinc-900 border-b border-zinc-700 flex-shrink-0" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <nav className="flex items-center h-8 px-3 gap-1 overflow-x-auto">
        {TABS.map(tab => {
          const active = tab.href === '/'
            ? path === '/'
            : path.startsWith(tab.href);
          const disabled = tab.offlineDisabled && !online;
          if (disabled) {
            return (
              <span
                key={tab.href}
                title="Indisponible hors ligne"
                className="px-4 h-8 flex items-center text-sm font-medium rounded whitespace-nowrap text-zinc-600 line-through cursor-not-allowed select-none"
              >
                {tab.label}
              </span>
            );
          }
          return (
            <a
              key={tab.href}
              href={tab.href}
              className={[
                'px-4 h-8 flex items-center text-sm font-medium rounded transition-colors whitespace-nowrap',
                active ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800',
              ].join(' ')}
            >
              {tab.label}
            </a>
          );
        })}
        {isAdmin && (
          <a
            href="/admin"
            className={[
              'px-4 h-8 flex items-center text-sm font-medium rounded transition-colors whitespace-nowrap',
              path.startsWith('/admin') ? 'bg-amber-700 text-white' : 'text-amber-400 hover:text-amber-200 hover:bg-zinc-800',
            ].join(' ')}
            title="Administration (whitelist + outils)"
          >
            Admin
          </a>
        )}
        <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
          {/* PUSH — visible uniquement s'il y a des modifs locales en queue.
              Cloud-upload : envoie les changements locaux vers Supabase. */}
          {pendingCount > 0 && (
            <button
              onClick={handlePush}
              disabled={syncing}
              title={
                syncStatus === 'offline' ? 'Pas de réseau'
                : syncStatus === 'push'  ? 'Envoi des modifications…'
                : `${pendingCount} modification(s) en attente — envoyer maintenant`
              }
              className={`relative px-2 h-8 flex items-center gap-1 text-sm font-medium disabled:opacity-50 rounded hover:bg-zinc-800 transition-colors ${syncStatus === 'push' ? 'text-amber-400' : syncColor || 'text-zinc-300'}`}
            >
              {/* Cloud-upload : nuage + flèche vers le haut */}
              <svg
                className={`w-5 h-5 ${syncStatus === 'push' ? 'animate-pulse' : ''}`}
                viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                <line x1="12" y1="19" x2="12" y2="11" />
                <polyline points="9 14 12 11 15 14" />
              </svg>
              <span className="absolute -top-1 -right-1 min-w-[16px] h-4 flex items-center justify-center rounded-full bg-amber-500 text-white text-[9px] font-bold px-1">
                {pendingCount}
              </span>
            </button>
          )}

          {/* PULL — télécharge depuis Supabase + pré-cache pages. Toujours visible.
              Icône : flèches circulaires (refresh universel). */}
          <button
            onClick={handlePull}
            disabled={syncing}
            title={
              syncStatus === 'offline' ? 'Pas de réseau'
              : syncStatus === 'pull'  ? 'Téléchargement…'
              : syncStatus === 'ok'    ? 'Synchronisé'
              : syncStatus === 'err'   ? 'Erreur de synchronisation'
              : 'Actualiser depuis le cloud'
            }
            className={`relative px-2 h-8 flex items-center gap-1 text-sm font-medium disabled:opacity-50 rounded hover:bg-zinc-800 transition-colors ${syncStatus === 'pull' ? 'text-blue-400' : syncColor || 'text-zinc-300'}`}
          >
            <svg
              className={`w-5 h-5 ${syncStatus === 'pull' ? 'animate-spin' : ''}`}
              style={{ animationDuration: '2s' }}
              viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            {syncStatus === 'ok' && <span className="text-xs">✓</span>}
            {(syncStatus === 'err' || syncStatus === 'offline') && <span className="text-xs">!</span>}
            {dlProgress && <span className="font-mono text-[10px]">{dlProgress}</span>}
          </button>
          {/* Sélecteur Lite / Perso */}
          <div className="relative">
            <button
              onClick={() => { setSyncMenuOpen(o => !o); void ensureAvailableMonths(); }}
              title={syncMode === 'lite' ? 'Sync Lite : mois courant +3 + planning posé sur mois passés' : 'Sync Perso : mois sélectionnés'}
              className="px-2 h-6 flex items-center gap-1 text-[10px] uppercase tracking-wide font-semibold text-zinc-300 border border-zinc-600 hover:border-zinc-400 hover:text-white rounded transition-colors"
            >
              {syncMode === 'lite' ? 'Lite' : `Perso${persoMonths.length ? ` (${persoMonths.length})` : ''}`}
              <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            {syncMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setSyncMenuOpen(false)} />
                <div
                  className="fixed right-2 z-50 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg p-3 min-w-64"
                  style={{ top: 'calc(env(safe-area-inset-top) + 2.5rem)' }}
                >
                  <p className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200 mb-2">Mode de synchronisation</p>
                  <label className="flex items-start gap-2 text-xs text-zinc-700 dark:text-zinc-200 mb-2 cursor-pointer">
                    <input type="radio" name="syncmode" checked={syncMode === 'lite'} onChange={() => persistMode('lite')} className="mt-0.5" />
                    <span>
                      <span className="font-semibold">Lite</span>
                      <span className="block text-[10px] text-zinc-400">mois courant + 3 suivants en entier · mois passés filtrés sur vos vols posés (A/B/C)</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-xs text-zinc-700 dark:text-zinc-200 cursor-pointer">
                    <input type="radio" name="syncmode" checked={syncMode === 'perso'} onChange={() => persistMode('perso')} className="mt-0.5" />
                    <span>
                      <span className="font-semibold">Perso</span>
                      <span className="block text-[10px] text-zinc-400">téléchargez uniquement les mois cochés (intégralité)</span>
                    </span>
                  </label>
                  {syncMode === 'perso' && (
                    <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-700">
                      <p className="text-[10px] text-zinc-500 mb-1.5">Mois à télécharger :</p>
                      <div className="max-h-56 overflow-y-auto space-y-0.5">
                        {availableMonths.length === 0 && (
                          <p className="text-[10px] italic text-zinc-400">Chargement…</p>
                        )}
                        {availableMonths.map(({ month: m, is_fictive }) => (
                          <label key={m} className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-200 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-700 px-1.5 py-1 rounded">
                            <input
                              type="checkbox"
                              checked={persoMonths.includes(m)}
                              onChange={() => togglePersoMonth(m)}
                            />
                            <span className="font-mono">{m}</span>
                            {is_fictive && (
                              <span className="text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                                Projection
                              </span>
                            )}
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          <div className="relative">
            <button
              onClick={() => setBackupMenuOpen(o => !o)}
              title="Sauvegarder / Restaurer le planning depuis l'iPad"
              className="px-2 h-8 flex items-center text-sm text-zinc-500 hover:text-zinc-300 rounded hover:bg-zinc-800 transition-colors"
            >
              {/* Disquette */}
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
            </button>
            {backupMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setBackupMenuOpen(false)} />
                <div
                  className="fixed right-2 z-50 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 min-w-72"
                  style={{ top: 'calc(env(safe-area-inset-top) + 2.5rem)' }}
                >
                  <p className="px-4 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide font-semibold text-zinc-500">Planning (perso)</p>
                  <button
                    onClick={handleExportPlanning}
                    className="block w-full text-left px-4 py-2 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700"
                  >
                    Sauvegarder le planning (.json)
                  </button>
                  <p className="px-4 pt-2 pb-0.5 text-[10px] uppercase tracking-wide font-semibold text-zinc-500 border-t border-zinc-100 dark:border-zinc-700">Database (catalogue)</p>
                  <button
                    onClick={handleExportDatabase}
                    className="block w-full text-left px-4 py-2 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700"
                  >
                    Sauvegarder la DB (.json)
                  </button>
                  <div className="border-t border-zinc-100 dark:border-zinc-700 mt-1">
                    <button
                      onClick={() => { setBackupMenuOpen(false); fileInputRef.current?.click(); }}
                      className="block w-full text-left px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700"
                    >
                      Restaurer depuis un fichier…
                    </button>
                  </div>
                  <p className="px-4 py-1.5 text-[10px] text-zinc-400 border-t border-zinc-100 dark:border-zinc-700">
                    Restaure planning OU database selon le fichier. Une restauration
                    écrase intégralement la catégorie correspondante.
                  </p>
                </div>
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) void handleImportBackupFile(f);
                e.target.value = '';
              }}
            />
          </div>
          {backupStatus && (
            <span className={`text-[10px] font-mono ${backupStatus.startsWith('✓') ? 'text-emerald-500' : 'text-red-500'}`}>
              {backupStatus}
            </span>
          )}
          <button
            onClick={handleReset}
            title="Vider le cache et recharger l'app"
            className="px-2 h-8 flex items-center text-sm text-zinc-500 hover:text-red-400 rounded hover:bg-zinc-800 transition-colors"
          >
            {/* Corbeille — clarifier "delete cache" vs le bouton Pull voisin
                qui utilise aussi des flèches circulaires. */}
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </nav>
    </div>
  );
}
