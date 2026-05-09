/**
 * Publication manuelle d'une release mensuelle (point A2).
 *
 *   POST /api/admin/release
 *     body: { snapshot_id, notes? }
 *     → 1) crée monthly_release v(N+1) du mois du snapshot
 *       2) envoie un push à tous les push_subscription des users whitelistés
 *       3) logge auth_log kind=release_published
 *
 * Auth : admin only.
 */
import { createClient } from '@/lib/supabase/server';
import { fetchAllPaginated } from '@/lib/supabase/paginate';
import webpush from 'web-push';

function configureVapid() {
  const subject = process.env.VAPID_SUBJECT;
  const publicKey  = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!subject || !publicKey || !privateKey) {
    throw new Error('VAPID env manquant : VAPID_SUBJECT, NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY');
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const { data: profile } = await supabase
    .from('user_profile')
    .select('is_admin')
    .eq('user_id', user.id)
    .single();
  if (!profile?.is_admin) return new Response('Forbidden', { status: 403 });

  const body = await req.json().catch(() => null);
  const monthParam = body?.month as string | undefined;       // 'YYYY-MM'
  const snapshotId = body?.snapshot_id as string | undefined; // OPT
  const notes      = (body?.notes as string | undefined) ?? null;

  if (!monthParam && !snapshotId) {
    return new Response('month (YYYY-MM) ou snapshot_id requis', { status: 400 });
  }
  if (monthParam && !/^\d{4}-\d{2}$/.test(monthParam)) {
    return new Response('month doit être au format YYYY-MM', { status: 400 });
  }

  // Résout le snapshot : par id si fourni, sinon dernier success du mois.
  const snapQuery = supabase
    .from('scrape_snapshot')
    .select('id, target_month, status')
    .eq('status', 'success')
    .order('started_at', { ascending: false })
    .limit(1);

  const { data: snap } = snapshotId
    ? await snapQuery.eq('id', snapshotId).single()
    : await snapQuery.eq('target_month', `${monthParam}-01`).single();

  if (!snap) return new Response('Snapshot success introuvable pour ce mois', { status: 404 });
  if (snap.status !== 'success') return new Response(`Snapshot status=${snap.status}, doit être 'success'`, { status: 400 });

  // Prochaine version pour ce mois
  const { data: ver, error: verErr } = await supabase
    .rpc('next_release_version', { month: snap.target_month });
  if (verErr || ver == null) return new Response(`Version: ${verErr?.message ?? 'inconnue'}`, { status: 500 });
  const version = ver;

  // Crée la release
  const { data: release, error: insErr } = await supabase
    .from('monthly_release')
    .insert({
      target_month: snap.target_month,
      snapshot_id:  snap.id,
      version,
      released_by:  user.id,
      notes,
    })
    .select('id, target_month, version, released_at')
    .single();

  if (insErr || !release) return new Response(`Insert: ${insErr?.message}`, { status: 500 });

  // Logge la publication
  if (user.email) {
    await supabase.from('auth_log').insert({
      email:   user.email.toLowerCase(),
      kind:    'release_published',
      user_id: user.id,
      meta:    { release_id: release.id, target_month: release.target_month, version, snapshot_id: snap.id, notes },
    });
  }

  // Envoi push à toutes les subscriptions des users whitelistés.
  // RLS : l'admin peut lire toutes les push_subscription via la policy.
  // (Si l'utilisateur a été retiré de la whitelist, sa subscription persiste
  //  jusqu'au prochain cleanup — on ne la sup pas ici, c'est l'admin qui gère.)
  let pushOk = 0, pushFail = 0;
  try {
    configureVapid();
    const subs = await fetchAllPaginated<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      (from, to) => supabase
        .from('push_subscription')
        .select('id, endpoint, p256dh, auth')
        .range(from, to),
    );

    const monthLabel = release.target_month.slice(0, 7);
    const payload = JSON.stringify({
      type:    'release',
      release_id: release.id,
      target_month: monthLabel,
      version,
      title:   `DB ${monthLabel} v${version} disponible`,
      body:    notes ?? 'Nouvelle version à télécharger.',
    });

    const expiredSubIds: string[] = [];
    await Promise.all(subs.map(async sub => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        pushOk++;
      } catch (err: unknown) {
        pushFail++;
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) expiredSubIds.push(sub.id);
      }
    }));

    if (expiredSubIds.length > 0) {
      await supabase.from('push_subscription').delete().in('id', expiredSubIds);
    }
  } catch (err) {
    // L'envoi push n'est pas bloquant — la release est créée même si pas de push
    console.error('[release] push failed:', err);
  }

  return Response.json({
    ok: true,
    release,
    push: { sent: pushOk, failed: pushFail },
  });
}

/** Liste des releases d'un mois (admin only). */
export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const { data: profile } = await supabase
    .from('user_profile')
    .select('is_admin')
    .eq('user_id', user.id)
    .single();
  if (!profile?.is_admin) return new Response('Forbidden', { status: 403 });

  const url = new URL(req.url);
  const month = url.searchParams.get('month');
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return new Response('month requis (YYYY-MM)', { status: 400 });
  }

  const { data, error } = await supabase
    .from('monthly_release')
    .select('id, target_month, snapshot_id, version, released_at, released_by, notes')
    .eq('target_month', `${month}-01`)
    .order('version', { ascending: false });

  if (error) return new Response(error.message, { status: 500 });

  return Response.json({ releases: data ?? [] });
}
