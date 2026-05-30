'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { computeTSej24, lookupTauxSej, getPlafondJours, computeValeurJour, type Article81Data } from '@/lib/article81';
import { loadAnnexeRowForMonth, loadAllAnnexeRows } from '@/app/actions/annexe';
import { loadAllProfileVersions } from '@/app/actions/profile-version';
import { computeFullProfile, getAnnexeDataFromRows, type AnnexeData } from '@/lib/annexe';
import { REGIME_NB30E } from '@/lib/finance';
import type { PairingDetail } from '@/lib/scraper/types';

const FIVE_MIN_MS  = 5  * 60 * 1000;
const TEN_MIN_MS   = 10 * 60 * 1000;

export interface A81Row {
  /** Identifiant unique = pairing_instance.id (sert aux overrides). */
  instance_id: string;
  /** Date de début de rotation (premier block-off) — ISO date 'YYYY-MM-DD'. */
  debut_rotation: string;
  /** Datetime ISO du début de séjour effectif (= override si défini, sinon raw_detail). */
  debut_sejour_at: string;
  /** Datetime ISO du début de séjour d'origine (toujours = raw_detail). */
  debut_sejour_at_origin: string;
  /** Code IATA escale de séjour début. */
  escale_debut: string;
  /** Datetime ISO de la fin de séjour effective. */
  fin_sejour_at: string;
  /** Datetime ISO de la fin de séjour d'origine. */
  fin_sejour_at_origin: string;
  /** Code IATA escale de séjour fin. */
  escale_fin: string;
  /** Temps de séjour en heures décimales (effectif). */
  temps_sej_h: number;
  /** Nb jours (tSej24) — 0 = sous le seuil. */
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
  /** True si l'utilisateur a modifié debut_sejour_at. */
  debut_sejour_overridden: boolean;
  /** True si l'utilisateur a modifié fin_sejour_at. */
  fin_sejour_overridden: boolean;
}

/** Ligne supprimée par l'utilisateur — métadata pour la section restauration. */
export interface A81DeletedRow {
  instance_id: string;
  debut_rotation: string;
  escale_debut: string;
  escale_fin: string;
}

export interface A81YearData {
  year: number;
  rows: A81Row[];
  /** Lignes supprimées (deleted=true) — à afficher en bas pour restauration. */
  deleted_rows: A81DeletedRow[];
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

  // 2. Annexe (article_81 + toutes versions pour valeur_jour) + profil versions + plafond
  const [a81Row, allAnnexeRows, profileVersions] = await Promise.all([
    loadAnnexeRowForMonth('article_81', `${year}-01`),
    loadAllAnnexeRows(),
    loadAllProfileVersions(user.id),
  ]);
  const article81Data = (a81Row as Article81Data | null) ?? null;
  const sortedVersions = [...profileVersions].sort((a, b) => b.valid_from.localeCompare(a.valid_from));
  const profileForMonth = (month: string) => {
    const cutoff = `${month}-01`;
    return sortedVersions.find(v => v.valid_from <= cutoff) ?? sortedVersions[sortedVersions.length - 1] ?? null;
  };

  /** Calcule la valeur_jour A81 pour un mois donné depuis profil + annexe versionnés. */
  function computeValeurJourForMonth(month: string): number {
    const prof = profileForMonth(month);
    if (!prof?.fonction || !prof.classe || !prof.echelon || !prof.categorie) return 600;
    const annexe = getAnnexeDataFromRows(allAnnexeRows, month);
    const hasAnnexe = !!(
      annexe.cat_anciennete?.length &&
      annexe.coef_classe?.length &&
      annexe.taux_avion?.length &&
      annexe.traitement_base
    );
    if (!hasAnnexe) return Number(prof.valeur_jour ?? 600);
    const isTri = prof.fonction === 'TRI_OPL' || prof.fonction === 'TRI_CDB';
    const primeInstFonction = prof.fonction === 'TRI_OPL' ? 'TRI_OPL'
      : prof.fonction === 'TRI_CDB' ? 'ICPL'
      : null;
    const nb30e = REGIME_NB30E[prof.regime] ?? 30;
    const c = computeFullProfile(
      prof.aircraft_principal ?? 'A335',
      prof.fonction,
      prof.classe,
      prof.categorie,
      prof.echelon,
      prof.bonus_atpl ?? false,
      nb30e,
      'LC',
      primeInstFonction,
      isTri ? prof.tri_niveau : null,
      prof.prime_330_count ?? null,
      annexe as AnnexeData,
    );
    return computeValeurJour({
      fixe: c.fixe,
      pvei: c.pvei,
      ksp: c.ksp,
      primeInstruction: c.primeInstruction,
      isTri,
    });
  }
  // Plafond : utilise le profil au 1er janv (cohérent avec un suivi annuel).
  const profileJan = profileForMonth(`${year}-01`);
  const regime = profileJan?.regime ?? null;
  const plafondJours = regime ? getPlafondJours(regime) : 70;

  const empty: A81YearData = {
    year, rows: [], deleted_rows: [], nb_total_jours: 0, cumul_jours: 0,
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

  // 5bis. Overrides utilisateur (édits + suppressions)
  const { data: overrides } = await supabase
    .from('user_a81_override')
    .select('pairing_instance_id, deleted, debut_sejour_at, fin_sejour_at')
    .eq('user_id', user.id)
    .in('pairing_instance_id', instIds);
  const overrideById = new Map((overrides ?? []).map(o => [o.pairing_instance_id, o]));

  // 6. Construit les rows (et collecte les supprimées)
  const rows: A81Row[] = [];
  const deletedRows: A81DeletedRow[] = [];
  for (const it of items) {
    const inst = instById.get(it.pairing_instance_id as string);
    if (!inst) continue;
    const ov = overrideById.get(inst.id);

    const sig = sigById.get(inst.signature_id);
    if (!sig) continue;
    const detail = sig.raw_detail as unknown as PairingDetail | null;
    if (!detail || !detail.flightDuty || detail.flightDuty.length < 2) continue; // pas de séjour

    const firstDuty = detail.flightDuty[0];
    const lastDuty  = detail.flightDuty[detail.flightDuty.length - 1];
    const debutSejourOriginMs = firstDuty.schEndDate - FIVE_MIN_MS;
    const finSejourOriginMs   = lastDuty.schBeginDate + TEN_MIN_MS;

    // Escales depuis legs (fallback signature.first_layover si pb)
    const firstDutyLegs = firstDuty.dutyLegAssociation?.flatMap(d => d.legs) ?? [];
    const lastDutyLegs  = lastDuty.dutyLegAssociation?.flatMap(d => d.legs) ?? [];
    const escaleDebut = firstDutyLegs[firstDutyLegs.length - 1]?.arrivalStationCode ?? sig.first_layover ?? '';
    const escaleFin   = lastDutyLegs[0]?.departureStationCode ?? sig.first_layover ?? '';

    // Ligne supprimée : on collecte les méta pour permettre la restauration.
    if (ov?.deleted) {
      deletedRows.push({
        instance_id: inst.id,
        debut_rotation: typeof inst.depart_at === 'string' ? inst.depart_at.slice(0, 10) : '',
        escale_debut: escaleDebut,
        escale_fin: escaleFin,
      });
      continue;
    }

    // Application des overrides (timestamp ISO en DB)
    const debutSejourMs = ov?.debut_sejour_at ? new Date(ov.debut_sejour_at).getTime() : debutSejourOriginMs;
    const finSejourMs   = ov?.fin_sejour_at   ? new Date(ov.fin_sejour_at).getTime()   : finSejourOriginMs;
    if (finSejourMs <= debutSejourMs) continue;

    const tempsSejH = (finSejourMs - debutSejourMs) / 3600000;
    const tSej24    = computeTSej24(tempsSejH);
    const taux      = lookupTauxSej(article81Data, sig.zone, tempsSejH);

    const monthOfDepart = new Date(debutSejourMs).toISOString().slice(0, 7);
    const valeurJour = computeValeurJourForMonth(monthOfDepart);

    rows.push({
      instance_id: inst.id,
      debut_rotation: typeof inst.depart_at === 'string' ? inst.depart_at.slice(0, 10) : '',
      debut_sejour_at: new Date(debutSejourMs).toISOString(),
      debut_sejour_at_origin: new Date(debutSejourOriginMs).toISOString(),
      escale_debut: escaleDebut,
      fin_sejour_at: new Date(finSejourMs).toISOString(),
      fin_sejour_at_origin: new Date(finSejourOriginMs).toISOString(),
      escale_fin: escaleFin,
      temps_sej_h: tempsSejH,
      nb_jours: tSej24,
      plafond: false,
      zone: sig.zone,
      taux: taux,
      valeur_jour: valeurJour,
      montant: 0, // calculé ci-dessous après application du plafond
      debut_sejour_overridden: !!ov?.debut_sejour_at,
      fin_sejour_overridden:   !!ov?.fin_sejour_at,
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

  // Dédup deleted_rows + tri chrono.
  const seenDel = new Set<string>();
  const uniqueDeleted = deletedRows
    .filter(r => { if (seenDel.has(r.instance_id)) return false; seenDel.add(r.instance_id); return true; })
    .sort((a, b) => a.debut_rotation.localeCompare(b.debut_rotation));

  return {
    year,
    rows: unique,
    deleted_rows: uniqueDeleted,
    nb_total_jours: Math.min(plafondJours, cumul),
    cumul_jours: cumul,
    plafond_jours: plafondJours,
    montant_total: montantTotal,
    regime_used: regime,
  };
}

/** Upsert un override sur une ligne A81 (édit Début/Fin Séjour). Passe null
 *  pour remettre la valeur d'origine sur un champ. */
export async function upsertA81Override(
  instanceId: string,
  fields: { debut_sejour_at?: string | null; fin_sejour_at?: string | null },
): Promise<{ ok: true } | { error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Non authentifié' };

  // Upsert : on essaie update, sinon insert
  const { data: existing } = await supabase
    .from('user_a81_override')
    .select('user_id')
    .eq('user_id', user.id)
    .eq('pairing_instance_id', instanceId)
    .maybeSingle();
  if (existing) {
    const { error } = await supabase
      .from('user_a81_override')
      .update(fields)
      .eq('user_id', user.id)
      .eq('pairing_instance_id', instanceId);
    if (error) return { error: error.message };
  } else {
    const { error } = await supabase
      .from('user_a81_override')
      .insert({ user_id: user.id, pairing_instance_id: instanceId, ...fields });
    if (error) return { error: error.message };
  }
  revalidatePath('/a81');
  return { ok: true };
}

/** Supprime (soft) une ligne A81 du tableau. */
export async function deleteA81Row(instanceId: string): Promise<{ ok: true } | { error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Non authentifié' };
  const { data: existing } = await supabase
    .from('user_a81_override')
    .select('user_id')
    .eq('user_id', user.id)
    .eq('pairing_instance_id', instanceId)
    .maybeSingle();
  if (existing) {
    const { error } = await supabase
      .from('user_a81_override')
      .update({ deleted: true })
      .eq('user_id', user.id)
      .eq('pairing_instance_id', instanceId);
    if (error) return { error: error.message };
  } else {
    const { error } = await supabase
      .from('user_a81_override')
      .insert({ user_id: user.id, pairing_instance_id: instanceId, deleted: true });
    if (error) return { error: error.message };
  }
  revalidatePath('/a81');
  return { ok: true };
}

/** Restaure une ligne supprimée (unset deleted). */
export async function restoreA81Row(instanceId: string): Promise<{ ok: true } | { error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Non authentifié' };
  const { error } = await supabase
    .from('user_a81_override')
    .update({ deleted: false })
    .eq('user_id', user.id)
    .eq('pairing_instance_id', instanceId);
  if (error) return { error: error.message };
  revalidatePath('/a81');
  return { ok: true };
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
