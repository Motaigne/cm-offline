// IR (Indemnité Repas) + MF (Menus Frais) — port spec instructions.md.
//
// Règles AF :
//   - Pilote bénéficie d'une IR par créneau (déj 11-15, dîner 18-22) où il est
//     "soit en vol soit en escale" pendant ≥ 1h, en heure locale.
//   - Chaque créneau (jour, type) ne peut ouvrir droit qu'à 1 indemnité (dédup).
//   - MF = 20% de l'IR (montant), versée seulement si l'escale d'origine est
//     ≥ 3h.
//   - "En vol" = fenêtre TSVP du leg = [dep - 1h15, arr + 15min].
//   - "En escale" = entre le end_ms du service i et le begin_ms du service i+1.
//
// On track aussi l'escale d'origine de chaque slot pour permettre le calcul €
// via lookupIrMfRate (chaque escale a son propre tarif AF).

import type { PairingDetail } from '@/lib/scraper/types';
import type { IrMfRate } from '@/lib/ir-rates';
import { lookupIrMfRate } from '@/lib/ir-rates';

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

interface SlotInfo {
  /** Code escale d'origine (= station où la couverture a lieu). */
  escale: string;
  isMfEligible: boolean;
}

/** Marque les créneaux IR/MF couverts par un intervalle local donné, en
 *  attribuant l'escale d'origine pour le lookup tarif.
 *  suppressDej/suppressDin : slots couverts par un repas à bord (Plan de Prestations). */
function addSlots(
  intervalLocalStartMs: number,
  intervalLocalEndMs: number,
  escale: string,
  isMfEligible: boolean,
  irSlotsMap: Map<string, SlotInfo>,
  suppressDej = false,
  suppressDin = false,
): void {
  if (intervalLocalEndMs <= intervalLocalStartMs) return;
  let dayStart = Math.floor(intervalLocalStartMs / DAY_MS) * DAY_MS;
  while (dayStart <= intervalLocalEndMs) {
    const dayKey = localDayKey(dayStart);
    for (const slot of SLOTS) {
      if (suppressDej && slot.name === 'midi') continue;
      if (suppressDin && slot.name === 'soir') continue;
      const slotStart = dayStart + slot.startH * HOUR_MS;
      const slotEnd   = dayStart + slot.endH   * HOUR_MS;
      const overlap = Math.max(0,
        Math.min(intervalLocalEndMs, slotEnd) - Math.max(intervalLocalStartMs, slotStart));
      if (overlap >= MIN_OVERLAP_MS) {
        const key = `${dayKey}|${slot.name}`;
        // Si déjà présent : garder la version la plus généreuse (escale-based + MF si éligible)
        const existing = irSlotsMap.get(key);
        if (!existing) {
          irSlotsMap.set(key, { escale, isMfEligible });
        } else if (isMfEligible && !existing.isMfEligible) {
          // Upgrade : escale longue prioritaire sur TSVP
          irSlotsMap.set(key, { escale, isMfEligible: true });
        }
      }
    }
    dayStart += DAY_MS;
  }
}

export interface IrMfResult {
  /** Compte total IR (= nombre de créneaux uniques couverts). */
  ir: number;
  /** Compte total MF (= subset où l'escale était ≥ 3h). */
  mf: number;
  /** Détail des slots couverts pour debug. */
  irSlots: string[];
  mfSlots: string[];
  /** Conversion en euros via les taux annexe (par escale). */
  ir_eur: number;
  mf_eur: number;
  /** Liste des escales pour lesquelles aucun taux n'a été trouvé. */
  missingRateEscales: string[];
}

export function computeIRandMF(
  detail: PairingDetail,
  rates: IrMfRate[] = [],
  getMealProvision?: (flightNumber: string, dep: string) => { dej: boolean; din: boolean } | null,
): IrMfResult {
  const slotsMap = new Map<string, SlotInfo>();

  // Aplatissement en services ordonnés (en gardant codes DEP/ARR pour escale)
  const services = [...(detail.flightDuty ?? [])]
    .map(d => ({
      begin_ms: d.schBeginDate,
      end_ms:   d.schEndDate,
      legs: (d.dutyLegAssociation ?? []).flatMap(dla => (dla.legs ?? []).map(l => ({
        flightNumber: l.flightNumber,
        dep: l.departureStationCode,
        arr: l.arrivalStationCode,
        dep_ms: l.scheduledDepartureDate,
        arr_ms: l.scheduledArrivalDate,
        dep_utc_offset_h: parseFloat(l.schDepStationCodeTz) || 0,
        arr_utc_offset_h: parseFloat(l.schArrStationCodeTz) || 0,
      }))).sort((a, b) => a.dep_ms - b.dep_ms),
    }))
    .sort((a, b) => a.begin_ms - b.begin_ms);

  // 1. Fenêtres TSVP par leg (en vol — pas MF-éligible).
  // Escale d'origine = destination du leg (= où le pilote arrive ou prépare son arrivée).
  // Si le Plan de Prestations prévoit un repas à bord, le slot correspondant est supprimé.
  for (const svc of services) {
    for (const leg of svc.legs) {
      const meal = getMealProvision ? getMealProvision(leg.flightNumber, leg.dep) : null;
      const localStart = (leg.dep_ms - TSVP_PRE_MS)  + leg.dep_utc_offset_h * HOUR_MS;
      const localEnd   = (leg.arr_ms + TSVP_POST_MS) + leg.dep_utc_offset_h * HOUR_MS;
      addSlots(localStart, localEnd, leg.arr, false, slotsMap, meal?.dej ?? false, meal?.din ?? false);
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
    // Heure locale + escale = dernier leg du service précédent (= station de séjour)
    const lastLegPrev = prev.legs[prev.legs.length - 1];
    const offsetH = lastLegPrev?.arr_utc_offset_h ?? 0;
    const escale  = lastLegPrev?.arr ?? '';
    const localStart = escaleStart + offsetH * HOUR_MS;
    const localEnd   = escaleEnd   + offsetH * HOUR_MS;
    const isMfEligible = duration >= MF_ESCALE_MIN_MS;
    addSlots(localStart, localEnd, escale, isMfEligible, slotsMap);
  }

  // 3. Compute totals + lookup € via rates
  let ir = 0, mf = 0, ir_eur = 0, mf_eur = 0;
  const missingSet = new Set<string>();
  const irSlotsList: string[] = [];
  const mfSlotsList: string[] = [];
  for (const [key, info] of slotsMap) {
    ir += 1;
    irSlotsList.push(`${key}@${info.escale}`);
    if (info.isMfEligible) {
      mf += 1;
      mfSlotsList.push(`${key}@${info.escale}`);
    }
    const rate = lookupIrMfRate(rates, info.escale);
    if (rate) {
      ir_eur += rate.ir_eur;
      if (info.isMfEligible) mf_eur += rate.mf_eur;
    } else if (info.escale) {
      missingSet.add(info.escale);
    }
  }

  return {
    ir, mf,
    irSlots: irSlotsList.sort(),
    mfSlots: mfSlotsList.sort(),
    ir_eur: Math.round(ir_eur * 100) / 100,
    mf_eur: Math.round(mf_eur * 100) / 100,
    missingRateEscales: [...missingSet].sort(),
  };
}
