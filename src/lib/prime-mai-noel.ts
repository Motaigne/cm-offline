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
// Prime 1er mai (Convention) — MVP traitant uniquement le cas VOL :
//   pMai = 1/30 × fixe + pvMaiEur
//   pvMaiEur = pvMai_HCr × PVEI × KSP
//   pvMai_HCr = somme sur les rotations chevauchant le 1er mai de :
//     (hcr_crew + tsv_nuit/2) × (chevauchement_h / durée_rotation_h)
//   Approximation : pas de ventilation par leg comme le Python de référence
//   (faute de raw_detail offline). Acceptable pour MVP « heures programmées ».
//
//   Les variantes pMaiSol (activité sol) et pMaiIns (instruction) ne sont
//   pas implémentées dans ce MVP — à ajouter si besoin (formules dans
//   sources/optiP_DEF.md section « PRIME 1ER MAI »).
//
//   Les vols sans pairing_instance_id (dda_vol / vol_p placeholders) sont
//   ignorés faute de timing horaire.

import type { CalendarItem } from '@/app/page';
import type { RotationInstance, RotationSignature } from '@/app/actions/search';

const MS_PER_H = 3_600_000;

/** Borne UTC d'une heure locale Paris pour un jour donné. `parisOffsetH` =
 *  décalage Paris vs UTC à cette date (1 en hiver, 2 en été). On ne gère
 *  pas le DST général — l'appelant choisit selon le mois (mai = 2, déc = 1). */
function parisToUtcMs(
  year: number, month1to12: number, day: number, hour: number,
  parisOffsetH: number,
): number {
  return Date.UTC(year, month1to12 - 1, day, hour - parisOffsetH, 0, 0);
}

/** Bornes UTC de la fenêtre Noël = [24/12 18h Paris → 26/12 00h Paris]
 *  (on prend 00h le 26 pour englober 23h59 inclus = équivaut à 24h00 le 25). */
export function getNoelWindowUtc(year: number): { startMs: number; endMs: number } {
  return {
    startMs: parisToUtcMs(year, 12, 24, 18, 1),
    endMs:   parisToUtcMs(year, 12, 26,  0, 1),
  };
}

/** Bornes UTC de la fenêtre 1er mai = [01/05 00h Paris → 02/05 00h Paris]. */
export function getMaiWindowUtc(year: number): { startMs: number; endMs: number } {
  return {
    startMs: parisToUtcMs(year, 5, 1, 0, 2),
    endMs:   parisToUtcMs(year, 5, 2, 0, 2),
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

// ─── Prime 1er mai ────────────────────────────────────────────────────────────

/** Calcule pvMai_HCr (en heures créditées) : somme sur les vols chevauchant
 *  le 1er mai de (hcr_crew + tsv_nuit/2) × (overlap / durée_rotation). */
export function computePvMaiHcrHours(
  items: CalendarItem[],
  signaturesByInstanceId: Map<string, RotationSignature>,
  year: number,
): number {
  const { startMs, endMs } = getMaiWindowUtc(year);
  let total = 0;

  for (const it of items) {
    if (it.kind !== 'flight') continue;
    if (!it.pairing_instance_id) continue;
    const sig = signaturesByInstanceId.get(it.pairing_instance_id);
    if (!sig) continue;
    const inst = sig.instances.find(i => i.id === it.pairing_instance_id);
    if (!inst) continue;

    const volStart = new Date(inst.depart_at).getTime();
    const volEnd   = new Date(inst.arrivee_at).getTime();
    if (!Number.isFinite(volStart) || !Number.isFinite(volEnd)) continue;
    if (volEnd <= volStart) continue;

    const overlap = Math.max(0, Math.min(volEnd, endMs) - Math.max(volStart, startMs));
    if (overlap === 0) continue;

    const ratio = overlap / (volEnd - volStart);
    const hcrFull = (sig.hcr_crew ?? 0) + (sig.tsv_nuit ?? 0) / 2;
    total += hcrFull * ratio;
  }

  return total;
}

/** Montant prime 1er mai en euros pour le mois donné — uniquement le cas
 *  VOL. Retourne 0 si mo !== 5. */
export function computePrimeMai(
  items: CalendarItem[],
  signaturesByInstanceId: Map<string, RotationSignature>,
  year: number,
  mo: number,
  fixe: number,
  pvei: number,
  ksp: number,
): number {
  if (mo !== 5) return 0;
  const pvMaiHcr = computePvMaiHcrHours(items, signaturesByInstanceId, year);
  if (pvMaiHcr === 0) return 0; // pilote n'a pas volé le 1er mai → pas de prime
  const pvMaiEur = pvMaiHcr * pvei * ksp;
  return fixe / 30 + pvMaiEur;
}
