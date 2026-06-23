/**
 * Match une rotation A81 ↔ rows EP4 PDF pour utiliser les block-off/block-on
 * REELS du décompte de paie comme source du séjour A81 (conservateur).
 *
 * Algo : pour une rotation donnée avec son `escale_debut` / `escale_fin` +
 * `debutOrigin` / `finOrigin` (raw_detail), on cherche dans `horaire.rows[]`
 * la row dont :
 *   - `escArr` == escale_debut ET `reelArr.day` == jour calendaire de debutOrigin
 *     → recompose le timestamp et soustrait 5 min (cf optiP_DEF.md § ARTICLE81)
 *   - `escDep` == escale_fin   ET `reelDep.day` == jour calendaire de finOrigin
 *     → recompose et ajoute 10 min
 *
 * Si les DEUX bornes matchent, on retourne le couple (source = 'ep4').
 * Sinon → null (fallback calendrier).
 *
 * Couvre les rotations à cheval M-1/M : l'appelant doit fournir l'EP4 du mois
 * de chaque borne (debut peut être en M-1, fin en M).
 */

import type { Ep4HoraireRow, Ep4PdfData, HoraireJJHHMM } from '@/lib/ep4-pdf-parse';

const DEBUT_OFFSET_MS = -5  * 60 * 1000;
const FIN_OFFSET_MS   = +10 * 60 * 1000;

/** Recompose un timestamp UTC ISO à partir d'un (monthIso, JJHHMM).
 *  `monthIso` = "YYYY-MM" du PDF (= meta.monthIso). */
function horaireToIso(monthIso: string, h: HoraireJJHHMM): string {
  const [y, m] = monthIso.split('-').map(Number);
  const minutes = Math.round(h.decimal * 60);
  // Math.min(59, …) garde-fou anti dérive d'arrondi sur 0.99 (= 59.4 → 59).
  const safeMin = Math.min(59, Math.max(0, minutes));
  // 24.00 = minuit du jour suivant (cf doc HoraireJJHHMM)
  const hour = h.hour === 24 ? 0 : h.hour;
  const dayShift = h.hour === 24 ? 1 : 0;
  return new Date(Date.UTC(y, m - 1, h.day + dayShift, hour, safeMin)).toISOString();
}

/** Filtre les rows EP4 utilisables pour le match A81 — uniquement les rows
 *  kind='normal' avec escDep/escArr ET reelDep/reelArr non-null. Les rows
 *  italique (spillover_info / spillover_prorata) sont écartées. */
function usableRows(ep4: Ep4PdfData): Ep4HoraireRow[] {
  return ep4.horaire.rows.filter(r =>
    r.kind === 'normal' &&
    !!r.escDep && !!r.escArr &&
    !!r.reelDep && !!r.reelArr,
  );
}

/** Cherche dans EP4 la row dont `escArr == escale` ET `reelArr.day == day`.
 *  Si plusieurs candidates (rare : 2 atterrissages à la même escale le même
 *  jour), retourne la première. */
function findArrivalRow(ep4: Ep4PdfData, escale: string, day: number): Ep4HoraireRow | null {
  for (const r of usableRows(ep4)) {
    if (r.escArr === escale && r.reelArr!.day === day) return r;
  }
  return null;
}

/** Cherche la row dont `escDep == escale` ET `reelDep.day == day`. */
function findDepartureRow(ep4: Ep4PdfData, escale: string, day: number): Ep4HoraireRow | null {
  for (const r of usableRows(ep4)) {
    if (r.escDep === escale && r.reelDep!.day === day) return r;
  }
  return null;
}

export interface Ep4MatchResult {
  debut_sejour_at: string;
  fin_sejour_at:   string;
}

/** Match les 2 bornes d'une rotation A81 contre les EP4 disponibles.
 *
 *  @param ep4ByMonth Map "YYYY-MM" → Ep4PdfData. Au moins les EP4 des mois de
 *  debut_origin et fin_origin doivent être présents pour matcher.
 *  @returns { debut_sejour_at, fin_sejour_at } si les 2 bornes matchent (= ep4
 *  comme source unique), sinon `null` (fallback calendrier).
 */
export function findEp4SejourMatch(
  escale_debut: string,
  escale_fin:   string,
  debut_origin_iso: string,
  fin_origin_iso:   string,
  ep4ByMonth: Map<string, Ep4PdfData>,
): Ep4MatchResult | null {
  if (!escale_debut || !escale_fin) return null;

  const debutDate = new Date(debut_origin_iso);
  const finDate   = new Date(fin_origin_iso);

  const debutMonth = `${debutDate.getUTCFullYear()}-${String(debutDate.getUTCMonth() + 1).padStart(2, '0')}`;
  const finMonth   = `${finDate.getUTCFullYear()}-${String(finDate.getUTCMonth() + 1).padStart(2, '0')}`;

  const ep4Debut = ep4ByMonth.get(debutMonth);
  const ep4Fin   = ep4ByMonth.get(finMonth);
  if (!ep4Debut || !ep4Fin) return null;

  const debutRow = findArrivalRow(ep4Debut, escale_debut, debutDate.getUTCDate());
  const finRow   = findDepartureRow(ep4Fin,   escale_fin,   finDate.getUTCDate());
  if (!debutRow || !finRow) return null;

  const debutIso = horaireToIso(ep4Debut.meta.monthIso ?? debutMonth, debutRow.reelArr!);
  const finIso   = horaireToIso(ep4Fin.meta.monthIso   ?? finMonth,   finRow.reelDep!);

  // Application des offsets canoniques (cf optiP_DEF.md § ARTICLE81)
  const debutMs = new Date(debutIso).getTime() + DEBUT_OFFSET_MS;
  const finMs   = new Date(finIso).getTime()   + FIN_OFFSET_MS;
  if (finMs <= debutMs) return null;

  return {
    debut_sejour_at: new Date(debutMs).toISOString(),
    fin_sejour_at:   new Date(finMs).toISOString(),
  };
}
