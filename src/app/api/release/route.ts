/**
 * Liste les dernières versions de release par mois (pour la banner user).
 *
 *   GET /api/release
 *     → { releases: [{ id, target_month, version, released_at, notes }] }
 *
 * Retourne uniquement la dernière version (max version) de chaque mois.
 */
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  // On récupère toutes les releases puis on garde la dernière par mois.
  // Pas énorme en volume (1 release/mois en pratique, parfois 2-3) → pas de pagination nécessaire.
  const { data, error } = await supabase
    .from('monthly_release')
    .select('id, target_month, version, released_at, notes')
    .order('target_month', { ascending: false })
    .order('version', { ascending: false });

  if (error) return new Response(error.message, { status: 500 });

  const seenMonths = new Set<string>();
  const latest = (data ?? []).filter(r => {
    if (seenMonths.has(r.target_month)) return false;
    seenMonths.add(r.target_month);
    return true;
  });

  return Response.json({ releases: latest });
}
