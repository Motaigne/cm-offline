import type { NextConfig } from 'next';
import withSerwistInit from '@serwist/next';

const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
  additionalPrecacheEntries: [{ url: '/offline', revision: '1' }],
});

const nextConfig: NextConfig = {
  turbopack: {},
  experimental: {
    serverActions: {
      // Tunnel cloudflared pour test PWA iPad — Next.js exige que l'Origin
      // matche le Host pour les server actions (anti-CSRF). Le tunnel renvoie
      // un Host différent (localhost) du domaine public (trycloudflare.com),
      // ce qui faisait échouer toute mutation profile.
      allowedOrigins: [
        'drag-temporarily-convention-lopez.trycloudflare.com',
        '*.trycloudflare.com',
        'localhost:3000',
        '192.168.1.72:3000',
      ],
    },
  },
  allowedDevOrigins: ['192.168.1.72'],
};

export default withSerwist(nextConfig);
