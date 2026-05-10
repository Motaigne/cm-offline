// IR (Indemnité Repas) + MF (Menus Frais) — port spec instructions.md.
//
// Règles AF :
//   - Pilote bénéficie d'une IR par créneau (déj 11-15, dîner 18-22) où il est
//     "soit en vol soit en escale" pendant ≥ 1h, en heure locale.
//   - Chaque créneau (jour, type) ne peut ouvrir droit qu'à 1 indemnité (dédup).
//   - MF = 20% de l'IR (montant), versée seulement si l'escale d'origine est
//     ≥ 3h. On expose ici les COMPTES IR et MF — la conversion € est faite
//     en aval (avec le tableau "TABLEAU RECAPITULATIF…IR…2026" en annexe).
//   - "En vol" = fenêtre TSVP du leg = [dep - 1h15, arr + 15min].
//   - "En escale" = entre le end_ms du service i et le begin_ms du service i+1.

import type { PairingDetail } from '@/lib/scraper/types';

const HOUR_MS = 3_600_000;
const DAY_MS  = 86_400_000;
const MIN_OVERLAP_MS    = 1 * HOUR_MS;        // 1h minimum dans le créneau
const TSVP_PRE_MS       = 75 * 60 * 1000;     // 1h15
const TSVP_POST_MS      = 15 * 60 * 1000;     // 15 min
const MF_ESCALE_MIN_MS  = 3 * HOUR_MS;        // 3h escale mini pour MF

const SLOTS = [
  { name: 'midi' as const, startH: 11, endH: 15 },
  { name: 'soir' as const, startH: 18, endH: 22 },
];

function localDayKey(localMs: number): string {
  const d = Math.floor(localMs / DAY_MS) * DAY_MS;
  // Format YYYY-MM-DD du jour local (en utilisant un Date UTC sur le timestamp local-shifted)
  const dt = new Date(d);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
}

/** Marque les créneaux IR/MF couverts par un intervalle local donné. */
function addSlots(
  intervalLocalStartMs: number,
  intervalLocalEndMs: number,
  isMfEligible: boolean,
  irSlots: Set<string>,
  mfSlots: Set<string>,
): void {
  if (intervalLocalEndMs <= intervalLocalStartMs) return;
  let dayStart = Math.floor(intervalLocalStartMs / DAY_MS) * DAY_MS;
  while (dayStart <= intervalLocalEndMs) {
    const dayKey = localDayKey(dayStart);
    for (const slot of SLOTS) {
      const slotStart = dayStart + slot.startH * HOUR_MS;
      const slotEnd   = dayStart + slot.endH   * HOUR_MS;
      const overlap = Math.max(0,
        Math.min(intervalLocalEndMs, slotEnd) - Math.max(intervalLocalStartMs, slotStart));
      if (overlap >= MIN_OVERLAP_MS) {
        const key = `${dayKey}|${slot.name}`;
        irSlots.add(key);
        if (isMfEligible) mfSlots.add(key);
      }
    }
    dayStart += DAY_MS;
  }
}

export interface IrMfResult {
  ir: number;
  mf: number;
  /** Détail des slots couverts pour debug. */
  irSlots: string[];
  mfSlots: string[];
}

export function computeIRandMF(detail: PairingDetail): IrMfResult {
  const irSlots = new Set<string>();
  const mfSlots = new Set<string>();

  // Aplatissement en services ordonnés
  const services = [...(detail.flightDuty ?? [])]
    .map(d => ({
      begin_ms: d.schBeginDate,
      end_ms:   d.schEndDate,
      legs: (d.dutyLegAssociation ?? []).flatMap(dla => (dla.legs ?? []).map(l => ({
        dep_ms: l.scheduledDepartureDate,
        arr_ms: l.scheduledArrivalDate,
        dep_utc_offset_h: parseFloat(l.schDepStationCodeTz) || 0,
        arr_utc_offset_h: parseFloat(l.schArrStationCodeTz) || 0,
      }))).sort((a, b) => a.dep_ms - b.dep_ms),
    }))
    .sort((a, b) => a.begin_ms - b.begin_ms);

  // 1. Fenêtres TSVP par leg (en vol — pas MF-éligible)
  for (const svc of services) {
    for (const leg of svc.legs) {
      const localStart = (leg.dep_ms - TSVP_PRE_MS)  + leg.dep_utc_offset_h * HOUR_MS;
      const localEnd   = (leg.arr_ms + TSVP_POST_MS) + leg.dep_utc_offset_h * HOUR_MS;
      addSlots(localStart, localEnd, false, irSlots, mfSlots);
    }
  }

  // 2. Escales entre services (MF-éligible si ≥ 3h)
  for (let i = 0; i < services.length - 1; i++) {
    const prev = services[i];
    const next = services[i + 1];
    const escaleStart = prev.end_ms;
    const escaleEnd   = next.begin_ms;
    const duration = escaleEnd - escaleStart;
    if (duration <= 0) continue;
    // Heure locale = ARR offset du dernier leg du service précédent (= station de séjour)
    const lastLegPrev = prev.legs[prev.legs.length - 1];
    const offsetH = lastLegPrev?.arr_utc_offset_h ?? 0;
    const localStart = escaleStart + offsetH * HOUR_MS;
    const localEnd   = escaleEnd   + offsetH * HOUR_MS;
    const isMfEligible = duration >= MF_ESCALE_MIN_MS;
    addSlots(localStart, localEnd, isMfEligible, irSlots, mfSlots);
  }

  return {
    ir: irSlots.size,
    mf: mfSlots.size,
    irSlots: [...irSlots].sort(),
    mfSlots: [...mfSlots].sort(),
  };
}
