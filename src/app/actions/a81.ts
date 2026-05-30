'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { computeTSej24, lookupTauxSej, getPlafondJours, type Article81Data } from '@/lib/article81';
import { loadAnnexeRowForMonth } from '@/app/actions/annexe';
import { loadAllProfileVersions } from '@/app/actions/profile-version';
import type { PairingDetail } from '@/lib/scraper/types';

const FIVE_MIN_MS  = 5  * 60 * 1000;
const TEN_MIN_MS   = 10 * 60 * 1000;

export interface A81Row {
  /** Identifiant unique = pairing_instance.id (sert aux overrides futurs). */
  instance_id: string;
  /** Date de début de rotation (premier block-off) — ISO date 'YYYY-MM-DD'. */
  debut_rotation: string;
  /** Datetime ISO du début de séjour (atterrissage première escale moins 5min). */
  debut_sejour_at: string;
  /** Code IATA escale de séjour début. */
  escale_debut: string;
  /** Datetime ISO de la fin de séjour (décollage dernière escale plus 10min). */
  fin_sejour_at: string;
  /** Code IATA escale de séjour fin. */
  escale_fin: string;
  /** Temps de séjour en heures décimales. */
  temps_sej_h: number;
  /** Nb jours (tSej24) — 0 = sous le seuil ; -1 = au-delà du plafond annuel (PLAF). */
  nb_jours: number;
  /** True si la rotation a dépassé le plafond annuel cumulé (montant=0). */
  plafond: boolean;
  /** Zone Article 81. */
  zone: string | null;
  /** Taux séjour (0–1.6 typiquement). */
  taux: number | null;
  /** Valeur jour utilisée pour le calcul (depuis profil applicable au mois). */
  valeur_jour: number;
  /** Montant prime séjour = valeur_jour × taux × nb_jours (0 si plafond). */
  montant: number;
}

export interface A81YearData {
  year: number;
  rows: A81Row[];
  /** MIN(plafond_jours, cumul_jours) — nb total jours décomptés. */
  nb_total_jours: number;
  /** Cumul brut (sans plafond) — utile pour info. */
  cumul_jours: number;
  /** Plafond annuel selon régime utilisateur applicable. */
  plafond_jours: number;
  /** Somme des montants (avec plafond appliqué). */
  montant_total: number;
  /** Régime utilisé pour déterminer le plafond (= profil au 1er janv ou 1ère version applicable). */
  regime_used: string | null;
}

/** Charge le tableau A81 d'une année pour l'utilisateur authentifié.
 *  Source : flights placés dans le scénario A des planning_draft du user. */
export async function loadA81ForYear(year: number): Promise<A81YearData> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const yearStart = `${year}-01-01`;
  const yearEnd   = `${year + 1}-01-01`;

  // 1. Drafts du user scénario A pour l'année
  const { data: drafts } = await supabase
    .from('planning_draft')
    .select('id, target_month')
    .eq('user_id', user.id)
    .eq('name', 'A')
    .gte('target_month', yearStart)
    .lt('target_month', yearEnd);

  // 2. Annexe article_81 + profil versions + plafond
  const [a81Row, profileVersions] = await Promise.all([
    loadAnnexeRowForMonth('article_81', `${year}-01`),
    loadAllProfileVersions(user.id),
  ]);
  const article81Data = (a81Row as Article81Data | null) ?? null;
  const sortedVersions = [...profileVersions].sort((a, b) => b.valid_from.localeCompare(a.valid_from));
  const profileForMonth = (month: string) => {
    const cutoff = `${month}-01`;
    return sortedVersions.find(v => v.valid_from <= cutoff) ?? sortedVersions[sortedVersions.length - 1] ?? null;
  };
  // Plafond : utilise le profil au 1er janv (cohérent avec un suivi annuel).
  const profileJan = profileForMonth(`${year}-01`);
  const regime = profileJan?.regime ?? null;
  const plafondJours = regime ? getPlafondJours(regime) : 70;

  const empty: A81YearData = {
    year, rows: [], nb_total_jours: 0, cumul_jours: 0,
    plafond_jours: plafondJours, montant_total: 0, regime_used: regime,
  };
  if (!drafts?.length) return empty;

  // 3. Flight items
  const draftIds = drafts.map(d => d.id);
  const { data: items } = await supabase
    .from('planning_item')
    .select('id, draft_id, pairing_instance_id')
    .in('draft_id', draftIds)
    .eq('kind', 'flight')
    .not('pairing_instance_id', 'is', null);
  if (!items?.length) return empty;

  // 4. Instances → signature_id + dates
  const instIds = [...new Set(items.map(it => it.pairing_instance_id as string))];
  const { data: instances } = await supabase
    .from('pairing_instance')
    .select('id, signature_id, depart_at, arrivee_at')
    .in('id', instIds);
  if (!instances?.length) return empty;
  const instById = new Map(instances.map(i => [i.id, i]));

  // 5. Signatures avec raw_detail + zone + first_layover
  const sigIds = [...new Set(instances.map(i => i.signature_id))];
  const { data: sigs } = await supabase
    .from('pairing_signature')
    .select('id, zone, first_layover, temps_sej, raw_detail')
    .in('id', sigIds);
  const sigById = new Map((sigs ?? []).map(s => [s.id, s]));

  // 6. Construit les rows
  const rows: A81Row[] = [];
  for (const it of items) {
    const inst = instById.get(it.pairing_instance_id as string);
    if (!inst) continue;
    const sig = sigById.get(inst.signature_id);
    if (!sig) continue;
    const detail = sig.raw_detail as unknown as PairingDetail | null;
    if (!detail || !detail.flightDuty || detail.flightDuty.length < 2) continue; // pas de séjour

    const firstDuty = detail.flightDuty[0];
    const lastDuty  = detail.flightDuty[detail.flightDuty.length - 1];
    const debutSejourMs = firstDuty.schEndDate - FIVE_MIN_MS;
    const finSejourMs   = lastDuty.schBeginDate + TEN_MIN_MS;
    if (finSejourMs <= debutSejourMs) continue;

    // Escales depuis legs (fallback signature.first_layover si pb)
    const firstDutyLegs = firstDuty.dutyLegAssociation?.flatMap(d => d.legs) ?? [];
    const lastDutyLegs  = lastDuty.dutyLegAssociation?.flatMap(d => d.legs) ?? [];
    const escaleDebut = firstDutyLegs[firstDutyLegs.length - 1]?.arrivalStationCode ?? sig.first_layover ?? '';
    const escaleFin   = lastDutyLegs[0]?.departureStationCode ?? sig.first_layover ?? '';

    const tempsSejH = (finSejourMs - debutSejourMs) / 3600000;
    const tSej24    = computeTSej24(tempsSejH);
    const taux      = lookupTauxSej(article81Data, sig.zone, tempsSejH);

    const monthOfDepart = new Date(debutSejourMs).toISOString().slice(0, 7);
    const profMo = profileForMonth(monthOfDepart);
    const valeurJour = Number(profMo?.valeur_jour ?? 600);

    rows.push({
      instance_id: inst.id,
      debut_rotation: typeof inst.depart_at === 'string' ? inst.depart_at.slice(0, 10) : '',
      debut_sejour_at: new Date(debutSejourMs).toISOString(),
      escale_debut: escaleDebut,
      fin_sejour_at: new Date(finSejourMs).toISOString(),
      escale_fin: escaleFin,
      temps_sej_h: tempsSejH,
      nb_jours: tSej24,
      plafond: false,
      zone: sig.zone,
      taux: taux,
      valeur_jour: valeurJour,
      montant: 0, // calculé ci-dessous après application du plafond
    });
  }

  // 7. Tri chrono + dédup (un même instance peut apparaître plusieurs fois si
  //    le user a placé le vol dans plusieurs drafts A — ne devrait pas arriver
  //    mais on s'en protège).
  const seen = new Set<string>();
  rows.sort((a, b) => a.debut_sejour_at.localeCompare(b.debut_sejour_at));
  const unique = rows.filter(r => {
    if (seen.has(r.instance_id)) return false;
    seen.add(r.instance_id);
    return true;
  });

  // 8. Plafond running + calcul montants
  let cumul = 0;
  let montantTotal = 0;
  for (const r of unique) {
    if (r.nb_jours === 0 || r.taux == null) {
      r.montant = 0; continue;
    }
    if (cumul + r.nb_jours > plafondJours) {
      // Plafond atteint sur cette rotation → marqué PLAF, montant = 0
      r.plafond = true;
      r.montant = 0;
      cumul += r.nb_jours; // on incrémente cumul brut (pour info)
    } else {
      cumul += r.nb_jours;
      r.montant = r.valeur_jour * r.taux * r.nb_jours;
      montantTotal += r.montant;
    }
  }

  return {
    year,
    rows: unique,
    nb_total_jours: Math.min(plafondJours, cumul),
    cumul_jours: cumul,
    plafond_jours: plafondJours,
    montant_total: montantTotal,
    regime_used: regime,
  };
}

/** Liste les années qui ont au moins 1 draft A non vide pour l'utilisateur. */
export async function getA81AvailableYears(): Promise<number[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data: drafts } = await supabase
    .from('planning_draft')
    .select('target_month')
    .eq('user_id', user.id)
    .eq('name', 'A');
  if (!drafts?.length) return [new Date().getUTCFullYear()];
  const years = new Set<number>();
  for (const d of drafts) {
    const y = (d.target_month as string).slice(0, 4);
    years.add(Number(y));
  }
  return [...years].sort((a, b) => b - a);
}
