import type { NextConfig } from 'next';
import withSerwistInit from '@serwist/next';

// Revision unique par build : invalide automatiquement `/` et `/login` à chaque
// `next build`, garantissant que la coquille précachée reste en phase avec les
// hashes des chunks JS associés (sinon : HTML cached → réfs vers chunks
// disparus → écran blanc en cas de captif post-déploiement).
const SHELL_REV = String(Date.now());

const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
  additionalPrecacheEntries: [
    { url: '/offline', revision: '1' },
    // Coquilles statiques : `/` et `/login` ne font aucun fetch serveur — leur
    // HTML est constant et peut être servi par le SW sans toucher le réseau.
    // C'est ce qui rend l'app fonctionnelle sur wifi captif après une coupure.
    { url: '/',       revision: SHELL_REV },
    { url: '/login',  revision: SHELL_REV },
  ],
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
  // Déplace l'indicateur Next dev (défaut: bottom-left) hors de la zone
  // basse, où il chevauche l'action bar du Gantt sur localhost PC.
  devIndicators: { position: 'top-right' },
};

export default withSerwist(nextConfig);
