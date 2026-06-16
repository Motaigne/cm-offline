import { defaultCache } from '@serwist/next/worker';
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { Serwist, CacheFirst, ExpirationPlugin } from 'serwist';

// Normalise les URLs en strippant les query params dynamiques avant lookup
// cache. Sans ce plugin :
//   - Next.js ajoute ?_rsc=hash aléatoire à chaque soft nav → cache miss
//     systématique sur 'rsc' → "this page couldn't load" offline.
//   - Les routes statiques (/, /comparatif, etc.) varient par ?m=YYYY-MM mais
//     l'HTML servi est identique (le mois est décodé client-side depuis l'URL).
// Le plugin s'applique en lecture ET en écriture → cohérent.
const stripDynamicParams = {
  cacheKeyWillBeUsed: async ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    url.searchParams.delete('_rsc');
    url.searchParams.delete('m');
    return url.toString();
  },
};

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  precacheOptions: {
    // Strip `?m=YYYY-MM` (et autres params de routing client) AVANT le lookup
    // précache. Sinon `/?m=2026-08` ne matche pas la coquille précachée `/` et
    // tombe sur le fallback `/offline` → expérience cassée hors ligne dès qu'on
    // change de mois. Avec ce stripping, /?m=anything → précache /.
    ignoreURLParametersMatching: [/^m$/, /^release$/],
  },
  skipWaiting: true,
  clientsClaim: true,
  // navigationPreload: désactivé. Avec une stratégie CacheFirst pour les
  // navigations, le préchargement réseau est gaspillé en ligne et
  // contre-productif sur portail captif (un fetch parallèle peut ramener
  // l'HTML du captif et polluer le contrôleur de navigation).
  runtimeCaching: [
    // RSC payloads (Next.js soft navigation) : CacheFirst — l'app est offline-first,
    // le bouton Sync met à jour le cache RSC via precachePage (fetch RSC:1 explicite).
    {
      matcher: ({ request, sameOrigin, url }) =>
        sameOrigin &&
        !url.pathname.startsWith('/api/') &&
        !url.pathname.startsWith('/auth/') &&
        (request.headers.get('RSC') === '1' ||
         request.headers.get('Next-Router-Prefetch') === '1' ||
         url.searchParams.has('_rsc')),
      handler: new CacheFirst({
        cacheName: 'rsc',
        plugins: [
          stripDynamicParams,
          new ExpirationPlugin({ maxEntries: 128, maxAgeSeconds: 30 * 24 * 60 * 60 }),
        ],
      }),
    },
    // Navigation (HTML) : CacheFirst — l'app est offline-first, le Sync met à
    // jour le cache explicitement. Résultat : chargement instantané WiFi ON ou OFF.
    {
      matcher: ({ request, sameOrigin, url }) =>
        sameOrigin &&
        request.mode === 'navigate' &&
        !url.pathname.startsWith('/api/') &&
        !url.pathname.startsWith('/auth/'),
      handler: new CacheFirst({
        cacheName: 'others',
        plugins: [
          stripDynamicParams,
          new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 30 * 24 * 60 * 60 }),
        ],
      }),
    },
    ...defaultCache,
  ],
  fallbacks: {
    entries: [
      {
        url: '/offline',
        matcher({ request }) {
          return request.destination === 'document';
        },
      },
    ],
  },
});

serwist.addEventListeners();

// ─── Web Push (point A2) ────────────────────────────────────────────────
// Le serveur envoie un payload JSON :
//   { type: 'release', release_id, target_month, version, title, body }
// On affiche une notification ; au clic, on ouvre l'app sur la home avec un
// query param qui dit au front d'afficher le banner « Télécharger v(N) ».

self.addEventListener('push', event => {
  const evt = event as PushEvent;
  if (!evt.data) return;

  let data: Record<string, unknown> = {};
  try { data = evt.data.json() as Record<string, unknown>; }
  catch { data = { title: 'Mise à jour', body: evt.data.text() }; }

  const title = (data.title as string) ?? 'OptiP';
  const body  = (data.body  as string) ?? '';

  evt.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: typeof data.release_id === 'string' ? `release-${data.release_id}` : 'optip',
      data,
    }),
  );
});

self.addEventListener('notificationclick', event => {
  const evt = event as NotificationEvent;
  evt.notification.close();
  const data = evt.notification.data as { type?: string; release_id?: string; target_month?: string } | null;

  // URL d'ouverture : home avec un flag pour faire surgir le banner release.
  let target = '/';
  if (data?.type === 'release' && data.release_id) {
    target = `/?release=${encodeURIComponent(data.release_id)}`;
  }

  evt.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        if ('focus' in client) {
          await (client as WindowClient).focus();
          await (client as WindowClient).navigate(target).catch(() => undefined);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
