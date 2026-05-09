// Typed helpers for annexe_table JSONB data + derived financial constants

export interface CatAnciennete { categorie: string; echelon: number; coefficient: number; }
export interface CoefClasse    { role: 'CDB' | 'OPL'; classe: number; coefficient: number; }
export interface TauxAvion     { avion: string; taux: number; }
export interface PrimeIncitation     { role: 'CDB' | 'OPL'; type: 'LC' | 'MC'; montant: number; }
export interface PrimeInstruction    { fonction: string; annee: number; montant: number; }
export interface PrimeIncitation330  { seuil: string; mois_max?: number; avions_max?: number; valeur_pvei: number; }
export interface TraitementBase      { base_cdb_a1: number; coef_opl: number; note?: string; }

export interface AnnexeData {
  cat_anciennete:        CatAnciennete[];
  coef_classe:           CoefClasse[];
  taux_avion:            TauxAvion[];
  prime_incitation:      PrimeIncitation[];
  prime_incitation_330?: PrimeIncitation330[];
  prime_instruction:     PrimeInstruction[];
  traitement_base:       TraitementBase;
}

export const KSP = 1.07;

// Coefficient catégorie pour PVEI (CCT AF)
// Catégorie A = 0.70, B = 0.85, C = 1.00
const CAT_PVEI: Record<string, number> = { A: 0.70, B: 0.85, C: 1.00 };

function toRole(fonction: string): 'CDB' | 'OPL' {
  return (fonction === 'CDB' || fonction === 'TRI_CDB') ? 'CDB' : 'OPL';
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

  let primeInstruction = 0;
  if (primeInstFonction && primeInstAnnee) {
    primeInstruction = a.prime_instruction.find(
      r => r.fonction === primeInstFonction && r.annee === primeInstAnnee
    )?.montant ?? 0;
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
