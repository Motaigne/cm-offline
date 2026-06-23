/**
 * Compute A81 client-side depuis le cache Dexie. Réplique la logique de
 * `actions/a81.loadA81ForYear` sans appel réseau — utilisé pour offline.
 *
 * Sources :
 *   - db.drafts / db.items   : planning ligne A
 *   - db.rotations           : signatures cachées (avec debut/fin séjour + escales)
 *   - loadProfileVersionsLocal : pour valeur_jour computée
 *   - loadAnnexeRowsLocal      : pour article_81 (taux) + annexe versionnée
 *
 * Les overrides utilisateur (édit/delete) sont passés en argument (chargés
 * indépendamment depuis le serveur ou Dexie).
 */

import {
  db,
  loadProfileVersionsLocal,
  loadAnnexeRowsLocal,
  loadA81YearDataLocal,
} from '@/lib/local-db';
import { findEp4SejourMatch } from '@/lib/a81-ep4-match';
import type { Ep4PdfData } from '@/lib/ep4-pdf-parse';
import {
  computeTSej24,
  lookupTauxSej,
  getPlafondJours,
  computeValeurJour,
  splitRotationAtMonth,
  TAXI_TSEJ_ADJUST_H,
  type Article81Data,
} from '@/lib/article81';
import {
  computeFullProfile,
  computePrimeInstructionMontant,
  getAnnexeDataFromRows,
  type AnnexeData,
  type AnnexeRow,
} from '@/lib/annexe';
import { REGIME_NB30E } from '@/lib/finance';
import type { A81YearData, A81Row, A81DeletedRow } from '@/app/actions/a81';
import type { ProfileVersion } from '@/app/actions/profile-version';

/** Override en mémoire (= chargé depuis serveur ou queue locale). */
export interface A81OverrideLocal {
  pairing_instance_id: string;
  deleted: boolean;
  debut_sejour_at: string | null;
  fin_sejour_at:   string | null;
}

/**
 * Cumul tSej24 par scénario A/B/C pour les rotations placées dans les mois
 * Jan→month-1 de l'année donnée. Réplique `getYearA81CumulBefore` (serveur)
 * 100% depuis Dexie, pour usage offline ou pour éviter le round-trip lors
 * d'une navigation client-side dans le calendrier.
 *
 * Sources Dexie :
 *   - db.drafts    : pour récupérer le scénario (name) de chaque draft
 *   - db.items     : planning_items (kind=flight) avec pairing_instance_id
 *   - db.rotations : signature → instances[] + temps_sej
 */
export async function computeA81CumulBeforeLocal(
  year: number,
  month: number,
): Promise<{ byScenarioBefore: Record<'A' | 'B' | 'C', number> }> {
  const result = { byScenarioBefore: { A: 0, B: 0, C: 0 } as Record<'A' | 'B' | 'C', number> };

  const yearPrefix    = String(year);
  const monthStartStr = `${year}-${String(month).padStart(2, '0')}`;
  const allDrafts = await db.drafts.toArray();
  // Mois Jan..month-1 de l'année : target_month commence par `year-` et est < `year-month`.
  const eligibleDrafts = allDrafts.filter(d =>
    d.target_month.startsWith(`${yearPrefix}-`) && d.target_month < monthStartStr,
  );
  if (eligibleDrafts.length === 0) return result;

  const draftScenario = new Map<string, 'A' | 'B' | 'C'>();
  for (const d of eligibleDrafts) {
    if (d.name === 'A' || d.name === 'B' || d.name === 'C') {
      draftScenario.set(d.id, d.name);
    }
  }
  if (draftScenario.size === 0) return result;

  const items = (await db.items.where('draft_id').anyOf([...draftScenario.keys()]).toArray())
    .filter(i => i.kind === 'flight' && i.pairing_instance_id);
  if (items.length === 0) return result;

  // Mapping pairing_instance.id → rotation (qui porte temps_sej).
  const rotations = await db.rotations.toArray();
  const tSejByInstId = new Map<string, number>();
  for (const r of rotations) {
    const tSej = Number(r.temps_sej ?? 0);
    for (const inst of r.instances) tSejByInstId.set(inst.id, tSej);
  }

  for (const it of items) {
    const name = draftScenario.get(it.draft_id);
    if (!name) continue;
    const tSej = tSejByInstId.get(it.pairing_instance_id as string);
    if (tSej == null) continue;
    // r.temps_sej = block-to-block depuis le scraper, sans compensation taxi.
    result.byScenarioBefore[name] += computeTSej24(tSej + TAXI_TSEJ_ADJUST_H);
  }
  return result;
}

/** Sélectionne la version annexe applicable pour un slug donné + un mois.
 *  Renvoie la `data` brute (pas typée) ou null si pas de version. */
function pickAnnexeRowForMonth(rows: AnnexeRow[], slug: string, month: string): unknown {
  const cutoff = `${month}-01`;
  const sorted = rows
    .filter(r => r.slug === slug && r.valid_from <= cutoff)
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from));
  return sorted[0]?.data ?? null;
}

/** Sélectionne la version du profil applicable pour un mois. */
function pickProfileForMonth(versions: ProfileVersion[], month: string): ProfileVersion | null {
  const cutoff = `${month}-01`;
  const sorted = [...versions].sort((a, b) => b.valid_from.localeCompare(a.valid_from));
  return sorted.find(v => v.valid_from <= cutoff) ?? sorted[sorted.length - 1] ?? null;
}

export async function computeA81ForYearLocal(
  year: number,
  overrides: A81OverrideLocal[] = [],
  /** Fallback : si les rotations ne sont pas en cache Dexie pour ce mois
   *  (typique pour un mois jamais sync'd), on hérite des rows initialData
   *  serveur ET on y applique les overrides locaux pour que les édits
   *  utilisateur (debut/fin séjour) soient visibles immédiatement sans
   *  attendre le round-trip serveur. */
  initialDataFallback: A81YearData | null = null,
): Promise<A81YearData> {
  // 1. Drafts ligne A de l'année
  const allDrafts = await db.drafts.toArray();
  const aDrafts = allDrafts.filter(
    d => d.name === 'A' && d.target_month.startsWith(String(year)),
  );

  // 2. Profil + annexe pour plafond et valeur_jour
  const [profileVersions, annexeRows] = await Promise.all([
    loadProfileVersionsLocal(),
    loadAnnexeRowsLocal(),
  ]);
  const profileJan = pickProfileForMonth(profileVersions, `${year}-01`);
  const regime = profileJan?.regime ?? null;
  const plafondJours = regime ? getPlafondJours(regime) : 70;
  const article81Data = pickAnnexeRowForMonth(annexeRows, 'article_81', `${year}-01`) as Article81Data | null;

  // Données année (plafond exo brut saisi par user)
  const yearLocal = await loadA81YearDataLocal(year);
  const plafondExoBrut = yearLocal?.plafond_exo_brut ?? null;

  const empty: A81YearData = {
    year, rows: [], deleted_rows: [],
    nb_total_jours: 0, cumul_jours: 0,
    plafond_jours: plafondJours, montant_total: 0,
    regime_used: regime,
    plafond_exo_brut: plafondExoBrut, montant_exo: 0, montant_net_exo: 0,
  };
  if (aDrafts.length === 0) return empty;

  // 3. Items flight des drafts A
  const draftIds = aDrafts.map(d => d.id);
  const items = (await db.items.where('draft_id').anyOf(draftIds).toArray())
    .filter(i => i.kind === 'flight' && i.pairing_instance_id);
  if (items.length === 0) return empty;

  // 4. Rotations cachées → map pairing_instance.id → signature
  const allRotations = await db.rotations.toArray();
  const sigByInstId = new Map<string, typeof allRotations[number]>();
  for (const r of allRotations) {
    for (const inst of r.instances) sigByInstId.set(inst.id, r);
  }

  // 5. Overrides indexés
  const ovByInstId = new Map(overrides.map(o => [o.pairing_instance_id, o]));

  // 5b. EP4 imports de l'année : si présent pour un mois donné, on s'en sert
  //     comme source de vérité (block-off/block-on REELS) à la place du
  //     raw_detail. Cf src/lib/a81-ep4-match.ts. On charge tous les mois en
  //     une fois pour ne pas multiplier les reads Dexie.
  const ep4ByMonth = new Map<string, Ep4PdfData>();
  {
    const all = await db.ep4_imports
      .where('monthIso').startsWith(String(year))
      .toArray();
    for (const e of all) ep4ByMonth.set(e.monthIso, e.data);
  }

  // 6. Helper valeur_jour par mois (cache local). Retourne aussi le breakdown
  //    des composantes pour affichage formule détaillée dans le footer fiscal.
  type ValeurJourResult = {
    value: number;
    breakdown?: NonNullable<A81Row['valeur_jour_breakdown']>;
  };
  const valeurJourCache = new Map<string, ValeurJourResult>();
  function computeValeurJourForMonth(month: string): ValeurJourResult {
    const cached = valeurJourCache.get(month);
    if (cached != null) return cached;
    const prof = pickProfileForMonth(profileVersions, month);
    if (!prof?.fonction || !prof.classe || !prof.echelon || !prof.categorie) {
      const r: ValeurJourResult = { value: 600 };
      valeurJourCache.set(month, r);
      return r;
    }
    const annexe = getAnnexeDataFromRows(annexeRows, month);
    const hasAnnexe = !!(
      annexe.cat_anciennete?.length &&
      annexe.coef_classe?.length &&
      annexe.taux_avion?.length &&
      annexe.traitement_base
    );
    if (!hasAnnexe) {
      const r: ValeurJourResult = { value: Number(prof.valeur_jour ?? 600) };
      valeurJourCache.set(month, r);
      return r;
    }
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
    // Valeur Jour utilise le FIXE TEMPS PLEIN (non proratisé par régime) et
    // la prime instruction NON proratisée — la formule s'applique au pilote
    // « théorique 100% » pour calculer la valeur d'une journée d'absence,
    // indépendamment du régime de travail réel.
    const fixeForVj = c.fixeTP;
    let primeInstForVj = 0;
    if (primeInstFonction && isTri && prof.tri_niveau && annexe.prime_instruction) {
      primeInstForVj = computePrimeInstructionMontant(
        annexe.prime_instruction, primeInstFonction, prof.tri_niveau,
      );
    }
    const value = computeValeurJour({
      fixe: fixeForVj, pvei: c.pvei, ksp: c.ksp, primeInstruction: primeInstForVj, isTri,
    });
    const r: ValeurJourResult = {
      value,
      breakdown: {
        fixe:             fixeForVj,
        pvei:             c.pvei,
        ksp:              c.ksp,
        primeInstruction: primeInstForVj,
        isTri,
      },
    };
    valeurJourCache.set(month, r);
    return r;
  }

  // 7. Construit les rows
  const rows: A81Row[] = [];
  const deletedRows: A81DeletedRow[] = [];
  for (const it of items) {
    const instId = it.pairing_instance_id as string;
    const ov = ovByInstId.get(instId);
    const sig = sigByInstId.get(instId);
    if (!sig) continue;

    // Préférer les timestamps PAR INSTANCE (correct pour chaque date du mois)
    // plutôt que les timestamps signature (= absolus de l'instance capturée,
    // faux pour toutes les autres). Fallback signature.* pour cache obsolète
    // (avant ce fix, instance.debut_sejour_at n'existait pas).
    const instance = sig.instances.find(i => i.id === instId);
    let debutOrigin = instance?.debut_sejour_at ?? sig.debut_sejour_at;
    let finOrigin   = instance?.fin_sejour_at   ?? sig.fin_sejour_at;
    if (!debutOrigin || !finOrigin) continue;

    const escaleDebut = sig.escale_debut ?? sig.first_layover ?? '';
    const escaleFin   = sig.escale_fin   ?? sig.first_layover ?? '';

    const debutRotation = instance ? instance.depart_at.slice(0, 10) : debutOrigin.slice(0, 10);

    if (ov?.deleted) {
      deletedRows.push({ instance_id: instId, debut_rotation: debutRotation, escale_debut: escaleDebut, escale_fin: escaleFin });
      continue;
    }

    // Source EP4 si dispo : on REMPLACE debutOrigin/finOrigin par les valeurs
    // recomposées depuis les block-off/block-on réels du PDF. Les overrides
    // user (`ov.*_sejour_at`) s'appliquent toujours par-dessus.
    //
    // Règle stricte : si un EP4 est importé pour le mois de la rotation (=
    // mois du debutRotation), l'EP4 fait FOI. Les rotations du calendrier qui
    // ne matchent aucune row de l'EP4 sont considérées comme des fantômes du
    // planning AF (vol annulé, échangé, etc.) et écartées du tableau A81.
    let source: 'ep4' | 'calendrier' = 'calendrier';
    const ep4Match = findEp4SejourMatch(escaleDebut, escaleFin, debutOrigin, finOrigin, ep4ByMonth);
    if (ep4Match) {
      debutOrigin = ep4Match.debut_sejour_at;
      finOrigin   = ep4Match.fin_sejour_at;
      source = 'ep4';
    } else if (ep4ByMonth.has(debutRotation.slice(0, 7))) {
      // EP4 dispo pour le mois mais aucun match → drop (rotation absente du
      // décompte AF réel).
      continue;
    }

    const debutMs = (ov?.debut_sejour_at ? new Date(ov.debut_sejour_at).getTime() : new Date(debutOrigin).getTime());
    const finMs   = (ov?.fin_sejour_at   ? new Date(ov.fin_sejour_at).getTime()   : new Date(finOrigin).getTime());
    if (finMs <= debutMs) continue;
    const tempsSejH = (finMs - debutMs) / 3600000;
    const tSej24    = computeTSej24(tempsSejH);
    const taux      = lookupTauxSej(article81Data, sig.zone, tempsSejH);
    const monthOfDepart = new Date(debutMs).toISOString().slice(0, 7);
    const vjResult = computeValeurJourForMonth(monthOfDepart);

    rows.push({
      instance_id: instId,
      debut_rotation: debutRotation,
      debut_sejour_at: new Date(debutMs).toISOString(),
      debut_sejour_at_origin: debutOrigin,
      escale_debut: escaleDebut,
      fin_sejour_at: new Date(finMs).toISOString(),
      fin_sejour_at_origin: finOrigin,
      escale_fin: escaleFin,
      temps_sej_h: tempsSejH,
      nb_jours: tSej24,
      plafond: false,
      zone: sig.zone,
      taux,
      valeur_jour: vjResult.value,
      valeur_jour_breakdown: vjResult.breakdown,
      montant: 0,
      debut_sejour_overridden: !!ov?.debut_sejour_at,
      fin_sejour_overridden:   !!ov?.fin_sejour_at,
      is_fictive: sig.is_fictive === true,
      source,
    });
  }

  // 8. Tri + dédup + expansion split + plafond running
  const seen = new Set<string>();
  rows.sort((a, b) => a.debut_sejour_at.localeCompare(b.debut_sejour_at));
  const unique = rows.filter(r => { if (seen.has(r.instance_id)) return false; seen.add(r.instance_id); return true; });

  // Expansion rotations à cheval (cf. server actions/a81.ts pour la règle).
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
    const m0Result = computeValeurJourForMonth(m0DebutAt.slice(0, 7));
    const m1Result = computeValeurJourForMonth(m1DebutAt.slice(0, 7));
    expanded.push({
      ...r,
      debut_sejour_at: m0DebutAt,
      fin_sejour_at:   m0FinAt,
      nb_jours:        split.m0.nbJours,
      valeur_jour:           m0Result.value,
      valeur_jour_breakdown: m0Result.breakdown,
      montant:         0,
      fin_sejour_overridden: false,
      split_part: 'm0',
    });
    expanded.push({
      ...r,
      debut_sejour_at: m1DebutAt,
      fin_sejour_at:   m1FinAt,
      nb_jours:        split.m1.nbJours,
      valeur_jour:           m1Result.value,
      valeur_jour_breakdown: m1Result.breakdown,
      montant:         0,
      debut_sejour_overridden: false,
      split_part: 'm1',
    });
  }
  expanded.sort((a, b) => a.debut_sejour_at.localeCompare(b.debut_sejour_at));

  let cumul = 0;
  let montantTotal = 0;
  for (const r of expanded) {
    if (r.nb_jours === 0 || r.taux == null) { r.montant = 0; continue; }
    if (cumul + r.nb_jours > plafondJours) {
      r.plafond = true; r.montant = 0; cumul += r.nb_jours;
    } else {
      cumul += r.nb_jours;
      r.montant = r.valeur_jour * r.taux * r.nb_jours;
      montantTotal += r.montant;
    }
  }

  const seenDel = new Set<string>();
  const uniqueDeleted = deletedRows
    .filter(r => { if (seenDel.has(r.instance_id)) return false; seenDel.add(r.instance_id); return true; })
    .sort((a, b) => a.debut_rotation.localeCompare(b.debut_rotation));

  // Fallback : rotations pas en cache Dexie (cas typique : mois jamais sync'd
  // mais drafts présents). Plutôt que de retourner 0 rows et de laisser
  // l'appelant utiliser initialDataFallback BRUT (= snapshot pré-édit côté
  // serveur, taux figé sur la valeur d'avant l'override), on applique les
  // overrides aux rows initialData ici pour que les édits soient visibles.
  let finalRows = expanded;
  let finalDeleted = uniqueDeleted;
  let finalCumul = cumul;
  let finalMontantTotal = montantTotal;

  if (expanded.length === 0 && initialDataFallback && initialDataFallback.rows.length > 0) {
    const fb = applyOverridesToInitialRows(
      initialDataFallback,
      overrides,
      article81Data,
      plafondJours,
      computeValeurJourForMonth,
    );
    finalRows = fb.rows;
    finalDeleted = fb.deletedRows;
    finalCumul = fb.cumul;
    finalMontantTotal = fb.montantTotal;
  }

  const montantExo = plafondExoBrut != null && plafondExoBrut > 0
    ? Math.min(0.4 * plafondExoBrut, finalMontantTotal) : 0;
  const montantNetExo = 0.818 * montantExo;

  return {
    year,
    rows: finalRows,
    deleted_rows: finalDeleted,
    nb_total_jours: Math.min(plafondJours, finalCumul),
    cumul_jours: finalCumul,
    plafond_jours: plafondJours,
    montant_total: finalMontantTotal,
    regime_used: regime,
    plafond_exo_brut: plafondExoBrut,
    montant_exo: montantExo,
    montant_net_exo: montantNetExo,
  };
}

/** Applique les overrides aux rows initialData (serveur) pour produire un
 *  set de rows à jour quand on n'a pas les rotations en cache Dexie. Re-run
 *  ensuite split + plafond pour cohérence. */
function applyOverridesToInitialRows(
  initialData: A81YearData,
  overrides: A81OverrideLocal[],
  article81Data: Article81Data | null,
  plafondJours: number,
  computeValeurJourForMonth: (month: string) => { value: number; breakdown?: NonNullable<A81Row['valeur_jour_breakdown']> },
): { rows: A81Row[]; deletedRows: A81DeletedRow[]; cumul: number; montantTotal: number } {
  const ovByInstId = new Map(overrides.map(o => [o.pairing_instance_id, o]));
  // Les rows initialData peuvent être déjà SPLIT (m0/m1) avec instance_id
  // dupliqué. On dédup par instance_id en gardant celui avec split_part=undefined
  // si présent, sinon le 1er — pour repartir d'une base "non splittée".
  const seen = new Set<string>();
  const baseRows: A81Row[] = [];
  for (const r of initialData.rows) {
    if (seen.has(r.instance_id)) continue;
    seen.add(r.instance_id);
    baseRows.push(r);
  }

  // Reconstruit les rows en appliquant les overrides. Les supprimés
  // partent en deletedRows.
  const rebuilt: A81Row[] = [];
  const deletedRows: A81DeletedRow[] = [...initialData.deleted_rows];
  for (const r of baseRows) {
    const ov = ovByInstId.get(r.instance_id);
    if (ov?.deleted) {
      deletedRows.push({
        instance_id: r.instance_id,
        debut_rotation: r.debut_rotation,
        escale_debut: r.escale_debut,
        escale_fin: r.escale_fin,
      });
      continue;
    }
    const debutMs = ov?.debut_sejour_at ? new Date(ov.debut_sejour_at).getTime() : new Date(r.debut_sejour_at_origin).getTime();
    const finMs   = ov?.fin_sejour_at   ? new Date(ov.fin_sejour_at).getTime()   : new Date(r.fin_sejour_at_origin).getTime();
    if (finMs <= debutMs) continue;
    const tempsSejH = (finMs - debutMs) / 3600000;
    const tSej24    = computeTSej24(tempsSejH);
    const taux      = lookupTauxSej(article81Data, r.zone, tempsSejH);
    const monthOfDepart = new Date(debutMs).toISOString().slice(0, 7);
    const vjResult = computeValeurJourForMonth(monthOfDepart);
    rebuilt.push({
      ...r,
      debut_sejour_at: new Date(debutMs).toISOString(),
      fin_sejour_at:   new Date(finMs).toISOString(),
      temps_sej_h: tempsSejH,
      nb_jours: tSej24,
      plafond: false,
      taux,
      valeur_jour: vjResult.value,
      valeur_jour_breakdown: vjResult.breakdown,
      montant: 0,
      debut_sejour_overridden: !!ov?.debut_sejour_at,
      fin_sejour_overridden:   !!ov?.fin_sejour_at,
      split_part: undefined,
    });
  }

  rebuilt.sort((a, b) => a.debut_sejour_at.localeCompare(b.debut_sejour_at));

  // Expansion split (rotations à cheval).
  const expanded: A81Row[] = [];
  for (const r of rebuilt) {
    const debutMs = new Date(r.debut_sejour_at).getTime();
    const finMs   = new Date(r.fin_sejour_at).getTime();
    const split = splitRotationAtMonth(debutMs, finMs, r.nb_jours);
    if (!split) { expanded.push(r); continue; }
    const m0DebutAt = new Date(split.m0.debutMs).toISOString();
    const m0FinAt   = new Date(split.m0.finMs).toISOString();
    const m1DebutAt = new Date(split.m1.debutMs).toISOString();
    const m1FinAt   = new Date(split.m1.finMs).toISOString();
    const m0Result = computeValeurJourForMonth(m0DebutAt.slice(0, 7));
    const m1Result = computeValeurJourForMonth(m1DebutAt.slice(0, 7));
    expanded.push({
      ...r,
      debut_sejour_at: m0DebutAt, fin_sejour_at: m0FinAt,
      nb_jours: split.m0.nbJours,
      valeur_jour: m0Result.value, valeur_jour_breakdown: m0Result.breakdown,
      montant: 0, fin_sejour_overridden: false, split_part: 'm0',
    });
    expanded.push({
      ...r,
      debut_sejour_at: m1DebutAt, fin_sejour_at: m1FinAt,
      nb_jours: split.m1.nbJours,
      valeur_jour: m1Result.value, valeur_jour_breakdown: m1Result.breakdown,
      montant: 0, debut_sejour_overridden: false, split_part: 'm1',
    });
  }
  expanded.sort((a, b) => a.debut_sejour_at.localeCompare(b.debut_sejour_at));

  // Plafond running.
  let cumul = 0;
  let montantTotal = 0;
  for (const r of expanded) {
    if (r.nb_jours === 0 || r.taux == null) { r.montant = 0; continue; }
    if (cumul + r.nb_jours > plafondJours) {
      r.plafond = true; r.montant = 0; cumul += r.nb_jours;
    } else {
      cumul += r.nb_jours;
      r.montant = r.valeur_jour * r.taux * r.nb_jours;
      montantTotal += r.montant;
    }
  }

  const seenDel = new Set<string>();
  const uniqueDeleted = deletedRows
    .filter(r => { if (seenDel.has(r.instance_id)) return false; seenDel.add(r.instance_id); return true; })
    .sort((a, b) => a.debut_rotation.localeCompare(b.debut_rotation));

  return { rows: expanded, deletedRows: uniqueDeleted, cumul, montantTotal };
}
