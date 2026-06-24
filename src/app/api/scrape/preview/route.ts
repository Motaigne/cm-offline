import { createClient } from '@/lib/supabase/server';
import { fetchAllPaginated } from '@/lib/supabase/paginate';
import { fetchAllPairings } from '@/lib/scraper/crewbidd';
import { computeNbOnDays } from '@/lib/rotation-days';

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

  // Clé `(activityNumber, nb_on_days)` — aligné sur le pipeline (mig 0033
  // split par durée : une même activityNumber CrewBidd peut donner plusieurs
  // sigs en DB selon la durée de l'instance). Si on clé par activityNumber
  // seul, le diff over-compte les missing_instances en additionnant les actIds
  // de toutes les durées mais en ne regardant que les instances d'UNE sig DB
  // (la dernière vue, side-effect du `set` répété). Résultat observé : preview
  // dit "15 dates à ajouter" mais le pipeline n'en trouve aucune côté
  // (activityNumber, dur) → 0/0 scrape, dialog se ferme, rien d'inséré.
  function sigKey(actNum: string, nbOnDays: number): string {
    return `${actNum}|${nbOnDays}`;
  }

  const sigMap = new Map<string, { actIds: string[]; actNum: string; nbOnDays: number }>();
  for (const p of monthPairings) {
    const dur = computeNbOnDays(p.beginBlockDate, p.endBlockDate);
    if (dur <= 0) continue;
    const k = sigKey(p.activityNumber, dur);
    let entry = sigMap.get(k);
    if (!entry) { entry = { actIds: [], actNum: p.activityNumber, nbOnDays: dur }; sigMap.set(k, entry); }
    entry.actIds.push(String(p.actId));
  }
  const uniqueSigs     = sigMap.size;
  const totalInstances = monthPairings.length;

  // Snapshot RÉEL du mois (le plus récent). Le fictif est ignoré ici car
  // `/api/scrape` le nuke en début de run via `cleanup_fictive_snapshots_for_month`
  // — le compter dans `in_db` ferait apparaître "déjà en DB" des sigs qui vont
  // être effacées dans la foulée (preview faussement rassurant).
  const { data: snap } = await supabase
    .from('scrape_snapshot')
    .select('id')
    .eq('target_month', `${month}-01`)
    .eq('is_fictive', false)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let inDb = 0;
  let missingInstances = 0;        // dates manquantes pour les sigs déjà en DB
  if (snap) {
    const sigs = await fetchAllPaginated<{ id: string; activity_number: string | null; nb_on_days: number | null }>((from, to) =>
      supabase
        .from('pairing_signature')
        .select('id, activity_number, nb_on_days')
        .eq('snapshot_id', snap.id)
        .range(from, to),
    );

    const sigIdByKey = new Map<string, string>();
    const legacySigIds: string[] = [];
    for (const s of sigs) {
      if (s.activity_number && s.nb_on_days != null) {
        sigIdByKey.set(sigKey(s.activity_number, s.nb_on_days), s.id);
      } else {
        legacySigIds.push(s.id);
      }
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

    // Pour chaque (actNum, dur) fetched, résout sigDbId (direct ou fallback
    // legacy), compte les sigs en DB et les instances manquantes côté DB.
    const matchedLegacySigs = new Set<string>();
    for (const entry of sigMap.values()) {
      let sigDbId = sigIdByKey.get(sigKey(entry.actNum, entry.nbOnDays));
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

  // Détecte un snapshot fictif sur le mois — sera nuké par
  // `cleanup_fictive_snapshots_for_month` au début du scrape. On expose
  // les compteurs pour afficher un bandeau d'avertissement dans la modale.
  // `user_items` = planning_item de l'utilisateur courant qui pointent
  // sur les instances fictives (RLS planning_item = self-only, donc le
  // count est naturellement scopé). Les vols d'autres users seront aussi
  // effacés mais on ne les compte pas ici.
  let fictive: { sigs: number; user_items: number } | null = null;
  const { data: ficSnap } = await supabase
    .from('scrape_snapshot')
    .select('id, unique_signatures')
    .eq('target_month', `${month}-01`)
    .eq('is_fictive', true)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (ficSnap) {
    const ficSigs = await fetchAllPaginated<{ id: string }>((from, to) =>
      supabase
        .from('pairing_signature')
        .select('id')
        .eq('snapshot_id', ficSnap.id)
        .range(from, to),
    );
    const ficSigIds = ficSigs.map(s => s.id);
    let userItems = 0;
    if (ficSigIds.length > 0) {
      const ficInsts = await fetchAllPaginated<{ id: string }>((from, to) =>
        supabase
          .from('pairing_instance')
          .select('id')
          .in('signature_id', ficSigIds)
          .range(from, to),
      );
      const ficInstIds = ficInsts.map(i => i.id);
      if (ficInstIds.length > 0) {
        const { count } = await supabase
          .from('planning_item')
          .select('id', { count: 'exact', head: true })
          .in('pairing_instance_id', ficInstIds);
        userItems = count ?? 0;
      }
    }
    fictive = {
      sigs:       ficSnap.unique_signatures ?? ficSigIds.length,
      user_items: userItems,
    };
  }

  return Response.json({
    total_instances:   totalInstances,
    unique_sigs:       uniqueSigs,
    in_db:             inDb,
    missing,
    missing_instances: missingInstances,
    fictive,
  });
}
