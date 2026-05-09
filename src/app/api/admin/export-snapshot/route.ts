/**
 * Export JSON d'un snapshot complet (police d'assurance avant re-scrape).
 *
 * Réservé aux admins. Logge dans auth_log (kind=db_download).
 *
 *   GET /api/admin/export-snapshot?month=YYYY-MM
 *     → Le dernier snapshot 'success' du mois (3 tables : snapshot + signatures + instances).
 *
 *   GET /api/admin/export-snapshot?month=YYYY-MM&all=1
 *     → Tous les snapshots du mois (success ET autres), pour archive avant re-scrape.
 *
 * Retourne un fichier JSON `snapshot-YYYY-MM[-all].json` en attachment, contenant les
 * lignes brutes des 3 tables (raw_detail JSONB inclus). Format directement ré-importable
 * par INSERT, sans transformation.
 */
import { createClient } from '@/lib/supabase/server';
import { fetchAllPaginated } from '@/lib/supabase/paginate';
import type { Database } from '@/types/supabase';

type SignatureRow = Database['public']['Tables']['pairing_signature']['Row'];
type InstanceRow  = Database['public']['Tables']['pairing_instance']['Row'];

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

  const url   = new URL(req.url);
  const month = url.searchParams.get('month');
  const all   = url.searchParams.get('all') === '1';

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return new Response('month requis au format YYYY-MM', { status: 400 });
  }

  // 1) Récupère le ou les snapshots du mois
  const snapQuery = supabase
    .from('scrape_snapshot')
    .select('*')
    .eq('target_month', `${month}-01`)
    .order('started_at', { ascending: false });

  const { data: snapshots, error: snapErr } = all
    ? await snapQuery
    : await snapQuery.eq('status', 'success').limit(1);

  if (snapErr) return new Response(`Snapshot: ${snapErr.message}`, { status: 500 });
  if (!snapshots?.length) return new Response(`Aucun snapshot pour ${month}`, { status: 404 });

  // 2) Pour chaque snapshot, charge ses signatures + instances (paginées)
  const sections = await Promise.all(snapshots.map(async snap => {
    const sigs = await fetchAllPaginated<SignatureRow>((from, to) =>
      supabase.from('pairing_signature').select('*').eq('snapshot_id', snap.id).range(from, to),
    );
    const sigIds = sigs.map(s => s.id);
    const insts = sigIds.length
      ? await fetchAllPaginated<InstanceRow>((from, to) =>
          supabase.from('pairing_instance').select('*').in('signature_id', sigIds).range(from, to),
        )
      : [];
    return { snapshot: snap, signatures: sigs, instances: insts };
  }));

  const totalSigs  = sections.reduce((acc, s) => acc + s.signatures.length, 0);
  const totalInsts = sections.reduce((acc, s) => acc + s.instances.length,  0);

  // 3) Logge l'export
  if (user.email) {
    await supabase.from('auth_log').insert({
      email:   user.email.toLowerCase(),
      kind:    'db_download',
      user_id: user.id,
      meta: {
        endpoint:  'admin/export-snapshot',
        month,
        all,
        snapshots: snapshots.length,
        sigs:      totalSigs,
        instances: totalInsts,
      },
    });
  }

  const payload = {
    exported_at:    new Date().toISOString(),
    exported_by:    user.email ?? user.id,
    schema_version: 1,
    month,
    all,
    snapshots: sections,
  };

  const filename = `snapshot-${month}${all ? '-all' : ''}.json`;
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type':        'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control':       'no-store',
    },
  });
}
