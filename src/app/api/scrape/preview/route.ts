import { createClient } from '@/lib/supabase/server';
import { fetchAllPairings } from '@/lib/scraper/crewbidd';

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const body = await req.json().catch(() => null);
  const { month, cookie, sn, userId } = body ?? {};

  if (!month || !cookie || !sn || !userId) {
    return new Response('Champs manquants : month, cookie, sn, userId', { status: 400 });
  }

  if (!/^\d{4}-\d{2}$/.test(month)) {
    return new Response('Format de mois invalide (YYYY-MM)', { status: 400 });
  }

  const { data: profile } = await supabase
    .from('user_profile')
    .select('is_scraper')
    .eq('user_id', user.id)
    .single();

  if (!profile?.is_scraper) {
    return new Response('Profil non autorisé à scraper', { status: 403 });
  }

  const allPairings = await fetchAllPairings(month, { cookie, sn, userId });

  const uniqueSigs = new Set(allPairings.map(p => p.activityNumber)).size;

  // Détecte un snapshot 'running' (téléchargement interrompu) pour ce mois/utilisateur
  const { data: running } = await supabase
    .from('scrape_snapshot')
    .select('id')
    .eq('target_month', `${month}-01`)
    .eq('scraped_by', user.id)
    .eq('status', 'running')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let partialProcessed = 0;
  if (running) {
    const { count } = await supabase
      .from('pairing_signature')
      .select('id', { count: 'exact', head: true })
      .eq('snapshot_id', running.id);
    partialProcessed = count ?? 0;
  }

  return Response.json({
    total_instances: allPairings.length,
    unique_sigs: uniqueSigs,
    partial: running ? { processed: partialProcessed, total: uniqueSigs } : null,
  });
}
