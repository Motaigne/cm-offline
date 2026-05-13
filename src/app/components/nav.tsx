'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getAvailableMonths, getRotationsForMonth } from '@/app/actions/search';
import { getScenariosWithItems } from '@/app/actions/planning';
import { getCurrentUserIsAdmin } from '@/app/actions/auth';
import { cacheRotations, hydrateDB } from '@/lib/local-db';
import { syncNow, pendingOpsCount } from '@/lib/sync-service';
import { ReleaseBanner } from '@/app/components/release-banner';

const TABS = [
  { label: 'Profil',      href: '/profil'     },
  { label: 'Calendrier',  href: '/'           },
  { label: 'EP4',         href: '/ep4'        },
  { label: 'Catalogue',   href: '/catalogue'  },
  { label: 'Comparatif',  href: '/comparatif' },
  { label: 'Annexe',      href: '/annexe'     },
];

const PAGES = ['/', '/ep4', '/catalogue', '/comparatif', '/annexe', '/profil', '/login'];
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

export function NavBar() {
  const path = usePathname();
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'' | 'push' | 'pull' | 'ok' | 'err' | 'offline'>('');
  const [dlProgress, setDlProgress] = useState('');
  const [swReady, setSwReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

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
      const ready = await waitForSWController();
      if (ready) {
        const months = await getAvailableMonths();
        for (let i = 0; i < months.length; i++) {
          setDlProgress(`${i + 1}/${months.length}`);
          const m = months[i];
          const [rots, scs] = await Promise.all([
            getRotationsForMonth(m),
            getScenariosWithItems(m),
          ]);
          await Promise.all([cacheRotations(rots, m), hydrateDB(scs, m)]);
        }
        setDlProgress('');
        const urlVariants: string[] = [];
        for (const url of PAGES) {
          urlVariants.push(url);
          if (PAGES_MONTH.includes(url)) {
            for (const m of months) urlVariants.push(`${url}?m=${m}`);
          }
        }
        await Promise.all(urlVariants.map(url => precachePage(url)));
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

  async function handleReset() {
    if (!confirm('Vider le cache hors ligne et recharger ?')) return;
    await clearAllCaches();
    localStorage.removeItem(DL_KEY);
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    window.location.reload();
  }

  const syncIcon = syncStatus === 'ok' ? '✓' : syncStatus === 'err' || syncStatus === 'offline' ? '!' : '⟳';
  const syncColor = syncStatus === 'ok'
    ? 'text-emerald-500'
    : syncStatus === 'err' || syncStatus === 'offline'
    ? 'text-red-500'
    : 'text-zinc-500 hover:text-zinc-300';

  return (
    <div className="bg-zinc-900 border-b border-zinc-700 flex-shrink-0" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <nav className="flex items-center h-10 px-3 gap-1 overflow-x-auto">
        {TABS.map(tab => {
          const active = tab.href === '/'
            ? path === '/'
            : path.startsWith(tab.href);
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
          <span title={swReady ? 'Service worker actif' : 'Service worker en attente'} className={`text-xs ${swReady ? 'text-emerald-500' : 'text-amber-500'}`}>
            {swReady ? '●' : '○'}
          </span>
          <button
            onClick={handleSync}
            disabled={syncing}
            title={
              syncStatus === 'offline' ? 'Pas de réseau — impossible de synchroniser'
              : syncStatus === 'push'  ? 'Envoi des modifications…'
              : syncStatus === 'pull'  ? 'Téléchargement des données…'
              : syncStatus === 'ok'    ? 'Synchronisation réussie'
              : syncStatus === 'err'   ? 'Erreur de synchronisation'
              : pendingCount > 0       ? `${pendingCount} modification(s) à envoyer — cliquer pour synchroniser`
              : 'Synchroniser (envoyer les modifications puis télécharger)'
            }
            className={`relative px-3 h-8 flex items-center gap-1 text-sm disabled:opacity-50 rounded hover:bg-zinc-800 transition-colors ${syncColor}`}
          >
            <span className={syncing ? 'animate-spin inline-block' : ''}>{syncIcon}</span>
            {dlProgress && <span className="font-mono text-xs">{dlProgress}</span>}
            {(syncStatus === 'push' || syncStatus === 'pull') && !dlProgress && (
              <span className="text-[10px] animate-pulse">{syncStatus === 'push' ? '↑' : '↓'}</span>
            )}
            {pendingCount > 0 && !syncing && syncStatus === '' && (
              <span className="absolute -top-1 -right-1 min-w-[16px] h-4 flex items-center justify-center rounded-full bg-amber-500 text-white text-[9px] font-bold px-1">
                {pendingCount}
              </span>
            )}
          </button>
          <button
            onClick={handleReset}
            title="Vider le cache et recharger"
            className="px-2 h-8 flex items-center text-sm text-zinc-500 hover:text-zinc-300 rounded hover:bg-zinc-800 transition-colors"
          >
            ↻
          </button>
        </div>
      </nav>
      <ReleaseBanner />
    </div>
  );
}
