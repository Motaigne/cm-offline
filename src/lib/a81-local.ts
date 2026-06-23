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
import { extractRotationsFromEp4 } from '@/lib/a81-ep4-match';
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

  // 5b. EP4 imports : on charge TOUS les PDFs Dexie (pas seulement ceux de
  //     l'année), car une rotation à cheval `year-1`/`year` ou `year`/`year+1`
  //     peut être présente dans le PDF du mois adjacent. Pour chaque rotation
  //     extraite, on filtre ensuite sur "touche l'année courante".
  const ep4ByMonth = new Map<string, Ep4PdfData>();
  {
    const all = await db.ep4_imports.toArray();
    for (const e of all) ep4ByMonth.set(e.monthIso, e.data);
  }

  // Lookup zone par rotation_code (table annexe `rotation_zones`, seedée par
  // la mig 0042 depuis le CSV `AF_Paie_Rot81 - zone.csv`). Surclasse le
  // fallback `zoneByEscale` (signatures cachées) pour les rotations EP4 qui
  // n'ont pas de correspondance dans le calendrier.
  const rotationZonesRow = pickAnnexeRowForMonth(annexeRows, 'rotation_zones', `${year}-01`);
  const zoneByRotationCode = new Map<string, string>();
  if (rotationZonesRow && typeof rotationZonesRow === 'object' && 'rotations' in rotationZonesRow) {
    const arr = (rotationZonesRow as { rotations: unknown }).rotations;
    if (Array.isArray(arr)) {
      for (const entry of arr) {
        if (entry && typeof entry === 'object' && 'rot' in entry && 'zone' in entry) {
          const e = entry as { rot: unknown; zone: unknown };
          if (typeof e.rot === 'string' && typeof e.zone === 'string') {
            zoneByRotationCode.set(e.rot, e.zone);
          }
        }
      }
    }
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

  // 6b. Lookup zone par escale_debut depuis les sigs cachées en Dexie. Sert
  //     aux rotations issues d'un EP4 (PDF ne contient pas la zone). Si une
  //     escale n'a pas de zone connue dans le cache → null (montant = 0).
  const zoneByEscale = new Map<string, string>();
  for (const sig of allRotations) {
    const esc = sig.escale_debut ?? sig.first_layover ?? '';
    if (esc && sig.zone && !zoneByEscale.has(esc)) zoneByEscale.set(esc, sig.zone);
  }

  // 7. Construit les rows. 2 sources possibles selon le mois :
  //   - EP4 importé pour M → rotations extraites du PDF (= source de vérité,
  //     on ignore les items calendrier de M).
  //   - Sinon                → items calendrier comme avant.
  const rows: A81Row[] = [];
  const deletedRows: A81DeletedRow[] = [];

  // ─── Branche EP4 ──────────────────────────────────────────────────────────
  // Set des mois "couverts" par un PDF EP4 (= les items calendrier de ces
  // mois sont ignorés dans la branche calendrier ci-dessous).
  const monthsCoveredByEp4 = new Set<string>();
  for (const [month, ep4] of ep4ByMonth) {
    monthsCoveredByEp4.add(month);
    const rotations = extractRotationsFromEp4(ep4);
    for (let i = 0; i < rotations.length; i++) {
      const rot = rotations[i];
      const debutMs = new Date(rot.debut_sejour_at).getTime();
      const finMs   = new Date(rot.fin_sejour_at).getTime();
      if (finMs <= debutMs) continue;
      // Filtre année : on garde la rotation si AU MOINS une de ses bornes
      // touche l'année courante. Une rotation à cheval `year-1`/`year` sera
      // donc émise depuis le PDF de `year-1` mais visible dans A81 `year`
      // (et splittée par `splitRotationAtMonth` en m0/m1).
      const debutYear = new Date(debutMs).getUTCFullYear();
      const finYear   = new Date(finMs).getUTCFullYear();
      if (debutYear !== year && finYear !== year) continue;

      const tempsSejH = (finMs - debutMs) / 3600000;
      const tSej24    = computeTSej24(tempsSejH);
      // Lookup zone : (1) rotation_code exact, (2) escale_debut seule,
      // (3) fallback sigs Dexie. Null si tout échoue → montant = 0.
      const zone = zoneByRotationCode.get(rot.rotation_code)
                ?? zoneByRotationCode.get(rot.escale_debut)
                ?? zoneByEscale.get(rot.escale_debut)
                ?? null;
      const taux      = lookupTauxSej(article81Data, zone, tempsSejH);
      const monthOfDepart = new Date(debutMs).toISOString().slice(0, 7);
      const vjResult = computeValeurJourForMonth(monthOfDepart);
      const instId = `ep4-${month}-${i}`;
      rows.push({
        instance_id: instId,
        debut_rotation: rot.debut_rotation,
        debut_sejour_at: rot.debut_sejour_at,
        debut_sejour_at_origin: rot.debut_sejour_at,
        escale_debut: rot.escale_debut,
        fin_sejour_at: rot.fin_sejour_at,
        fin_sejour_at_origin: rot.fin_sejour_at,
        escale_fin: rot.escale_fin,
        temps_sej_h: tempsSejH,
        nb_jours: tSej24,
        plafond: false,
        zone,
        taux,
        valeur_jour: vjResult.value,
        valeur_jour_breakdown: vjResult.breakdown,
        montant: 0,
        debut_sejour_overridden: false,
        fin_sejour_overridden: false,
        is_fictive: false,
        source: 'ep4',
      });
    }
  }

  // ─── Branche calendrier (uniquement mois SANS EP4 importé) ────────────────
  for (const it of items) {
    const itemMonth = it.start_date.slice(0, 7);
    if (monthsCoveredByEp4.has(itemMonth)) continue; // EP4 fait foi pour ce mois
    const instId = it.pairing_instance_id as string;
    const ov = ovByInstId.get(instId);
    const sig = sigByInstId.get(instId);
    if (!sig) continue;

    // Préférer les timestamps PAR INSTANCE (correct pour chaque date du mois)
    // plutôt que les timestamps signature (= absolus de l'instance capturée,
    // faux pour toutes les autres). Fallback signature.* pour cache obsolète
    // (avant ce fix, instance.debut_sejour_at n'existait pas).
    const instance = sig.instances.find(i => i.id === instId);
    const debutOrigin = instance?.debut_sejour_at ?? sig.debut_sejour_at;
    const finOrigin   = instance?.fin_sejour_at   ?? sig.fin_sejour_at;
    if (!debutOrigin || !finOrigin) continue;

    const escaleDebut = sig.escale_debut ?? sig.first_layover ?? '';
    const escaleFin   = sig.escale_fin   ?? sig.first_layover ?? '';

    const debutRotation = instance ? instance.depart_at.slice(0, 10) : debutOrigin.slice(0, 10);

    if (ov?.deleted) {
      deletedRows.push({ instance_id: instId, debut_rotation: debutRotation, escale_debut: escaleDebut, escale_fin: escaleFin });
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
      source: 'calendrier',
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
