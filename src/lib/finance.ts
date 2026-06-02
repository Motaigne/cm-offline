// ─── Paramètres profilés ─────────────────────────────────────────────────────

export interface FinanceProfile {
  pvei:  number;
  ksp:   number;
  fixe:  number;
  nb30e: number;
}

/**
 * Résumé financier mensuel paramétré sur un profil. Formules conformes à
 * optiP_DEF.md / FORMULES.md :
 *   pv         = (totalHcr + totalTsvNuit/2) × PVEI × KSP
 *   primes     = totalPrime × 2.5 × PVEI            (bi-tronçon — sans KSP)
 *   hsSeuil    = 75 × (nb30e/30)
 *   hsH        = max(0, totalHc − hsSeuil)
 *   tauxMoyen  = pv / totalHc                       (fallback PVEI×KSP si totalHc=0)
 *   hsFixeRate = tFixe × 1.25 / 75                  (0 si nb30e=0)
 *   hsVolRate  = tauxMoyen × 0.25
 *   hs         = hsH × (hsFixeRate + hsVolRate)     ← composante FIXE + VOL
 *   mga        = 85 × PVEI × (nb30e/30)             (n'inclut PAS le fixe)
 *   dif        = max(0, mga − (pv + hs))            (top-up jusqu'au MGA)
 *   diff       = (pv + hs) − mga                    (affichage signé)
 *   total      = fixe + pv + hs + dif               (hors primes — ajoutées au brut séparément)
 *
 * Note : totalHcr ≠ totalHc. HCr est rémunéré (vol), HC est total crédité ;
 * c'est HC qui définit le seuil HS et qui sert au tauxMoyen.
 */
export function monthlyFinancialsP(
  totalHcr:     number,
  totalHc:      number,
  totalPrime:   number,
  totalTsvNuit: number,
  p: FinanceProfile,
) {
  const totalPv    = totalHcr + totalTsvNuit / 2;
  const pv         = totalPv * p.pvei * p.ksp;
  const primes     = totalPrime * 2.5 * p.pvei;
  const hsSeuil    = 75 * (p.nb30e / 30);
  const hsH        = Math.max(0, totalHc - hsSeuil);
  const tauxMoyen  = totalHc > 0 ? pv / totalHc : p.pvei * p.ksp;
  const hsFixeRate = p.nb30e > 0 ? p.fixe * 1.25 / 75 : 0;
  const hsVolRate  = tauxMoyen * 0.25;
  const hs         = hsH * (hsFixeRate + hsVolRate);
  const mga        = 85 * (p.nb30e / 30) * p.pvei;
  const dif        = Math.max(0, mga - (pv + hs));
  const diff       = (pv + hs) - mga;
  const total      = p.fixe + pv + hs + dif;
  return {
    fixe: p.fixe, pv, hs, primes, mga, dif, diff, total,
    // Intermédiaires utilisés par l'UI de détail HS / MGA :
    hsH, hsSeuil, hsFixeRate, hsVolRate, tauxMoyen,
  };
}

// ─── Constantes par défaut (profil OPL A335 Cl.2 Cat.C Éch.4 ATPL 10/12) ───

export const PVEI         = 112.7;    // €/h  = Taux avion × (Classe_OPL + ATPL) × Catégorie
export const KSP          = 1.07;     // Coefficient valorisation avion LC
export const FIXE_MENSUEL = 1826.66;  // Traitement fixe mensuel (proratisé selon 30e)
export const NB_30E       = 23;       // Nombre de 30e (ex: TAF7 10/12 → 23/30)

// ─── Nb de 30ème par régime ───────────────────────────────────────────────────
export const REGIME_NB30E: Record<string, number> = {
  TP:          30,
  TAF7_10_12:  23,
  TAF7_12_12:  23,
  TAF10_10_12: 20,
  TAF10_12_12: 20,
  // TTA92/83/75 : mois off entier — règles non encore implémentées
};

/**
 * Valeur d'une rotation en euros — utilise les constantes par défaut (profil
 * non chargé : search panel, catalogue avant hydratation profil).
 * PV = hcr_crew + TSVnuit/2. Bi-tronçon sans KSP.
 */
export function rotationValue(hcrCrew: number, prime: number, tsvNuit = 0): number {
  const pv = hcrCrew + tsvNuit / 2;
  return pv * PVEI * KSP + prime * 2.5 * PVEI;
}
