import { defaultCache } from '@serwist/next/worker';
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { Serwist, NetworkFirst, ExpirationPlugin } from 'serwist';

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
    // RSC payloads (Next.js soft navigation) : cache séparé, sans cela la nav
    // entre onglets hors ligne échoue et provoque une page blanche.
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
        networkTimeoutSeconds: 2,
        plugins: [
          new ExpirationPlugin({ maxEntries: 128, maxAgeSeconds: 30 * 24 * 60 * 60 }),
        ],
      }),
    },
    // Navigation requests : NetworkFirst avec timeout court → cache de secours rapide
    // (sinon NetworkFirst sans timeout peut bloquer hors ligne sur connexion ambiguë)
    {
      matcher: ({ request, sameOrigin, url }) =>
        sameOrigin &&
        request.mode === 'navigate' &&
        !url.pathname.startsWith('/api/') &&
        !url.pathname.startsWith('/auth/'),
      handler: new NetworkFirst({
        cacheName: 'others',
        networkTimeoutSeconds: 3,
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
