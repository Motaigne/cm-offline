// Typed helpers for annexe_table JSONB data + derived financial constants

export interface CatAnciennete { categorie: string; echelon: number; coefficient: number; }
export interface CoefClasse    { role: 'CDB' | 'OPL'; classe: number; coefficient: number; }
export interface TauxAvion     { avion: string; taux: number; }
export interface PrimeIncitation     { role: 'CDB' | 'OPL'; type: 'LC' | 'MC'; montant: number; }
export interface PrimeInstruction {
  icpl_a1: number;       // valeur année 1 pour ICPL (TRI_CDB)
  tri_opl_b1: number;    // valeur année 1 pour TRI_OPL
  multiplier: number;    // progression annuelle (ex. 1.05)
  max_annee: number;     // au-delà : valeur figée (ex. 5 = "5 ou plus")
}
export interface PrimeIncitation330  { seuil: string; mois_max?: number; avions_max?: number; valeur_pvei: number; }
export interface TraitementBase      { base_cdb_a1: number; coef_opl: number; note?: string; }

export interface AnnexeData {
  cat_anciennete:        CatAnciennete[];
  coef_classe:           CoefClasse[];
  taux_avion:            TauxAvion[];
  prime_incitation:      PrimeIncitation[];
  prime_incitation_330?: PrimeIncitation330[];
  prime_instruction:     PrimeInstruction;
  traitement_base:       TraitementBase;
}

export const KSP = 1.07;

// Row brute de annexe_table (versionnée). Sérialisable → traverse la frontière
// serveur/client sans souci.
export interface AnnexeRow { slug: string; valid_from: string; data: unknown; }

/**
 * Version client-side de `loadAnnexeForMonth` : à partir de toutes les rows
 * versionnées de annexe_table, renvoie la version applicable au mois cible
 * (valid_from <= 1er du mois, plus récente). Utilisé par le calendrier pour
 * recomputer instantanément lors d'un changeMonth, sans round-trip serveur.
 */
export function getAnnexeDataFromRows(rows: AnnexeRow[], month: string): Partial<AnnexeData> {
  const cutoff = /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : month;
  const sorted = [...rows].sort((a, b) => b.valid_from.localeCompare(a.valid_from));
  const map = new Map<string, unknown>();
  for (const r of sorted) {
    if (r.valid_from > cutoff) continue;
    if (!map.has(r.slug)) map.set(r.slug, r.data);
  }
  const u = Object.fromEntries(map) as Record<string, unknown>;
  return {
    cat_anciennete:        (u.cat_anciennete        ?? []) as AnnexeData['cat_anciennete'],
    coef_classe:           (u.coef_classe           ?? []) as AnnexeData['coef_classe'],
    taux_avion:            (u.taux_avion            ?? []) as AnnexeData['taux_avion'],
    prime_incitation:      (u.prime_incitation      ?? []) as AnnexeData['prime_incitation'],
    prime_incitation_330:  (u.prime_incitation_330  ?? []) as AnnexeData['prime_incitation_330'],
    prime_instruction:     (u.prime_instruction     ?? { icpl_a1: 0, tri_opl_b1: 0, multiplier: 1, max_annee: 5 }) as AnnexeData['prime_instruction'],
    traitement_base:       (u.traitement_base       ?? { base_cdb_a1: 2559.19, coef_opl: 0.665 }) as AnnexeData['traitement_base'],
  };
}

// Coefficient catégorie pour PVEI (CCT AF)
// Catégorie A = 0.70, B = 0.85, C = 1.00
const CAT_PVEI: Record<string, number> = { A: 0.70, B: 0.85, C: 1.00 };

function toRole(fonction: string): 'CDB' | 'OPL' {
  return (fonction === 'CDB' || fonction === 'TRI_CDB') ? 'CDB' : 'OPL';
}

// Prime d'instruction : compound depuis valeur arrondie (chaque année
// = round(année_précédente × multiplier)), arrondi 2 décimales.
// Au-delà de max_annee, valeur figée (= prime de max_annee).
export function computePrimeInstructionMontant(
  cfg: PrimeInstruction,
  fonction: string,
  annee: number,
): number {
  const base = fonction === 'ICPL'    ? cfg.icpl_a1
             : fonction === 'TRI_OPL' ? cfg.tri_opl_b1
             : 0;
  if (!base || annee < 1) return 0;
  const n = Math.min(annee, cfg.max_annee);
  let v = base;
  for (let i = 1; i < n; i++) v = Math.round(v * cfg.multiplier * 100) / 100;
  return v;
}

// PVEI = Taux_avion × (Coef_Classe + ATPL) × Cat_PVEI
export function computePVEI(
  aircraft: string,
  fonction: string,
  classe: number,
  categorie: string,   // 'A' | 'B' | 'C'
  atpl: boolean,
  a: AnnexeData,
): number {
  const role  = toRole(fonction);
  const taux  = a.taux_avion.find(r => r.avion === aircraft)?.taux ?? 103.39;
  const coefC = a.coef_classe.find(r => r.role === role && r.classe === classe)?.coefficient ?? 1.03;
  const cat   = CAT_PVEI[categorie] ?? 1.0;
  return taux * (coefC + (atpl ? 0.06 : 0)) * cat;
}

// Fixe = Base_CDB_A1 × Coef_FO_CDB × Coef_Échelon × (nb30e/30)
export function computeFixe(
  echelon: number,
  fonction: string,
  nb30e: number,
  a: AnnexeData,
): number {
  const role    = toRole(fonction);
  const coefF   = role === 'OPL' ? a.traitement_base.coef_opl : 1.0;
  const coefEch = a.cat_anciennete.find(r => r.echelon === echelon)?.coefficient ?? 1.4;
  return a.traitement_base.base_cdb_a1 * coefF * coefEch * (nb30e / 30);
}

/**
 * Profil minimal nécessaire pour dériver PVEI à partir des rows annexe.
 * Champs alignés sur `user_profile_version` (Row['public']['Tables'][...]).
 */
export interface FinanceProfileLite {
  aircraft_principal: string | null;
  fonction: string | null;
  classe: number | null;
  categorie: string | null;
  bonus_atpl: boolean | null;
}

/**
 * Calcule (PVEI, KSP) pour le profil utilisateur applicable à un mois donné, à
 * partir des rows annexe versionnées + la liste des versions de profil. Utilisé
 * par catalogue / comparatif pour que la colonne Total € reflète le profil de
 * l'utilisateur connecté (et pas les constantes par défaut OPL A335 Cl.2/C/4).
 *
 * Renvoie null si annexe ou profil incomplet → le caller doit fallback aux
 * constantes legacy.
 */
export function getPveiKspForMonth<T extends FinanceProfileLite & { valid_from: string }>(
  profileVersions: T[],
  annexeRows: AnnexeRow[],
  month: string,
): { pvei: number; ksp: number } | null {
  const cutoff = /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : month;
  const prof = [...profileVersions]
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from))
    .find(v => v.valid_from <= cutoff);
  if (!prof?.fonction || !prof.classe || !prof.categorie) return null;
  const annexe = getAnnexeDataFromRows(annexeRows, month);
  if (!annexe.taux_avion?.length || !annexe.coef_classe?.length) return null;
  const pvei = computePVEI(
    prof.aircraft_principal ?? 'A335',
    prof.fonction,
    prof.classe,
    prof.categorie,
    prof.bonus_atpl ?? false,
    annexe as AnnexeData,
  );
  return { pvei, ksp: KSP };
}

export function computeFullProfile(
  aircraft: string,
  fonction: string,
  classe: number,
  categorie: string,
  echelon: number,
  atpl: boolean,
  nb30e: number,
  primeIncitationType: 'LC' | 'MC',
  primeInstFonction: string | null,
  primeInstAnnee: number | null,
  prime330Count: number | null,
  a: AnnexeData,
) {
  const pvei  = computePVEI(aircraft, fonction, classe, categorie, atpl, a);
  const fixe  = computeFixe(echelon, fonction, nb30e, a);
  const fixeTP = computeFixe(echelon, fonction, 30, a);
  const role  = toRole(fonction);
  const pi    = a.prime_incitation.find(r => r.role === role && r.type === primeIncitationType)?.montant ?? 0;
  const primeBiTroncon = 2.5 * pvei;
  const mga   = fixe + 85 * (nb30e / 30) * pvei;
  const mgaTP = fixeTP + 85 * pvei;
  const hsSeuil = 75 * (nb30e / 30);

  // Prime instruction : proratisée par nb30e/30 comme A330 (CCT pilote).
  // Stockée comme a1/b1 + multiplier ; années 2+ calculées (compound depuis arrondi).
  let primeInstruction = 0;
  if (primeInstFonction && primeInstAnnee) {
    const montant = computePrimeInstructionMontant(a.prime_instruction, primeInstFonction, primeInstAnnee);
    primeInstruction = montant * (nb30e / 30);
  }

  // Prime A330 — formule : valeur_pvei × PVEI × (nb30e/30) (proratisée selon le régime).
  // Lookup : on classe les tiers par valeur_pvei décroissante puis on mappe le
  // count choisi (5 / 7 / 9) à un index :
  //   count=5 → index 0 (tier le plus généreux, ex: 20 × PVEI)
  //   count=7 → index 1 (ex: 15 × PVEI)
  //   count=9 → index 2 (ex: 10 × PVEI)
  // Hypothèse : la table annexe `prime_incitation_330` contient au moins 3 tiers
  // dans cet ordre. À ajuster si la donnée évolue (lookup direct par avions_max).
  let primeA330 = 0;
  if (prime330Count != null && a.prime_incitation_330?.length) {
    const tiers = [...a.prime_incitation_330].sort((a, b) => b.valeur_pvei - a.valeur_pvei);
    const idxByCount: Record<number, number> = { 5: 0, 7: 1, 9: 2 };
    const idx = idxByCount[prime330Count];
    const tier = idx !== undefined ? tiers[idx] : undefined;
    if (tier) {
      primeA330 = tier.valeur_pvei * pvei * (nb30e / 30);
    }
  }

  return {
    pvei, ksp: KSP, fixe, fixeTP,
    primeBiTroncon, primeIncitation: pi,
    primeInstruction, primeA330,
    mga, mgaTP, hsSeuil,
  };
}
