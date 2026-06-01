'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { computeTSej24, lookupTauxSej, getPlafondJours, computeValeurJour, splitRotationAtMonth, computeSejourOffsetsFromDetail, type Article81Data } from '@/lib/article81';
import { loadAnnexeRowForMonth, loadAllAnnexeRows } from '@/app/actions/annexe';
import { loadAllProfileVersions } from '@/app/actions/profile-version';
import { computeFullProfile, computePrimeInstructionMontant, getAnnexeDataFromRows, type AnnexeData } from '@/lib/annexe';
import { REGIME_NB30E } from '@/lib/finance';
import type { PairingDetail } from '@/lib/scraper/types';

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
  /** Composantes de valeur_jour pour affichage formule détaillée dans le
   *  footer fiscal (optionnel — peuplé par le compute local uniquement). */
  valeur_jour_breakdown?: {
    fixe: number;
    pvei: number;
    ksp: number;
    primeInstruction: number;   // 0 si non-instructeur
    isTri: boolean;
  };
  /** Montant prime séjour = valeur_jour × taux × nb_jours (0 si plafond). */
  montant: number;
  /** True si l'utilisateur a modifié debut_sejour_at. */
  debut_sejour_overridden: boolean;
  /** True si l'utilisateur a modifié fin_sejour_at. */
  fin_sejour_overridden: boolean;
  /** Sous-ligne d'une rotation à cheval :
   *   - undefined : ligne unique (rotation entièrement dans un seul mois)
   *   - 'm0'      : 1ʳᵉ part (Début Séjour = réel, Fin = boundary 24:00 synthétique)
   *   - 'm1'      : 2ᵉ part  (Début = boundary 00:00 synthétique, Fin = réel) */
  split_part?: 'm0' | 'm1';
  /** True si la rotation est sur un snapshot fictif (projection admin). */
  is_fictive?: boolean;
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
  /** Saisi par l'utilisateur (somme des salaires bruts colonne A des plannings de l'année). */
  plafond_exo_brut: number | null;
  /** = MIN(0.4 × plafond_exo_brut, montant_total). 0 si plafond_exo_brut non saisi. */
  montant_exo: number;
  /** = 0.818 × montant_exo. */
  montant_net_exo: number;
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
    // Valeur Jour utilise le FIXE TEMPS PLEIN (non proratisé régime) et la
    // prime instruction NON proratisée — formule pour le pilote « théorique
    // 100% », indépendamment du régime réel. Aligne avec a81-local.ts.
    const primeInstNonProratise = (primeInstFonction && isTri && prof.tri_niveau && annexe.prime_instruction)
      ? computePrimeInstructionMontant(annexe.prime_instruction, primeInstFonction, prof.tri_niveau)
      : 0;
    return computeValeurJour({
      fixe: c.fixeTP,
      pvei: c.pvei,
      ksp: c.ksp,
      primeInstruction: primeInstNonProratise,
      isTri,
    });
  }
  // Plafond : utilise le profil au 1er janv (cohérent avec un suivi annuel).
  const profileJan = profileForMonth(`${year}-01`);
  const regime = profileJan?.regime ?? null;
  const plafondJours = regime ? getPlafondJours(regime) : 70;

  // Plafond exo brut (saisi par user) pour l'année courante.
  const { data: yearData } = await supabase
    .from('user_a81_year_data')
    .select('plafond_exo_brut')
    .eq('user_id', user.id)
    .eq('year', year)
    .maybeSingle();
  const plafondExoBrut: number | null = yearData?.plafond_exo_brut != null
    ? Number(yearData.plafond_exo_brut) : null;

  const empty: A81YearData = {
    year, rows: [], deleted_rows: [], nb_total_jours: 0, cumul_jours: 0,
    plafond_jours: plafondJours, montant_total: 0, regime_used: regime,
    plafond_exo_brut: plafondExoBrut, montant_exo: 0, montant_net_exo: 0,
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

  // 5. Signatures avec raw_detail + zone + first_layover + snapshot_id (pour is_fictive)
  const sigIds = [...new Set(instances.map(i => i.signature_id))];
  const { data: sigs } = await supabase
    .from('pairing_signature')
    .select('id, zone, first_layover, temps_sej, raw_detail, snapshot_id')
    .in('id', sigIds);
  const sigById = new Map((sigs ?? []).map(s => [s.id, s]));

  // 5ter. Map snapshot_id → is_fictive pour marquer les rows de projection
  const snapIds = [...new Set((sigs ?? []).map(s => s.snapshot_id))];
  const { data: snaps } = await supabase
    .from('scrape_snapshot')
    .select('id, is_fictive')
    .in('id', snapIds);
  const fictiveBySnap = new Map((snaps ?? []).map(s => [s.id, s.is_fictive]));

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
    const offsets = computeSejourOffsetsFromDetail(detail);
    if (!offsets || !detail) continue; // pas de séjour

    const firstDuty = detail.flightDuty[0];
    const lastDuty  = detail.flightDuty[detail.flightDuty.length - 1];
    // CRITICAL : raw_detail = absolus de l'instance capturée (1 parmi N).
    // Pour cette instance, on shift en fonction de inst.depart_at.
    const instDepartMs = typeof inst.depart_at === 'string' ? new Date(inst.depart_at).getTime() : 0;
    const debutSejourOriginMs = instDepartMs + offsets.debutSejourOffsetMs;
    const finSejourOriginMs   = instDepartMs + offsets.finSejourOffsetMs;

    // Escales depuis legs (fallback signature.first_layover si pb) — stables
    // par signature, donc lecture du raw_detail OK même pour autres instances.
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
      is_fictive: fictiveBySnap.get(sig.snapshot_id) === true,
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

  // 7b. Expand rotations à cheval en 2 sous-rows (m0 = part mois début, m1 = part
  //     mois suivant). valeur_jour est recalculée par mois ; nb_jours est splitté
  //     selon la règle de splitRotationAtMonth (sum garantie = totalNbJours).
  const expanded: A81Row[] = [];
  for (const r of unique) {
    const debutMs = new Date(r.debut_sejour_at).getTime();
    const finMs   = new Date(r.fin_sejour_at).getTime();
    const split = splitRotationAtMonth(debutMs, finMs, r.nb_jours);
    if (!split) { expanded.push(r); continue; }
    const m0DebutAt = new Date(split.m0.debutMs).toISOString();
    const m0FinAt   = new Date(split.m0.finMs).toISOString();
    const m1DebutAt = new Date(split.m1.debutMs).toISOString();
    const m1FinAt   = new Date(split.m1.finMs).toISOString();
    const m0ValeurJour = computeValeurJourForMonth(m0DebutAt.slice(0, 7));
    const m1ValeurJour = computeValeurJourForMonth(m1DebutAt.slice(0, 7));
    expanded.push({
      ...r,
      debut_sejour_at: m0DebutAt,
      fin_sejour_at:   m0FinAt,
      nb_jours:        split.m0.nbJours,
      valeur_jour:     m0ValeurJour,
      montant:         0,
      // Le flag fin_sejour_overridden ne concerne que m1 (m0.fin = boundary synthétique)
      fin_sejour_overridden: false,
      split_part: 'm0',
    });
    expanded.push({
      ...r,
      debut_sejour_at: m1DebutAt,
      fin_sejour_at:   m1FinAt,
      nb_jours:        split.m1.nbJours,
      valeur_jour:     m1ValeurJour,
      montant:         0,
      // m1.debut = boundary synthétique → flag debut_sejour_overridden ne s'applique pas
      debut_sejour_overridden: false,
      split_part: 'm1',
    });
  }
  // Re-tri chrono : assure que les sous-rows d'une rotation à cheval sont
  // intercalées au bon endroit par rapport à d'autres rotations.
  expanded.sort((a, b) => a.debut_sejour_at.localeCompare(b.debut_sejour_at));

  // 8. Plafond running + calcul montants
  let cumul = 0;
  let montantTotal = 0;
  for (const r of expanded) {
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

  const montantExo = plafondExoBrut != null && plafondExoBrut > 0
    ? Math.min(0.4 * plafondExoBrut, montantTotal) : 0;
  const montantNetExo = 0.818 * montantExo;

  return {
    year,
    rows: expanded,
    deleted_rows: uniqueDeleted,
    nb_total_jours: Math.min(plafondJours, cumul),
    cumul_jours: cumul,
    plafond_jours: plafondJours,
    montant_total: montantTotal,
    regime_used: regime,
    plafond_exo_brut: plafondExoBrut,
    montant_exo: montantExo,
    montant_net_exo: montantNetExo,
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

/** Charge toutes les rows user_a81_year_data (pour cache offline). */
export async function loadAllA81YearData(): Promise<Array<{
  year: number;
  plafond_exo_brut: number | null;
}>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data } = await supabase
    .from('user_a81_year_data')
    .select('year, plafond_exo_brut')
    .eq('user_id', user.id);
  return (data ?? []).map(d => ({
    year: d.year,
    plafond_exo_brut: d.plafond_exo_brut != null ? Number(d.plafond_exo_brut) : null,
  }));
}

/** Upsert le plafond exo brut pour une année. Pass null pour vider. */
export async function saveA81PlafondExo(
  year: number,
  plafondExoBrut: number | null,
): Promise<{ ok: true } | { error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Non authentifié' };
  const { error } = await supabase
    .from('user_a81_year_data')
    .upsert({
      user_id: user.id,
      year,
      plafond_exo_brut: plafondExoBrut,
    }, { onConflict: 'user_id,year' });
  if (error) return { error: error.message };
  revalidatePath('/a81');
  return { ok: true };
}

/** Liste tous les overrides A81 du user (pour cache offline). */
export async function loadAllA81Overrides(): Promise<Array<{
  pairing_instance_id: string;
  deleted: boolean;
  debut_sejour_at: string | null;
  fin_sejour_at: string | null;
}>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data } = await supabase
    .from('user_a81_override')
    .select('pairing_instance_id, deleted, debut_sejour_at, fin_sejour_at')
    .eq('user_id', user.id);
  return data ?? [];
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
