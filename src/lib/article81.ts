// Article 81 — dispositif de défiscalisation par rotation.
// Spec dans sources/instructions.md (section ARTICLE81).
//
// Étapes :
//  1. tSej     = temps entre 1er atterrissage rotation et dernier décollage.
//                (= signature.temps_sej, déjà calculé par le scraper)
//  2. tSej24   = ceil((tSej + 0.25) / 24, 0.5) si (tSej + 0.25) ≥ 24, sinon 0.
//                (le +0.25 = 15 min réglementaires)
//  3. tauxSej  = lookup matrice (zone × seuil durée) en annexe.
//  4. montantPrimeSej     = valeurJour × tauxSej × tSej24
//  5. montantPrimeSejJour = valeurJour × tauxSej (montant pour 1 jour)
//
// Plafond annuel par régime : non implémenté pour l'instant (cf chunk
// suivant — nécessite cumul cross-mois sur l'année).

import type { Database } from '@/types/supabase';

type RegimeEnum = Database['public']['Enums']['regime_enum'];

export interface Article81Data {
  rates: { taux: Record<string, number | null>; duree: string }[];
  zones: string[];
  zones_labels: Record<string, string>;
  duree_min_h: number;
  plafond_jours: number;
  decompte_tranche_h: number;
  declenchement_jours_min: number;
}

export interface Article81Result {
  /** Temps de séjour brut en heures décimales. */
  tSej: number;
  /** Tranche de jours (0, 0.5, 1.0, 1.5, ...) après ajout +15min et arrondi sup à 0.5. */
  tSej24: number;
  /** Taux de séjour appliqué (ex: 1.20 pour 120%) ou null si lookup raté. */
  tauxSej: number | null;
  /** Montant prime séjour pour la rotation entière. */
  montantPrimeSej: number;
  /** Montant prime séjour pour 1 jour (= valeurJour × tauxSej). */
  montantPrimeSejJour: number;
  /** Zone utilisée pour le lookup. */
  zone: string | null;
}

const QUART_HEURE = 15 / 60; // 0.25h réglementaires

/** tSej24 : tranche par 0.5j, arrondi supérieur, après ajout de 15 min. */
export function computeTSej24(tSej: number): number {
  const adjusted = tSej + QUART_HEURE;
  if (adjusted < 24) return 0;
  // Arrondi supérieur à 0.5 près
  return Math.ceil((adjusted / 24) * 2) / 2;
}

/** Parse "24h", "24" ou "24.5h" → 24, 24, 24.5. */
function parseDuree(s: string): number {
  return parseFloat(s.replace(/[h ]/gi, '').replace(',', '.')) || 0;
}

/** Lookup tauxSej dans la matrice : trouve la plus petite ligne dont
 *  la durée seuil ≥ (tSej + 15/60). Renvoie null si tSej < seuil minimum. */
export function lookupTauxSej(
  data: Article81Data | null | undefined,
  zone: string | null,
  tSej: number,
): number | null {
  if (!data || !zone) return null;
  const adjusted = tSej + QUART_HEURE;
  if (adjusted < (data.duree_min_h ?? 24)) return null;

  // Tri par seuil croissant pour trouver le premier qui couvre adjusted
  const sorted = [...data.rates]
    .map(r => ({ ...r, seuil: parseDuree(r.duree) }))
    .filter(r => r.seuil > 0)
    .sort((a, b) => a.seuil - b.seuil);

  for (const r of sorted) {
    if (adjusted <= r.seuil) {
      const taux = r.taux[zone];
      return taux ?? null;
    }
  }
  // Dépasse le seuil max → utiliser la dernière ligne
  const last = sorted[sorted.length - 1];
  return last?.taux[zone] ?? null;
}

/** Plafond annuel de jours défiscalisés par régime. */
export function getPlafondJours(regime: RegimeEnum): number {
  switch (regime) {
    case 'TP':           return 70;
    case 'TAF7_12_12':   return 53.5;
    case 'TAF7_10_12':   return 56.5;
    case 'TAF10_12_12':  return 53.5; // approx, à confirmer si différent
    case 'TAF10_10_12':  return 56.5; // approx, à confirmer si différent
    default:             return 70;
  }
}

/** Calcule l'Article 81 pour une rotation donnée. */
export function computeArticle81(args: {
  tSej: number;
  zone: string | null;
  valeurJour: number;
  data: Article81Data | null | undefined;
}): Article81Result {
  const { tSej, zone, valeurJour, data } = args;
  const tSej24  = computeTSej24(tSej);
  const tauxSej = lookupTauxSej(data, zone, tSej);
  const montantPrimeSej     = (tauxSej != null && tSej24 > 0) ? valeurJour * tauxSej * tSej24 : 0;
  const montantPrimeSejJour = (tauxSej != null) ? valeurJour * tauxSej : 0;
  return { tSej, tSej24, tauxSej, montantPrimeSej, montantPrimeSejJour, zone };
}
