/**
 * Souscription Web Push d'un user à son device.
 *
 *   POST /api/push/subscribe
 *     body: { endpoint, keys: { p256dh, auth } }
 *     → upsert (user_id, endpoint) — si déjà présent, met à jour last_seen.
 *
 *   DELETE /api/push/subscribe?endpoint=...
 *     → supprime l'abonnement pour ce device.
 */
import { createClient } from '@/lib/supabase/server';

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const body = await req.json().catch(() => null);
  const endpoint = body?.endpoint as string | undefined;
  const p256dh   = body?.keys?.p256dh as string | undefined;
  const auth     = body?.keys?.auth   as string | undefined;

  if (!endpoint || !p256dh || !auth) {
    return new Response('Champs manquants : endpoint, keys.p256dh, keys.auth', { status: 400 });
  }

  const userAgent = req.headers.get('user-agent');

  // Upsert manuel sur (user_id, endpoint) — l'index unique gère la collision.
  const { error: insErr } = await supabase
    .from('push_subscription')
    .upsert(
      { user_id: user.id, endpoint, p256dh, auth, user_agent: userAgent, last_seen: new Date().toISOString() },
      { onConflict: 'user_id,endpoint' },
    );

  if (insErr) return new Response(`Subscribe: ${insErr.message}`, { status: 500 });

  return Response.json({ ok: true });
}

export async function DELETE(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const url = new URL(req.url);
  const endpoint = url.searchParams.get('endpoint');
  if (!endpoint) return new Response('endpoint requis', { status: 400 });

  await supabase
    .from('push_subscription')
    .delete()
    .eq('user_id', user.id)
    .eq('endpoint', endpoint);

  return Response.json({ ok: true });
}
