// ─── Paramètres profilés ─────────────────────────────────────────────────────

export interface FinanceProfile {
  pvei:  number;
  ksp:   number;
  fixe:  number;
  nb30e: number;
}

export function rotationValueP(hcrCrew: number, prime: number, tsvNuit = 0, p: FinanceProfile): number {
  const pv = hcrCrew + tsvNuit / 2;
  return pv * p.pvei * p.ksp + prime * 2.5 * p.pvei;
}

export function monthlyFinancialsP(totalHcr: number, totalPrime: number, totalTsvNuit = 0, p: FinanceProfile) {
  const totalPv = totalHcr + totalTsvNuit / 2;
  const pv      = totalPv * p.pvei * p.ksp;
  const primes  = totalPrime * 2.5 * p.pvei;
  const hsSeuil = 75 * (p.nb30e / 30);
  const hs      = Math.max(0, totalPv - hsSeuil) * p.pvei * p.ksp * 0.25;
  const mga     = p.fixe + 85 * (p.nb30e / 30) * p.pvei;
  const dif     = Math.max(0, mga - (p.fixe + pv));
  return { fixe: p.fixe, pv, hs, primes, dif, total: p.fixe + pv + hs + primes + dif };
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

// ─── Prime bi-tronçon : 2,5 × PVEI (sans KSP — source EP4) ──────────────────
export const PRIME_BITRONCON = 2.5 * PVEI;   // 281,75 € par prime

// ─── HS : seuil proratisé, taux = PVEI × KSP × 0,25 ─────────────────────────
export const HS_SEUIL = 75 * (NB_30E / 30);  // 57,5h pour TAF7 10/12
export const HS_RATE  = PVEI * KSP * 0.25;   // HS VOL

/**
 * Valeur d'une rotation en euros.
 * PV = hcr_crew + TSVnuit/2 (le TSVnuit sera ajouté quand disponible en DB).
 * Pour l'instant : PV ≈ hcr_crew (sous-estimé pour les vols de nuit).
 */
export function rotationValue(hcrCrew: number, prime: number, tsvNuit = 0): number {
  const pv = hcrCrew + tsvNuit / 2;
  return pv * PVEI * KSP + prime * PRIME_BITRONCON;
}

/** HS du mois en euros */
export function monthlyHs(totalPv: number): number {
  return Math.max(0, totalPv - HS_SEUIL) * HS_RATE;
}

/** MGA mensuel */
export function mga(): number {
  return FIXE_MENSUEL + 85 * (NB_30E / 30) * PVEI;  // ≈ 9170,94 €
}

/** DIF MGA = max(0, MGA − (FIXE + PV×PVEI×KSP)) */
export function difMga(totalPv: number): number {
  return Math.max(0, mga() - (FIXE_MENSUEL + totalPv * PVEI * KSP));
}

/** Résumé financier mensuel */
export function monthlyFinancials(totalHcr: number, totalPrime: number, totalTsvNuit = 0) {
  const totalPv = totalHcr + totalTsvNuit / 2;
  const pv      = totalPv * PVEI * KSP;
  const primes  = totalPrime * PRIME_BITRONCON;
  const hs      = monthlyHs(totalPv);
  const dif     = difMga(totalPv);
  return { fixe: FIXE_MENSUEL, pv, hs, primes, dif, total: FIXE_MENSUEL + pv + hs + primes + dif };
}
