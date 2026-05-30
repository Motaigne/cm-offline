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
    .select('is_admin, is_scraper')
    .eq('user_id', user.id)
    .single();

  if (!profile?.is_admin && !profile?.is_scraper) {
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
  let missingInstances = 0;        // dates manquantes pour les sigs déjà en DB
  if (snap) {
    const sigs = await fetchAllPaginated<{ id: string; activity_number: string | null }>((from, to) =>
      supabase
        .from('pairing_signature')
        .select('id, activity_number')
        .eq('snapshot_id', snap.id)
        .range(from, to),
    );

    const sigIdByActNum = new Map<string, string>();
    const legacySigIds: string[] = [];
    for (const s of sigs) {
      if (s.activity_number) sigIdByActNum.set(s.activity_number, s.id);
      else legacySigIds.push(s.id);
    }

    // Charge tous les pairing_instance.activity_id du snapshot — sert au diff
    // instance-level pour les sigs déjà en DB + au fallback legacy.
    const allSigIds = sigs.map(s => s.id);
    const existingActIdsBySig = new Map<string, Set<string>>();
    const legacySigByActId    = new Map<string, string>();
    if (allSigIds.length > 0) {
      const insts = await fetchAllPaginated<{ signature_id: string; activity_id: string }>((from, to) =>
        supabase
          .from('pairing_instance')
          .select('signature_id, activity_id')
          .in('signature_id', allSigIds)
          .range(from, to),
      );
      for (const r of insts) {
        let set = existingActIdsBySig.get(r.signature_id);
        if (!set) { set = new Set(); existingActIdsBySig.set(r.signature_id, set); }
        set.add(String(r.activity_id));
        if (legacySigIds.includes(r.signature_id)) {
          legacySigByActId.set(String(r.activity_id), r.signature_id);
        }
      }
    }

    // Pour chaque activityNumber fetched, résout sigDbId (direct ou fallback
    // legacy), compte les sigs en DB et les instances manquantes côté DB.
    const matchedLegacySigs = new Set<string>();
    for (const [actNum, entry] of sigMap) {
      let sigDbId = sigIdByActNum.get(actNum);
      if (!sigDbId) {
        for (const aid of entry.actIds) {
          const candidate = legacySigByActId.get(aid);
          if (candidate && !matchedLegacySigs.has(candidate)) {
            sigDbId = candidate;
            matchedLegacySigs.add(candidate);
            break;
          }
        }
      }
      if (sigDbId) {
        inDb++;
        const existingActIds = existingActIdsBySig.get(sigDbId) ?? new Set<string>();
        for (const aid of entry.actIds) {
          if (!existingActIds.has(aid)) missingInstances++;
        }
      }
    }
  }

  const missing = Math.max(0, uniqueSigs - inDb);

  return Response.json({
    total_instances:   totalInstances,
    unique_sigs:       uniqueSigs,
    in_db:             inDb,
    missing,
    missing_instances: missingInstances,
  });
}
