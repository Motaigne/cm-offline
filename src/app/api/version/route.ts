import { NextResponse } from 'next/server';

// Route dynamique (jamais mise en cache) : renvoie le BUILD_ID réellement
// déployé. Le client compare à son propre BUILD_ID (baké dans le bundle) pour
// détecter une mise à jour de façon FIABLE, indépendamment du cycle du service
// worker (dont reg.update() peut ne pas capter/appliquer la nouvelle version).
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(
    { buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev' },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
