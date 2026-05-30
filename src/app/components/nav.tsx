'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getAvailableMonths, getRotationsForMonth } from '@/app/actions/search';
import { getScenariosWithItems } from '@/app/actions/planning';
import { getCurrentUserIsAdmin } from '@/app/actions/auth';
import { loadAllProfileVersions } from '@/app/actions/profile-version';
import { loadAllAnnexeRows } from '@/app/actions/annexe';
import { cacheRotations, hydrateDB, cacheProfileVersions, cacheAnnexeRows } from '@/lib/local-db';
import { syncNow, pendingOpsCount } from '@/lib/sync-service';
import { downloadBackup, parseBackup, importBackup } from '@/lib/backup';

const TABS: { label: string; href: string; offlineDisabled?: boolean }[] = [
  { label: 'Profil',      href: '/profil'     },
  { label: 'Calendrier',  href: '/'           },
  // EP4 nécessite des calculs server-side (raw_detail) — pas dispo offline.
  { label: 'EP4',         href: '/ep4',         offlineDisabled: true },
  { label: 'Catalogue',   href: '/catalogue'  },
  { label: 'Comparatif',  href: '/comparatif' },
  // A81 server-side (lit raw_detail des signatures + profile versions) — pas offline pour l'instant.
  { label: 'A81',         href: '/a81',         offlineDisabled: true },
  { label: 'Annexe',      href: '/annexe'     },
];

const PAGES = ['/', '/ep4', '/catalogue', '/comparatif', '/a81', '/annexe', '/profil', '/login'];
// Pages qui acceptent ?m=YYYY-MM — à précacher en variantes par mois
const PAGES_MONTH = ['/', '/ep4', '/catalogue', '/comparatif'];
const DL_KEY = 'cm-last-download';

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
    // Si l'on demande une page protégée et que le serveur a redirigé vers /login,
    // ne pas cacher ce contenu sous l'URL d'origine. Mais autoriser le cache
    // explicite de /login lui-même.
    if (response.url.includes('/login') && !url.endsWith('/login')) return false;
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
  const [swReady, setSwReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [backupMenuOpen, setBackupMenuOpen] = useState(false);
  const [backupStatus, setBackupStatus] = useState('');
  const [online, setOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    // Pré-cache silencieux profil + annexe (offline pour A81 + finBase calendrier).
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      void loadAllProfileVersions().then(v => cacheProfileVersions(v)).catch(() => {});
      void loadAllAnnexeRows().then(r => cacheAnnexeRows(r)).catch(() => {});
    }
  }, []);

  // Suit l'état réseau pour griser les onglets offlineDisabled (EP4).
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  async function handleSync() {
    if (!navigator.onLine) {
      setSyncStatus('offline');
      setTimeout(() => setSyncStatus(''), 3000);
      return;
    }
    setSyncing(true);
    try {
      // 1. Push les opérations en attente vers Supabase
      const pending = await pendingOpsCount();
      if (pending > 0) {
        setSyncStatus('push');
        await syncNow();
        setPendingCount(0);
      }
      // 2. Pull toutes les données depuis Supabase
      setSyncStatus('pull');
      // Cache profil + annexe versionnés (légers — quelques rows, < 50KB).
      // Indispensables pour le compute offline (calendrier finBase, page A81).
      void withTimeout(loadAllProfileVersions(), 5000, [])
        .then(v => cacheProfileVersions(v)).catch(() => {});
      void withTimeout(loadAllAnnexeRows(), 5000, [])
        .then(r => cacheAnnexeRows(r)).catch(() => {});
      const ready = await waitForSWController();
      if (ready) {
        const months = await withTimeout(getAvailableMonths(), 8000, [] as string[]);
        let failed = 0;
        for (let i = 0; i < months.length; i++) {
          const m = months[i];
          // Sub-progress par phase pour qu'on sache où ça bloque.
          setDlProgress(`${i + 1}/${months.length} rot`);
          const rots = await withTimeout(getRotationsForMonth(m), 12000, [] as Awaited<ReturnType<typeof getRotationsForMonth>>);
          setDlProgress(`${i + 1}/${months.length} scn`);
          const scs  = await withTimeout(getScenariosWithItems(m), 8000, [] as Awaited<ReturnType<typeof getScenariosWithItems>>);
          if (rots.length === 0 && scs.length === 0) { failed++; continue; }
          setDlProgress(`${i + 1}/${months.length} db`);
          // Dexie transactions peuvent bloquer (autre onglet, IDB locked, etc.) :
          // timeout 8s pour ne pas figer tout le sync. Si timeout : on continue,
          // le mois sera re-tenté au prochain Sync.
          await withTimeout(
            Promise.all([cacheRotations(rots, m), hydrateDB(scs, m)]),
            8000,
            undefined,
          );
        }
        setDlProgress(months.length > 0 ? `pages` : '');
        const urlVariants: string[] = [];
        for (const url of PAGES) {
          urlVariants.push(url);
          if (PAGES_MONTH.includes(url)) {
            for (const m of months) urlVariants.push(`${url}?m=${m}`);
          }
        }
        // Timeout par page (10s) — empêche un fetch qui hang de bloquer Sync.
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
      // Refresh du compteur — si le push a échoué (server action en erreur),
      // les ops restent en queue et le badge doit le refléter.
      void pendingOpsCount().then(setPendingCount);
    }
  }

  async function handleExportBackup() {
    setBackupMenuOpen(false);
    try {
      await downloadBackup();
      setBackupStatus('✓ exporté');
    } catch (e) {
      setBackupStatus(`! ${String(e)}`);
    } finally {
      setTimeout(() => setBackupStatus(''), 3000);
    }
  }

  async function handleImportBackupFile(file: File) {
    try {
      const text = await file.text();
      const backup = parseBackup(text);
      const months = Array.from(new Set(backup.drafts.map(d => d.target_month))).sort().join(', ');
      if (!confirm(`Restaurer le backup ?\n\nMois remplacés : ${months || '(aucun)'}\nItems : ${backup.items.length}\nOps en queue : ${backup.sync_queue.length}\n\nLes autres mois resteront intacts.`)) return;
      const summary = await importBackup(backup);
      setBackupStatus(`✓ ${summary.itemsImported} items restaurés`);
      router.refresh();
    } catch (e) {
      setBackupStatus(`! ${String(e)}`);
    } finally {
      setTimeout(() => setBackupStatus(''), 4000);
    }
  }

  async function handleReset() {
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
            href="/admin/whitelist"
            className={[
              'px-4 h-8 flex items-center text-sm font-medium rounded transition-colors whitespace-nowrap',
              path.startsWith('/admin') ? 'bg-amber-700 text-white' : 'text-amber-400 hover:text-amber-200 hover:bg-zinc-800',
            ].join(' ')}
            title="Administration (whitelist + journal)"
          >
            Admin
          </a>
        )}
        <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={handleSync}
            disabled={syncing}
            title={
              syncStatus === 'offline' ? 'Pas de réseau'
              : syncStatus === 'push'  ? 'Envoi des modifications…'
              : syncStatus === 'pull'  ? 'Téléchargement…'
              : syncStatus === 'ok'    ? 'Synchronisé'
              : syncStatus === 'err'   ? 'Erreur de synchronisation'
              : pendingCount > 0       ? `${pendingCount} modification(s) en attente — Sync pour envoyer`
              : 'Synchroniser (envoi + téléchargement)'
            }
            className={`relative px-2 h-8 flex items-center gap-1 text-sm font-medium disabled:opacity-50 rounded hover:bg-zinc-800 transition-colors ${syncColor}`}
          >
            {/* Icône : nuage avec doubles flèches ↑↓ — symbolise sync bidirectionnel. */}
            <svg
              className={`w-5 h-5 ${syncing ? 'animate-pulse' : ''}`}
              viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true"
            >
              {/* Cloud outline */}
              <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
              {/* Flèches ↑↓ à l'intérieur */}
              <path d="M10 17V13" />
              <path d="M10 13l-1.5 1.5M10 13l1.5 1.5" />
              <path d="M14 13v4" />
              <path d="M14 17l-1.5-1.5M14 17l1.5-1.5" />
            </svg>
            {/* Marqueur résultat (✓ / !) ou progression */}
            {syncStatus === 'ok' && <span className="text-xs">✓</span>}
            {(syncStatus === 'err' || syncStatus === 'offline') && <span className="text-xs">!</span>}
            {dlProgress && <span className="font-mono text-[10px]">{dlProgress}</span>}
            {(syncStatus === 'push' || syncStatus === 'pull') && !dlProgress && (
              <span className="text-[10px] animate-pulse">{syncStatus === 'push' ? '↑' : '↓'}</span>
            )}
            {pendingCount > 0 && !syncing && syncStatus === '' && (
              <span className="absolute -top-1 -right-1 min-w-[16px] h-4 flex items-center justify-center rounded-full bg-amber-500 text-white text-[9px] font-bold px-1">
                {pendingCount}
              </span>
            )}
          </button>
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
                <div className="absolute right-0 top-full mt-1 z-50 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 min-w-56">
                  <button
                    onClick={handleExportBackup}
                    className="block w-full text-left px-4 py-2 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700"
                  >
                    Sauvegarder sur l&apos;iPad (.json)
                  </button>
                  <button
                    onClick={() => { setBackupMenuOpen(false); fileInputRef.current?.click(); }}
                    className="block w-full text-left px-4 py-2 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700"
                  >
                    Restaurer depuis un fichier…
                  </button>
                  <p className="px-4 py-1.5 text-[10px] text-zinc-400 border-t border-zinc-100 dark:border-zinc-700">
                    Remplace uniquement les mois présents dans le fichier.
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
            className="px-2 h-8 flex items-center text-sm text-zinc-500 hover:text-zinc-300 rounded hover:bg-zinc-800 transition-colors"
          >
            {/* Refresh (rotation arrow) */}
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        </div>
      </nav>
    </div>
  );
}
