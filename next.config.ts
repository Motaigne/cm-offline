import type { NextConfig } from 'next';
import { execSync } from 'node:child_process';
import withSerwistInit from '@serwist/next';

// Revision unique par build : invalide automatiquement `/` et `/login` à chaque
// `next build`, garantissant que la coquille précachée reste en phase avec les
// hashes des chunks JS associés (sinon : HTML cached → réfs vers chunks
// disparus → écran blanc en cas de captif post-déploiement).
const SHELL_REV = String(Date.now());

// Identifiant de build lisible = sha git court + date/heure du build. Exposé au
// client via NEXT_PUBLIC_BUILD_ID (inliné dans le bundle → reflète la version
// réellement chargée sur l'appareil). Sert à l'indicateur de version NavBar :
// on sait d'un coup d'œil quel build tourne sur l'iPad et si un déploiement est
// bien celui en place. Fallback 'dev' si git indispo (CI shallow, etc.).
let gitSha = 'dev';
try { gitSha = execSync('git rev-parse --short HEAD').toString().trim() || 'dev'; } catch { /* pas de git */ }
const BUILD_ID = `${gitSha}·${new Date().toISOString().slice(5, 16).replace('T', ' ')}`;

const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
  additionalPrecacheEntries: [
    { url: '/offline', revision: '1' },
    // Coquilles statiques : ces routes ne font aucun fetch serveur — leur
    // HTML est constant et peut être servi par le SW sans toucher le réseau.
    // C'est ce qui rend l'app fonctionnelle sur wifi captif après une coupure.
    { url: '/',           revision: SHELL_REV },
    { url: '/login',      revision: SHELL_REV },
    { url: '/comparatif', revision: SHELL_REV },
  ],
});

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID },
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
