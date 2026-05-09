import { createClient } from '@/lib/supabase/server';
import { fetchAllPaginated } from '@/lib/supabase/paginate';
import { fetchAllPairings } from '@/lib/scraper/crewbidd';

/**
 * Phase Analyse du scrape :
 *  - Interroge CrewBidd pour le mois M (1 requête /pairingsearch)
 *  - Compte les rotations uniques disponibles côté AF (unique_sigs / total_instances)
 *  - Diffe avec le snapshot du mois en DB :
 *      in_db   = combien de ces rotations sont déjà chez nous
 *      missing = combien il reste à télécharger
 *
 * Le diff utilise activity_number (CrewBidd) en priorité, avec fallback sur
 * pairing_instance.activity_id pour les snapshots créés avant 0003.
 */
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
    .select('is_admin')
    .eq('user_id', user.id)
    .single();

  if (!profile?.is_admin) {
    return new Response('Profil non autorisé à scraper', { status: 403 });
  }

  const allPairings = await fetchAllPairings(month, { cookie, sn, userId });

  // Filtre point C — rotations qui décollent réellement en M.
  const [paramY, paramM] = month.split('-').map(Number);
  const monthPairings = allPairings.filter(p => {
    const d = new Date(p.beginBlockDate);
    return d.getUTCFullYear() === paramY && d.getUTCMonth() + 1 === paramM;
  });

  const sigMap = new Map<string, { actIds: string[] }>();
  for (const p of monthPairings) {
    let entry = sigMap.get(p.activityNumber);
    if (!entry) { entry = { actIds: [] }; sigMap.set(p.activityNumber, entry); }
    entry.actIds.push(String(p.actId));
  }
  const uniqueSigs     = sigMap.size;
  const totalInstances = monthPairings.length;

  // Snapshot du mois (le plus récent, peu importe le statut).
  const { data: snap } = await supabase
    .from('scrape_snapshot')
    .select('id')
    .eq('target_month', `${month}-01`)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let inDb = 0;
  if (snap) {
    const sigs = await fetchAllPaginated<{ id: string; activity_number: string | null }>((from, to) =>
      supabase
        .from('pairing_signature')
        .select('id, activity_number')
        .eq('snapshot_id', snap.id)
        .range(from, to),
    );

    const existingNumbers = new Set<string>();
    const legacySigIds: string[] = [];
    for (const s of sigs) {
      if (s.activity_number) existingNumbers.add(s.activity_number);
      else legacySigIds.push(s.id);
    }

    // Match direct par activity_number.
    for (const k of sigMap.keys()) {
      if (existingNumbers.has(k)) inDb++;
    }

    // Fallback héritage : on regarde si un actId du groupe existe en pairing_instance
    // pour une signature legacy de ce snapshot. Une signature legacy ne peut matcher
    // qu'une seule activityNumber (au plus).
    if (legacySigIds.length > 0) {
      const insts = await fetchAllPaginated<{ signature_id: string; activity_id: string }>((from, to) =>
        supabase
          .from('pairing_instance')
          .select('signature_id, activity_id')
          .in('signature_id', legacySigIds)
          .range(from, to),
      );

      const legacySigByActId = new Map<string, string>();
      for (const r of insts) {
        legacySigByActId.set(String(r.activity_id), r.signature_id);
      }

      const matchedLegacySigs = new Set<string>();
      for (const [actNum, entry] of sigMap) {
        if (existingNumbers.has(actNum)) continue;
        for (const aid of entry.actIds) {
          const sigId = legacySigByActId.get(aid);
          if (sigId && !matchedLegacySigs.has(sigId)) {
            matchedLegacySigs.add(sigId);
            inDb++;
            break;
          }
        }
      }
    }
  }

  const missing = Math.max(0, uniqueSigs - inDb);

  return Response.json({
    total_instances: totalInstances,
    unique_sigs:     uniqueSigs,
    in_db:           inDb,
    missing,
  });
}
