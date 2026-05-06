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
  experimental: {},
  allowedDevOrigins: ['192.168.1.72'],
};

export default withSerwist(nextConfig);
