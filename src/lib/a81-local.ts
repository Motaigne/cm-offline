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
import {
  computeTSej24,
  lookupTauxSej,
  getPlafondJours,
  computeValeurJour,
  type Article81Data,
} from '@/lib/article81';
import {
  computeFullProfile,
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

  // 6. Helper valeur_jour par mois (cache local)
  const valeurJourCache = new Map<string, number>();
  function computeValeurJourForMonth(month: string): number {
    const cached = valeurJourCache.get(month);
    if (cached != null) return cached;
    const prof = pickProfileForMonth(profileVersions, month);
    if (!prof?.fonction || !prof.classe || !prof.echelon || !prof.categorie) {
      valeurJourCache.set(month, 600);
      return 600;
    }
    const annexe = getAnnexeDataFromRows(annexeRows, month);
    const hasAnnexe = !!(
      annexe.cat_anciennete?.length &&
      annexe.coef_classe?.length &&
      annexe.taux_avion?.length &&
      annexe.traitement_base
    );
    if (!hasAnnexe) {
      const v = Number(prof.valeur_jour ?? 600);
      valeurJourCache.set(month, v);
      return v;
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
    const v = computeValeurJour({
      fixe: c.fixe, pvei: c.pvei, ksp: c.ksp, primeInstruction: c.primeInstruction, isTri,
    });
    valeurJourCache.set(month, v);
    return v;
  }

  // 7. Construit les rows
  const rows: A81Row[] = [];
  const deletedRows: A81DeletedRow[] = [];
  for (const it of items) {
    const instId = it.pairing_instance_id as string;
    const ov = ovByInstId.get(instId);
    const sig = sigByInstId.get(instId);
    if (!sig?.debut_sejour_at || !sig.fin_sejour_at) continue;

    const debutOrigin = sig.debut_sejour_at;
    const finOrigin   = sig.fin_sejour_at;
    const escaleDebut = sig.escale_debut ?? sig.first_layover ?? '';
    const escaleFin   = sig.escale_fin   ?? sig.first_layover ?? '';

    // Trouve l'instance dans sig.instances pour récupérer depart_at
    const instance = sig.instances.find(i => i.id === instId);
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
    const valeurJour = computeValeurJourForMonth(monthOfDepart);

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
      valeur_jour: valeurJour,
      montant: 0,
      debut_sejour_overridden: !!ov?.debut_sejour_at,
      fin_sejour_overridden:   !!ov?.fin_sejour_at,
    });
  }

  // 8. Tri + dédup + plafond running
  const seen = new Set<string>();
  rows.sort((a, b) => a.debut_sejour_at.localeCompare(b.debut_sejour_at));
  const unique = rows.filter(r => { if (seen.has(r.instance_id)) return false; seen.add(r.instance_id); return true; });

  let cumul = 0;
  let montantTotal = 0;
  for (const r of unique) {
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

  const montantExo = plafondExoBrut != null && plafondExoBrut > 0
    ? Math.min(0.4 * plafondExoBrut, montantTotal) : 0;
  const montantNetExo = 0.818 * montantExo;

  return {
    year,
    rows: unique,
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
