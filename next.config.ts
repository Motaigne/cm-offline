import type { NextConfig } from 'next';
import withSerwistInit from '@serwist/next';

const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
  additionalPrecacheEntries: [{ url: '/offline', revision: '1' }],
});

const nextConfig: NextConfig = {
  experimental: {
    // options Next.js 16 à ajouter ici si besoin
  },
};

export default withSerwist(nextConfig);
