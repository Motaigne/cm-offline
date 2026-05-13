import { defaultCache } from '@serwist/next/worker';
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { Serwist, NetworkFirst, CacheFirst, ExpirationPlugin } from 'serwist';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // RSC payloads (Next.js soft navigation) : NetworkFirst court pour obtenir
    // des données fraîches quand en ligne, fallback cache sinon.
    {
      matcher: ({ request, sameOrigin, url }) =>
        sameOrigin &&
        !url.pathname.startsWith('/api/') &&
        !url.pathname.startsWith('/auth/') &&
        (request.headers.get('RSC') === '1' ||
         request.headers.get('Next-Router-Prefetch') === '1' ||
         url.searchParams.has('_rsc')),
      handler: new NetworkFirst({
        cacheName: 'rsc',
        networkTimeoutSeconds: 1,
        plugins: [
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

  const title = (data.title as string) ?? 'cm-offline';
  const body  = (data.body  as string) ?? '';

  evt.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: typeof data.release_id === 'string' ? `release-${data.release_id}` : 'cm-offline',
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
