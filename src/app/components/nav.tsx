'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { getAvailableMonths, getRotationsForMonth } from '@/app/actions/search';
import { getScenariosWithItems } from '@/app/actions/planning';
import { getCurrentUserIsAdmin } from '@/app/actions/auth';
import { cacheRotations, hydrateDB } from '@/lib/local-db';

const TABS = [
  { label: 'Profil',      href: '/profil'     },
  { label: 'Calendrier',  href: '/'           },
  { label: 'Catalogue',   href: '/catalogue'  },
  { label: 'Comparatif',  href: '/comparatif' },
  { label: 'Annexe',      href: '/annexe'     },
];

const PAGES = ['/', '/catalogue', '/comparatif', '/annexe', '/profil'];
// Pages qui acceptent ?m=YYYY-MM — à précacher en variantes par mois
const PAGES_MONTH = ['/', '/catalogue', '/comparatif'];
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
    if (response.url.includes('/login')) return false;
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
  const [downloading, setDownloading] = useState(false);
  const [dlStatus, setDlStatus] = useState('');
  const [dlDone, setDlDone] = useState(false);
  const [swReady, setSwReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const last = localStorage.getItem(DL_KEY);
    if (last) {
      const age = Date.now() - parseInt(last, 10);
      if (age < 7 * 24 * 60 * 60 * 1000) setDlDone(true);
    }
    // Attend que le SW contrôle la page avant de pré-cacher
    void (async () => {
      const ready = await waitForSWController();
      setSwReady(ready);
      if (ready && navigator.onLine) {
        for (const url of PAGES) { void precachePage(url); }
      }
    })();
    void getCurrentUserIsAdmin().then(setIsAdmin).catch(() => setIsAdmin(false));
  }, []);

  async function handleDownload() {
    if (downloading || !navigator.onLine) return;
    setDownloading(true);
    setDlStatus('…');
    try {
      const ready = await waitForSWController();
      if (!ready) {
        setDlStatus('SW?');
        setTimeout(() => setDlStatus(''), 3000);
        return;
      }

      const months = await getAvailableMonths();
      for (let i = 0; i < months.length; i++) {
        setDlStatus(`${i + 1}/${months.length}`);
        const m = months[i];
        const [rots, scs] = await Promise.all([
          getRotationsForMonth(m),
          getScenariosWithItems(m),
        ]);
        await Promise.all([cacheRotations(rots, m), hydrateDB(scs, m)]);
      }

      // Pré-cache HTML + chunks + RSC de toutes les pages, et de chaque
      // variante ?m=YYYY-MM pour les pages qui dépendent du mois.
      setDlStatus('html');
      const urlVariants: string[] = [];
      for (const url of PAGES) {
        urlVariants.push(url);
        if (PAGES_MONTH.includes(url)) {
          for (const m of months) urlVariants.push(`${url}?m=${m}`);
        }
      }
      const results = await Promise.all(urlVariants.map(url => precachePage(url)));
      const ok = results.every(Boolean);

      if (!ok) {
        setDlStatus('!');
        setTimeout(() => setDlStatus(''), 4000);
        return;
      }

      localStorage.setItem(DL_KEY, String(Date.now()));
      setDlDone(true);
      setDlStatus('✓');
      setTimeout(() => setDlStatus(''), 3000);
    } catch {
      setDlStatus('!');
      setTimeout(() => setDlStatus(''), 3000);
    } finally {
      setDownloading(false);
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

  const icon = downloading ? '↓' : dlStatus === '✓' ? '✓' : dlStatus === '!' ? '!' : dlStatus === 'SW?' ? '?' : dlDone ? '✓' : '⬇';
  const iconColor = (dlDone && !downloading && !dlStatus)
    ? 'text-emerald-500'
    : dlStatus === '!' || dlStatus === 'SW?'
    ? 'text-red-500'
    : 'text-zinc-500 hover:text-zinc-300';

  return (
    <div className="bg-zinc-900 border-b border-zinc-700 flex-shrink-0" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <nav className="flex items-center h-8 px-2 gap-0.5 overflow-x-auto">
        {TABS.map(tab => {
          const active = tab.href === '/'
            ? path === '/'
            : path.startsWith(tab.href);
          return (
            <a
              key={tab.href}
              href={tab.href}
              className={[
                'px-3 h-6 flex items-center text-[11px] font-medium rounded transition-colors whitespace-nowrap',
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
              'px-3 h-6 flex items-center text-[11px] font-medium rounded transition-colors whitespace-nowrap',
              path.startsWith('/admin') ? 'bg-amber-700 text-white' : 'text-amber-400 hover:text-amber-200 hover:bg-zinc-800',
            ].join(' ')}
            title="Administration (whitelist + journal)"
          >
            Admin
          </a>
        )}
        <div className="ml-auto flex items-center gap-1 flex-shrink-0">
          <span title={swReady ? 'Service worker actif' : 'Service worker en attente'} className={`text-[10px] ${swReady ? 'text-emerald-500' : 'text-amber-500'}`}>
            {swReady ? '●' : '○'}
          </span>
          <button
            onClick={handleDownload}
            disabled={downloading}
            title={dlDone ? 'Cache hors ligne à jour — cliquer pour rafraîchir' : 'Télécharger tout pour utilisation hors ligne'}
            className={`px-2 h-6 flex items-center gap-1 text-[11px] disabled:opacity-50 rounded hover:bg-zinc-800 transition-colors ${iconColor}`}
          >
            <span>{icon}</span>
            {dlStatus && dlStatus !== '✓' && dlStatus !== '!' && dlStatus !== 'SW?' && (
              <span className="font-mono text-[10px]">{dlStatus}</span>
            )}
          </button>
          <button
            onClick={handleReset}
            title="Vider le cache et recharger"
            className="px-1.5 h-6 flex items-center text-[11px] text-zinc-500 hover:text-zinc-300 rounded hover:bg-zinc-800 transition-colors"
          >
            ↻
          </button>
        </div>
      </nav>
    </div>
  );
}
