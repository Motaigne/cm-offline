// Primes spécifiques 1er mai et Noël — calcul client-side offline-friendly.
//
// Prime Noël (Convention) :
//   pNoel = 0,4 × taNoel × PVEI
//   taNoel = temps d'absence (heures) dans la période
//            [24/12 18h00 → 25/12 23h59, heure de Paris].
//   Seuls les VOLS (kind='flight', toutes bid_categories) comptent :
//   temps d'absence = chevauchement entre [depart_at, arrivee_at] (block-off
//   → block-on de l'instance) et la fenêtre Noël.
//
//   Les vols sans pairing_instance_id (dda_vol / vol_p placeholders) sont
//   ignorés faute de timing horaire — en pratique ils sont remplacés par
//   un vrai vol avant l'échéance.

import type { CalendarItem } from '@/app/page';
import type { RotationInstance } from '@/app/actions/search';

const MS_PER_H = 3_600_000;

/** Borne UTC d'une heure locale Paris pour un jour donné (année, mois 1-12,
 *  jour 1-31, heure 0-24). Décembre = hiver → Paris = UTC+1, donc on
 *  retranche 1h pour obtenir l'UTC.
 *  (Pas de DST en décembre — on ne gère pas le cas général du changement
 *  d'heure, ce qui est OK pour les périodes Mai/Noël fixées.) */
function parisToUtcMs(year: number, month1to12: number, day: number, hour: number): number {
  return Date.UTC(year, month1to12 - 1, day, hour - 1, 0, 0);
}

/** Bornes UTC de la fenêtre Noël = [24/12 18h Paris → 26/12 00h Paris]
 *  (on prend 00h le 26 pour englober 23h59 inclus = équivaut à 24h00 le 25). */
export function getNoelWindowUtc(year: number): { startMs: number; endMs: number } {
  return {
    startMs: parisToUtcMs(year, 12, 24, 18),
    endMs:   parisToUtcMs(year, 12, 26,  0),
  };
}

/** Calcule taNoel (heures) à partir des items du planning et du lookup
 *  d'instances horaires (indexé par pairing_instance_id). */
export function computeTaNoelHours(
  items: CalendarItem[],
  instancesById: Map<string, RotationInstance>,
  year: number,
): number {
  const { startMs, endMs } = getNoelWindowUtc(year);
  let totalMs = 0;

  for (const it of items) {
    if (it.kind !== 'flight') continue;
    if (!it.pairing_instance_id) continue; // dda_vol/vol_p sans instance → skip
    const inst = instancesById.get(it.pairing_instance_id);
    if (!inst) continue;

    const volStart = new Date(inst.depart_at).getTime();
    const volEnd   = new Date(inst.arrivee_at).getTime();
    if (!Number.isFinite(volStart) || !Number.isFinite(volEnd)) continue;

    const overlap = Math.max(0, Math.min(volEnd, endMs) - Math.max(volStart, startMs));
    totalMs += overlap;
  }

  return totalMs / MS_PER_H;
}

/** Montant prime Noël en euros pour le mois donné. Retourne 0 si mo !== 12. */
export function computePrimeNoel(
  items: CalendarItem[],
  instancesById: Map<string, RotationInstance>,
  year: number,
  mo: number,
  pvei: number,
): number {
  if (mo !== 12) return 0;
  const taNoel = computeTaNoelHours(items, instancesById, year);
  return 0.4 * taNoel * pvei;
}
