'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getAvailableMonths, getRotationsForMonth, type AvailableMonth } from '@/app/actions/search';
import { getScenariosWithItems } from '@/app/actions/planning';
import { getCurrentUserIsAdmin } from '@/app/actions/auth';
import { loadAllProfileVersions } from '@/app/actions/profile-version';
import { loadAllAnnexeRows } from '@/app/actions/annexe';
import { loadAllA81Overrides, loadAllA81YearData } from '@/app/actions/a81';
import { getTauxApp } from '@/app/actions/ep4';
import { cacheRotations, hydrateDB, cacheProfileVersions, cacheAnnexeRows, cacheA81Overrides, cacheA81YearData, cacheTauxApp } from '@/lib/local-db';
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
  // EP4 offline-first depuis 2026-06-17 (raw_detail + taux_app cachés en Dexie).
  { label: 'EP4',         href: '/ep4'        },
  { label: 'Catalogue',   href: '/catalogue'  },
  { label: 'Comparatif',  href: '/comparatif' },
  { label: 'A81',         href: '/a81'        },
  { label: 'Annexe',      href: '/annexe'     },
];

const PAGES = ['/', '/ep4', '/catalogue', '/comparatif', '/a81', '/annexe', '/profil', '/login'];
// Pages qui acceptent ?m=YYYY-MM — à précacher en variantes par mois
const PAGES_MONTH = ['/', '/ep4', '/catalogue', '/comparatif'];
const DL_KEY = 'cm-last-download';
/** Flag sessionStorage : "le priming Dexie a déjà tourné dans cette session
 *  de PWA". Évite de re-fetcher/re-cacher les rotations à chaque page-mount.
 *  Auto-remis à zéro quand l'onglet/PWA est tué (sessionStorage isolé par
 *  contexte). */
const PRIMING_DONE_KEY = 'cm-priming-done';

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
/** Sentinel pour debug : capture timeout/reject avec label. Sans `opts`, comportement
 *  identique à avant (fallback silencieux). Avec `opts.label`, log console + appel
 *  `opts.onError` pour qu'on remonte la cause réelle dans l'UI (pas de Mac pour
 *  Web Inspector iPad). */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  fallback: T,
  opts?: { label?: string; onError?: (kind: 'timeout' | 'reject', err: unknown) => void },
): Promise<T> {
  return new Promise<T>(resolve => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        if (opts?.label) console.warn(`[sync] timeout ${ms}ms`, opts.label);
        opts?.onError?.('timeout', new Error(`timeout ${ms}ms`));
        resolve(fallback);
      }
    }, ms);
    p.then(v => { if (!done) { done = true; clearTimeout(t); resolve(v); } })
     .catch(e => {
       if (!done) {
         done = true; clearTimeout(t);
         if (opts?.label) console.warn(`[sync] reject`, opts.label, e);
         opts?.onError?.('reject', e);
         resolve(fallback);
       }
     });
  });
}

/** Pool de workers à concurrence bornée — sans cette borne, un Pull avec 12+
 *  mois lance autant de requêtes en parallèle, sature la bande passante mobile
 *  et déclenche des timeouts silencieux (mois jamais hydratés → écran 📵 hors
 *  ligne). 4 simultanées = compromis débit / fiabilité. */
async function runPool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      const i = cursor++;
      try { out[i] = await tasks[i](); }
      catch { /* erreurs gérées dans la task elle-même (failed++) */ }
    }
  }
  const n = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
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
  // Debug sync iPad sans Mac : on capture les rejects/timeouts de chaque mois
  // pour les afficher dans le `title` du bouton Pull (visible via long-press
  // sur iPad). Persisté dans localStorage pour relecture ultérieure.
  const [lastSyncErrors, setLastSyncErrors] = useState<Array<{ label: string; kind: 'timeout' | 'reject'; msg: string }>>(() => {
    if (typeof localStorage === 'undefined') return [];
    try { return JSON.parse(localStorage.getItem('cm-sync-last-errors') ?? '[]'); } catch { return []; }
  });
  function persistSyncErrors(errs: Array<{ label: string; kind: 'timeout' | 'reject'; msg: string }>) {
    setLastSyncErrors(errs);
    try { localStorage.setItem('cm-sync-last-errors', JSON.stringify(errs)); } catch { /* quota */ }
  }
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
      }
    })();
    void getCurrentUserIsAdmin().then(setIsAdmin).catch(() => setIsAdmin(false));
    void pendingOpsCount().then(setPendingCount);

    // ─── Priming Dexie ──────────────────────────────────────────────────────
    // Gardé "une fois par session de PWA" : sessionStorage flag. Sans ça, chaque
    // page-mount remonte NavBar → re-déclenche le priming → cacheRotations en
    // boucle → rw lock sur db.rotations qui bloque les reads du calendrier
    // (= page blanche "Chargement…" quand on navigue profil → /). Cf bug
    // observé 2026-06-17 (B). Déferré via requestIdleCallback pour ne PAS
    // tourner en plein milieu d'une transition de route.
    if (typeof window === 'undefined' || !navigator.onLine) return;
    if (sessionStorage.getItem(PRIMING_DONE_KEY) === '1') return;

    const runPriming = () => {
      sessionStorage.setItem(PRIMING_DONE_KEY, '1');
      const currentMonth = localStorage.getItem('cm-selected-month')
        ?? new Date().toISOString().slice(0, 7);
      // Hydrate Dexie pour le mois courant : sans ça, premier offline après
      // login = calendrier vide (loadScenariosForMonth retourne null tant
      // que l'user n'a pas cliqué Sync).
      void (async () => {
        try {
          const [scs, rots] = await Promise.all([
            withTimeout(getScenariosWithItems(currentMonth), 8000, [] as Awaited<ReturnType<typeof getScenariosWithItems>>),
            withTimeout(getRotationsForMonth(currentMonth, 'full'), 12000, [] as Awaited<ReturnType<typeof getRotationsForMonth>>),
          ]);
          if (scs.length) await hydrateDB(scs, currentMonth);
          if (rots.length) await cacheRotations(rots, currentMonth);
        } catch { /* silencieux : Sync explicite ré-essaiera */ }
      })();
      // Pré-cache silencieux profil + annexe + overrides A81 + year data A81
      // (offline pour A81 + finBase calendrier) + taux_app (offline pour EP4).
      void loadAllProfileVersions().then(v => cacheProfileVersions(v)).catch(() => {});
      void loadAllAnnexeRows().then(r => cacheAnnexeRows(r)).catch(() => {});
      void loadAllA81Overrides().then(o => cacheA81Overrides(o)).catch(() => {});
      void loadAllA81YearData().then(y => cacheA81YearData(y)).catch(() => {});
      void getTauxApp()
        .then(t => {
          console.warn(`[priming] taux_app reçu : ${t.length} rows`);
          return cacheTauxApp(t);
        })
        .catch(e => { console.warn('[priming] taux_app erreur', e); });
    };

    type RIC = (cb: () => void, opts?: { timeout: number }) => number;
    const ric = (window as unknown as { requestIdleCallback?: RIC }).requestIdleCallback;
    if (typeof ric === 'function') ric(runPriming, { timeout: 3000 });
    else setTimeout(runPriming, 600);
  }, []);

  // Refresh badge quand une op est enqueued ou syncée.
  useEffect(() => {
    const onChange = () => { void pendingOpsCount().then(setPendingCount); };
    window.addEventListener(PENDING_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(PENDING_CHANGED_EVENT, onChange);
  }, []);

  // ─── Détection nouvelle version (PWA update available) ─────────────────────
  // sw.js a skipWaiting+clientsClaim → quand un nouveau SW s'installe il prend
  // le contrôle immédiatement et `controllerchange` fire. Si l'onglet avait
  // déjà un controller au chargement, ça signifie qu'une nouvelle version est
  // active mais que le bundle JS en mémoire est l'ancien → on propose un
  // reload via un bandeau (l'utilisateur n'a plus besoin de "Vider cache").
  const [updateAvailable, setUpdateAvailable] = useState(false);
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const hadController = !!navigator.serviceWorker.controller;
    const onCtrlChange = () => { if (hadController) setUpdateAvailable(true); };
    navigator.serviceWorker.addEventListener('controllerchange', onCtrlChange);

    let intervalId: ReturnType<typeof setInterval> | null = null;
    let onFocus: (() => void) | null = null;
    void navigator.serviceWorker.getRegistration().then(reg => {
      if (!reg) return;
      // SW déjà en waiting au moment où le listener s'installe (cas où la
      // détection a eu lieu avant le mount).
      if (reg.waiting && hadController) setUpdateAvailable(true);
      // Poll régulier (15 min) + check au focus pour détecter rapidement les
      // déploiements quand l'app reste ouverte longtemps.
      intervalId = setInterval(() => { void reg.update().catch(() => {}); }, 15 * 60 * 1000);
      onFocus = () => { void reg.update().catch(() => {}); };
      window.addEventListener('focus', onFocus);
    });
    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onCtrlChange);
      if (intervalId) clearInterval(intervalId);
      if (onFocus) window.removeEventListener('focus', onFocus);
    };
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
    // Collecte des erreurs par op pour affichage in-app (dropdown debug).
    const collectedErrors: Array<{ label: string; kind: 'timeout' | 'reject'; msg: string }> = [];
    try {
      setSyncStatus('push');
      await syncNow({
        onOpError: (op, e) => {
          collectedErrors.push({
            label: `${op.op}#${op.id ?? '?'}`,
            kind: 'reject',
            msg: String((e as Error)?.message ?? e),
          });
        },
      });
      setPendingCount(0);
      setSyncStatus('ok');
      persistSyncErrors(collectedErrors);
      setTimeout(() => { setSyncStatus(''); router.refresh(); }, 1200);
    } catch (e) {
      // syncNow throw uniquement si au moins 1 op a échoué — l'erreur a déjà
      // été captée via onOpError. On garde la trace au cas où.
      if (collectedErrors.length === 0) {
        collectedErrors.push({ label: 'syncNow', kind: 'reject', msg: String((e as Error)?.message ?? e) });
      }
      persistSyncErrors(collectedErrors);
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
    // Reset des erreurs capturées : on n'affiche que celles de la session en cours.
    const collectedErrors: Array<{ label: string; kind: 'timeout' | 'reject'; msg: string }> = [];
    const captureErr = (label: string) => (kind: 'timeout' | 'reject', err: unknown) => {
      collectedErrors.push({ label, kind, msg: String((err as Error)?.message ?? err) });
    };
    try {
      setSyncStatus('pull');
      // Cache profil + annexe + A81 versionnés + taux_app en parallèle
      // (légers, < 50KB chacun). taux_app indispensable pour EP4 offline
      // (`loadEp4DetailLocal` retourne null sans, → tableau champ/valeur
      // limité à la ligne Rotation).
      void withTimeout(loadAllProfileVersions(), 5000, [], { label: 'profileVersions', onError: captureErr('profileVersions') })
        .then(v => cacheProfileVersions(v)).catch(() => {});
      void withTimeout(loadAllAnnexeRows(), 5000, [], { label: 'annexeRows', onError: captureErr('annexeRows') })
        .then(r => cacheAnnexeRows(r)).catch(() => {});
      void withTimeout(loadAllA81Overrides(), 5000, [], { label: 'a81Overrides', onError: captureErr('a81Overrides') })
        .then(o => cacheA81Overrides(o)).catch(() => {});
      void withTimeout(loadAllA81YearData(), 5000, [], { label: 'a81YearData', onError: captureErr('a81YearData') })
        .then(y => cacheA81YearData(y)).catch(() => {});
      void withTimeout(getTauxApp(), 15000, [], { label: 'tauxApp', onError: captureErr('tauxApp') })
        .then(t => {
          console.warn(`[sync] taux_app reçu : ${t.length} rows`);
          return cacheTauxApp(t);
        }).catch(e => { console.warn('[sync] taux_app cache erreur', e); });
      const ready = await waitForSWController();
      if (ready) {
        const months = await withTimeout(getAvailableMonths(), 8000, [] as AvailableMonth[], { label: 'availableMonths', onError: captureErr('availableMonths') });
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

        // Concurrence bornée : 12 mois en parallèle saturent le mobile et
        // déclenchent des timeouts silencieux → mois jamais hydratés.
        let completed = 0;
        let failed = 0;
        const cachedMonths: string[] = [];
        setDlProgress(queue.length > 0 ? `0/${queue.length}` : '');

        const tasks = queue.map(({ m, loadMode }) => async () => {
          try {
            // Sentinel `null` pour distinguer timeout (échec réel) de résultat
            // vide légitime (mois sans rotations/items).
            const [rots, scs] = await Promise.all([
              withTimeout(
                getRotationsForMonth(m, loadMode),
                25000,
                null as Awaited<ReturnType<typeof getRotationsForMonth>> | null,
                { label: `rotations:${m}`, onError: captureErr(`rotations:${m}`) },
              ),
              planningMonths.has(m)
                ? withTimeout(
                    getScenariosWithItems(m),
                    20000,
                    null as Awaited<ReturnType<typeof getScenariosWithItems>> | null,
                    { label: `scenarios:${m}`, onError: captureErr(`scenarios:${m}`) },
                  )
                : Promise.resolve([] as Awaited<ReturnType<typeof getScenariosWithItems>>),
            ]);
            if (rots === null || scs === null) {
              // Timeout sur au moins l'un des deux fetchs.
              failed++;
              return;
            }
            // Mois légitimement vide (aucune rotation cataloguée + drafts vides) :
            // ce n'est PAS un échec, mais on ne le marque pas non plus cached.
            if (rots.length === 0 && scs.length === 0) {
              cachedMonths.push(m);
              return;
            }
            const writeOk = await withTimeout(
              Promise.all([cacheRotations(rots, m), hydrateDB(scs, m)])
                .then(() => true),
              10000,
              false,
              { label: `write:${m}`, onError: captureErr(`write:${m}`) },
            );
            if (writeOk) cachedMonths.push(m);
            else failed++;
          } finally {
            completed++;
            setDlProgress(`${completed}/${queue.length}`);
          }
        });
        await runPool(tasks, 4);

        setDlProgress(queue.length > 0 ? `pages` : '');
        // On ne précache l'URL ?m=YYYY-MM que pour les mois effectivement
        // hydratés — sinon l'utilisateur clique offline sur un onglet, voit
        // l'écran s'afficher (HTML précaché) mais le calendrier reste vide.
        const urlVariants: string[] = [];
        for (const url of PAGES) {
          urlVariants.push(url);
          if (PAGES_MONTH.includes(url)) {
            for (const m of cachedMonths) urlVariants.push(`${url}?m=${m}`);
          }
        }
        const precacheTasks = urlVariants.map(url => () => withTimeout(
          precachePage(url), 10000, false,
          { label: `precache:${url}`, onError: captureErr(`precache:${url}`) },
        ));
        await runPool(precacheTasks, 6);
        if (failed > 0) {
          // Affiche le nombre de mois en échec — sinon le user voit juste un
          // "!" fugace et croit que tout est OK alors qu'il y a des trous.
          setDlProgress(`${failed} échec${failed > 1 ? 's' : ''}`);
          setSyncStatus('err');
          persistSyncErrors(collectedErrors);
          setTimeout(() => { setSyncStatus(''); setDlProgress(''); }, 5000);
          return;
        }
        setDlProgress('');
        localStorage.setItem(DL_KEY, String(Date.now()));
      }
      setSyncStatus('ok');
      persistSyncErrors(collectedErrors);
      setTimeout(() => { setSyncStatus(''); router.refresh(); }, 1500);
    } catch (e) {
      collectedErrors.push({ label: 'handlePull', kind: 'reject', msg: String((e as Error)?.message ?? e) });
      persistSyncErrors(collectedErrors);
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

  // Modale "Vider cache" — on évite confirm() natif qui ne s'affiche pas
  // toujours en PWA iPad/iOS standalone (bug connu Safari).
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resetPendingCount, setResetPendingCount] = useState(0);
  async function handleReset() {
    const pending = await pendingOpsCount();
    setResetPendingCount(pending);
    setResetModalOpen(true);
  }
  async function performReset() {
    setResetModalOpen(false);
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
              : syncStatus === 'err'   ? (lastSyncErrors.length > 0
                  ? `Erreur sync — ${lastSyncErrors.length} échec(s) :\n${lastSyncErrors.slice(0, 5).map(e => `• ${e.kind} ${e.label} — ${e.msg}`).join('\n')}${lastSyncErrors.length > 5 ? `\n+${lastSyncErrors.length - 5} autres` : ''}`
                  : 'Erreur de synchronisation')
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
                  {/* Debug : derniers échecs du sync (capté par withTimeout). Permet
                      de diagnostiquer sur iPad sans Web Inspector. */}
                  {lastSyncErrors.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-700">
                      <div className="flex items-center justify-between mb-1.5">
                        <p className="text-[10px] font-semibold text-red-600 dark:text-red-400">
                          {lastSyncErrors.length} échec{lastSyncErrors.length > 1 ? 's' : ''} au dernier sync
                        </p>
                        <button
                          onClick={() => persistSyncErrors([])}
                          className="text-[10px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                        >
                          Effacer
                        </button>
                      </div>
                      <div className="max-h-40 overflow-y-auto space-y-1">
                        {lastSyncErrors.map((e, i) => (
                          <div key={i} className="text-[10px] font-mono bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 px-1.5 py-1 rounded">
                            <span className="font-semibold">{e.kind}</span> · {e.label}
                            <div className="text-red-600/80 dark:text-red-400/80 break-all">{e.msg}</div>
                          </div>
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
            title={updateAvailable
              ? 'Nouvelle version disponible — recharger l\'app'
              : 'Vider le cache et recharger l\'app'}
            className="relative px-2 h-8 flex items-center text-sm text-zinc-500 hover:text-red-400 rounded hover:bg-zinc-800 transition-colors"
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
            {/* Point bleu discret = nouvelle version disponible. Cliquer la
                corbeille (wipe + reload) charge la nouvelle version. */}
            {updateAvailable && (
              <span
                className="absolute top-1 right-1 w-2 h-2 rounded-full bg-blue-500 ring-2 ring-zinc-900"
                aria-label="Nouvelle version disponible"
              />
            )}
          </button>

          {/* Modale custom Vider cache — remplace confirm() natif qui ne
              s'affiche pas fiablement en PWA iPad standalone. */}
          {resetModalOpen && (
            <>
              <div className="fixed inset-0 z-[60] bg-black/40" onClick={() => setResetModalOpen(false)} />
              <div className="fixed inset-x-4 top-1/2 -translate-y-1/2 z-[61] max-w-sm mx-auto bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl p-5 space-y-4">
                <h2 className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">
                  {updateAvailable ? 'Charger la nouvelle version ?' : 'Recharger l\'app ?'}
                </h2>
                {resetPendingCount > 0 && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                    ⚠ {resetPendingCount} modification{resetPendingCount > 1 ? 's' : ''} non synchronisée{resetPendingCount > 1 ? 's' : ''}.
                    Lance Push d&apos;abord pour ne pas risquer de les perdre visuellement.
                  </p>
                )}
                <p className="text-xs text-zinc-600 dark:text-zinc-300">
                  Le cache local va être vidé et l&apos;app rechargée
                  {updateAvailable ? ' avec la dernière version disponible.' : '.'}
                </p>
                {!online && (
                  <p className="text-xs text-red-500">
                    ⚠ Vous êtes hors ligne : l&apos;app risque d&apos;être inutilisable jusqu&apos;à la prochaine connexion.
                  </p>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => setResetModalOpen(false)}
                    className="flex-1 py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 text-sm font-semibold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  >
                    Annuler
                  </button>
                  <button
                    onClick={performReset}
                    className="flex-1 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-700 dark:bg-zinc-100 dark:hover:bg-zinc-300 text-white dark:text-zinc-900 text-sm font-semibold"
                  >
                    Confirmer
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </nav>
    </div>
  );
}
