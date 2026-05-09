/**
 * Téléchargement chiffré d'une release.
 *
 *   GET /api/release/:id/download
 *     → { release, encrypted: { iv, data }, key_b64, watermark, expires_at }
 *
 * Le payload chiffré contient le snapshot complet (signatures + instances).
 * La clé AES-GCM est dérivée du user_id via PBKDF2 (stable côté serveur,
 * recalculable à tout moment) et retournée en base64. Le client la stocke
 * en Dexie pour pouvoir déchiffrer hors-ligne. La protection est donc
 * surtout au niveau watermark + auth + logs : on peut tracer une fuite.
 *
 * Logge auth_log kind=release_downloaded et insère release_download (audit).
 */
import { createClient } from '@/lib/supabase/server';
import { fetchAllPaginated } from '@/lib/supabase/paginate';
import { deriveUserKey, encryptPayload, watermarkFor } from '@/lib/release/crypto';

const EXPIRATION_DAYS = 60;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: releaseId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  // 1) Récupère la release + snapshot lié
  const { data: release } = await supabase
    .from('monthly_release')
    .select('id, target_month, snapshot_id, version, released_at, notes')
    .eq('id', releaseId)
    .single();
  if (!release) return new Response('Release introuvable', { status: 404 });

  // 2) Charge signatures + instances du snapshot (paginées)
  const sigs = await fetchAllPaginated((from, to) =>
    supabase.from('pairing_signature').select('*').eq('snapshot_id', release.snapshot_id).range(from, to),
  );
  const sigIds = sigs.map((s: { id: string }) => s.id);
  const instances = sigIds.length
    ? await fetchAllPaginated((from, to) =>
        supabase.from('pairing_instance').select('*').in('signature_id', sigIds).range(from, to),
      )
    : [];

  const payload = {
    schema_version: 1,
    release_id:     release.id,
    target_month:   release.target_month,
    version:        release.version,
    released_at:    release.released_at,
    notes:          release.notes,
    signatures:     sigs,
    instances,
  };

  // 3) Chiffre + watermark
  const key = deriveUserKey(user.id);
  const encrypted = encryptPayload(JSON.stringify(payload), key);
  const watermark = watermarkFor(user.id, release.id);

  // 4) Trace + log
  const expiresAt = new Date(Date.now() + EXPIRATION_DAYS * 86400_000).toISOString();
  const userAgent = req.headers.get('user-agent');

  await supabase.from('release_download').insert({
    release_id:    release.id,
    user_id:       user.id,
    watermark,
    expires_at:    expiresAt,
    user_agent:    userAgent,
  });

  if (user.email) {
    await supabase.from('auth_log').insert({
      email:   user.email.toLowerCase(),
      kind:    'release_downloaded',
      user_id: user.id,
      meta: {
        release_id:   release.id,
        target_month: release.target_month,
        version:      release.version,
        watermark,
        sigs:         sigs.length,
        instances:    instances.length,
      },
    });
  }

  return Response.json({
    release: {
      id:           release.id,
      target_month: release.target_month,
      version:      release.version,
      released_at:  release.released_at,
      notes:        release.notes,
    },
    encrypted,
    key_b64:    key.toString('base64'),
    watermark,
    expires_at: expiresAt,
  });
}
