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
import type { PairingDetail } from '@/lib/scraper/types';

type RegimeEnum = Database['public']['Enums']['regime_enum'];

const FIVE_MIN_MS = 5  * 60 * 1000;
const TEN_MIN_MS  = 10 * 60 * 1000;

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

/** Lookup tauxSej dans la matrice. La grille est une fonction étagée : la
 *  tranche `duree=X` s'applique pour `adjusted ∈ [X, next_X)`. On retourne
 *  donc la plus GRANDE tranche dont `seuil ≤ adjusted` (= la marche à laquelle
 *  on appartient), pas la plus petite ≥ adjusted (l'ancienne logique tombait
 *  systématiquement sur la tranche d'au-dessus — ex : 63h Afrique sortait
 *  160% (72h tier) au lieu de 140% (48h tier)).
 *  Renvoie null si tSej < seuil minimum (= durée non éligible à A81). */
export function lookupTauxSej(
  data: Article81Data | null | undefined,
  zone: string | null,
  tSej: number,
): number | null {
  if (!data || !zone) return null;
  const adjusted = tSej + QUART_HEURE;
  if (adjusted < (data.duree_min_h ?? 24)) return null;

  const sorted = [...data.rates]
    .map(r => ({ ...r, seuil: parseDuree(r.duree) }))
    .filter(r => r.seuil > 0)
    .sort((a, b) => a.seuil - b.seuil);

  // Plus grande tranche dont seuil ≤ adjusted. Si adjusted dépasse tous les
  // seuils, on retombe naturellement sur le dernier (chosen reste défini).
  let chosen: typeof sorted[number] | null = null;
  for (const r of sorted) {
    if (r.seuil <= adjusted) chosen = r;
    else break;
  }
  return chosen?.taux[zone] ?? null;
}

/**
 * Valeur jour de référence pour la prime de séjour A81. Formule officielle :
 *   - Non-instructeur (100%) : (fixe + 76 × PVEI × KSP) × 13/12 / 18
 *   - Instructeur            : (fixe + primeInstruction + 96 × PVEI × KSP) × 13/12 / 18
 *
 * Évolue avec :
 *   - Profil individuel versionné (fonction, classe, échelon, régime, …)
 *   - Profil catégoriel versionné (taux avion, traitement base, prime instruction)
 */
export function computeValeurJour(args: {
  fixe: number;            // traitement mensuel proratisé régime
  pvei: number;
  ksp: number;
  primeInstruction: number; // 0 si non-instructeur
  isTri: boolean;
}): number {
  const { fixe, pvei, ksp, primeInstruction, isTri } = args;
  const baseAmount = isTri
    ? fixe + primeInstruction + 96 * pvei * ksp
    : fixe + 76 * pvei * ksp;
  return baseAmount * 13 / 12 / 18;
}

/** Offsets stables d'une signature : durées (ms) du début de rotation
 *  (flightDuty[0].schBeginDate) au début de séjour (firstDuty.schEnd − 5min)
 *  et à la fin de séjour (lastDuty.schBegin + 10min). Les offsets sont
 *  invariants pour toutes les instances de la signature ; on les applique
 *  à instance.depart_at pour obtenir les vrais timestamps de séjour. */
export interface SejourOffsets {
  debutSejourOffsetMs: number;
  finSejourOffsetMs:   number;
}

/** Calcule les offsets séjour depuis un PairingDetail. Renvoie null si
 *  flightDuty absent ou < 2 entrées (= pas de séjour applicable). */
export function computeSejourOffsetsFromDetail(detail: PairingDetail | null | undefined): SejourOffsets | null {
  if (!detail?.flightDuty || detail.flightDuty.length < 2) return null;
  const firstDuty = detail.flightDuty[0];
  const lastDuty  = detail.flightDuty[detail.flightDuty.length - 1];
  const rotationStartMs = firstDuty.schBeginDate;
  const debutSejourMs   = firstDuty.schEndDate  - FIVE_MIN_MS;
  const finSejourMs     = lastDuty.schBeginDate + TEN_MIN_MS;
  return {
    debutSejourOffsetMs: debutSejourMs - rotationStartMs,
    finSejourOffsetMs:   finSejourMs   - rotationStartMs,
  };
}

/** Si debutMs et finMs sont dans 2 mois UTC différents, renvoie le ms UTC
 *  du 1er du mois de finMs à 00:00 (= boundary M→M+1). Sinon null.
 *  Cas multi-boundary (>2 mois) non géré — irréaliste pour un séjour A81. */
export function findMonthBoundary(debutMs: number, finMs: number): number | null {
  const d = new Date(debutMs);
  const dY = d.getUTCFullYear();
  const dM = d.getUTCMonth();
  const f = new Date(finMs);
  if (f.getUTCFullYear() === dY && f.getUTCMonth() === dM) return null;
  return Date.UTC(dY, dM + 1, 1, 0, 0, 0, 0);
}

/** Représente une rotation à cheval splittée en 2 parts mensuelles. */
export interface A81RotationSplit {
  m0: { debutMs: number; finMs: number; tempsSejH: number; nbJours: number };
  m1: { debutMs: number; finMs: number; tempsSejH: number; nbJours: number };
}

/** Split une rotation à cheval entre 2 mois UTC.
 *  Règle nb_jours : m0 = computeTSej24(h_m0), m1 = totalNbJours − m0.
 *  Garantit que m0.nbJours + m1.nbJours = totalNbJours (constraint user). */
export function splitRotationAtMonth(
  debutMs: number,
  finMs: number,
  totalNbJours: number,
): A81RotationSplit | null {
  const boundary = findMonthBoundary(debutMs, finMs);
  if (boundary === null) return null;
  const m0Hours = (boundary - debutMs) / 3600000;
  const m1Hours = (finMs - boundary) / 3600000;
  const m0NbJours = computeTSej24(m0Hours);
  const m1NbJours = Math.max(0, totalNbJours - m0NbJours);
  return {
    m0: { debutMs, finMs: boundary, tempsSejH: m0Hours, nbJours: m0NbJours },
    m1: { debutMs: boundary, finMs, tempsSejH: m1Hours, nbJours: m1NbJours },
  };
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
