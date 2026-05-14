// Port TS du pipeline Python EP4 :
//   8_ep4_V7.py     — calculs HCV/HCT/H1/HCVmoisM/ONm/Prime/IR/H2HC final
//   8b_ep4_81.py    — tempsSej + tauxApp lookup
//   6_codeRot_v7.py — TDV/troncon, BLOCK/BLOCK, TSV nuit J/J+1, TSVnSerM
//
// Source de données : pairing_signature.raw_detail JSONB (= PairingDetail).
// Mapping validé le 2026-05-07, voir project_lot5_ep4_plan.md mémoire.

import type { PairingDetail } from '@/lib/scraper/types';
import type { IrMfRate } from '@/lib/ir-rates';
import type { Ep4Leg, Ep4Service, Ep4Rotation, TauxAppRow } from './types';
import { tsvNuitJ, tsvNuitJ1 } from './night';
import { computeIRandMF } from './ir';
import { getPlanPrestation } from '@/lib/plan-prestation';

const HOUR_MS = 3_600_000;
const EXCLUDE_PRIME_AIRPORTS = new Set(['TLV', 'BEY']);

const r2 = (n: number) => Math.round(n * 100) / 100;
const utcHour = (ms: number) => {
  const d = new Date(ms);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
};
const adjustHour = (h: number) => ((h % 24) + 24) % 24;

// ─── Extract raw → structures intermédiaires ─────────────────────────────────

interface RawLeg {
  flightNumber: string;
  aircraft: string;
  dep: string;
  arr: string;
  dep_ms: number;
  arr_ms: number;
  dep_utc_offset: number;
  arr_utc_offset: number;
  dead_head: boolean;
}

interface RawService {
  service_index: number;
  legs: RawLeg[];
  begin_ms: number;
  end_ms: number;
  tsv: number;
}

function extractServices(detail: PairingDetail): RawService[] {
  const out: RawService[] = [];
  for (const duty of detail.flightDuty ?? []) {
    const legs: RawLeg[] = [];
    for (const dla of duty.dutyLegAssociation ?? []) {
      const dh = dla.deadHead === 1;
      for (const leg of dla.legs ?? []) {
        legs.push({
          flightNumber: leg.flightNumber,
          aircraft: leg.aircraftSubtypeCode,
          dep: leg.departureStationCode,
          arr: leg.arrivalStationCode,
          dep_ms: leg.scheduledDepartureDate,
          arr_ms: leg.scheduledArrivalDate,
          dep_utc_offset: parseFloat(leg.schDepStationCodeTz) || 0,
          arr_utc_offset: parseFloat(leg.schArrStationCodeTz) || 0,
          dead_head: dh,
        });
      }
    }
    legs.sort((a, b) => a.dep_ms - b.dep_ms);
    out.push({
      service_index: duty.sequenceNumber,
      legs,
      begin_ms: duty.schBeginDate,
      end_ms: duty.schEndDate,
      tsv: duty.flightDutyValue?.[0]?.schFlDutyTime ?? 0,
    });
  }
  out.sort((a, b) => a.begin_ms - b.begin_ms);
  return out;
}

// ─── HCVmoisM (Python 8_ep4_V7.py:91-109) ────────────────────────────────────

function prorateHcvMoisM(
  dep_ms: number, arr_ms: number, hcv: number,
  monthStart: number, monthEnd: number,
): number {
  if (dep_ms > monthStart && arr_ms < monthEnd) return hcv;
  if (dep_ms < monthStart && arr_ms < monthStart) return 0;
  if (dep_ms < monthStart && arr_ms > monthStart) {
    return r2((arr_ms - monthStart) / (arr_ms - dep_ms) * hcv);
  }
  if (arr_ms > monthEnd && dep_ms > monthEnd) return 0;
  if (arr_ms > monthEnd && dep_ms < monthEnd) {
    return r2((monthEnd - dep_ms) / (arr_ms - dep_ms) * hcv);
  }
  return 0;
}

// ─── ONm (Python 8_ep4_V7.py:113-152) ────────────────────────────────────────

function computeOnM(
  debutVolMs: number, finVolMs: number, ON: number,
  year: number, month: number,
): number {
  const moisDebut    = Date.UTC(year, month - 1, 1);
  const moisFin      = month === 12
    ? Date.UTC(year + 1, 0, 1)
    : Date.UTC(year, month, 1);
  const nbJoursMois  = new Date(year, month, 0).getDate();

  if (debutVolMs >= moisDebut && finVolMs < moisFin) return ON;
  if (finVolMs   <  moisDebut)                       return 0;
  if (debutVolMs <  moisDebut && finVolMs >= moisDebut && finVolMs < moisFin) {
    return new Date(finVolMs).getUTCDate();
  }
  if (debutVolMs >= moisFin)                         return 0;
  if (debutVolMs >= moisDebut && finVolMs >= moisFin) {
    return nbJoursMois - new Date(debutVolMs).getUTCDate() + 1;
  }
  if (debutVolMs <  moisDebut && finVolMs >= moisFin) return nbJoursMois;
  return 0;
}

// ─── IR + MF : voir lib/ep4/ir.ts (port spec instructions.md, plus précis
// que le Python 8_ep4_V7.py:197-242 qui ne gérait que l'escale principale).

// ─── Prime bi-tronçon (Python 8_ep4_V7.py:166-191) ───────────────────────────

function computePrime(services: RawService[]): number {
  let total = 0;
  for (const svc of services) {
    if (svc.legs.length < 2) continue;
    const hasExcluded = svc.legs.some(l =>
      EXCLUDE_PRIME_AIRPORTS.has(l.dep) || EXCLUDE_PRIME_AIRPORTS.has(l.arr),
    );
    if (!hasExcluded) total += 1;
  }
  return total;
}

// ─── TSVnSerM (Python 6_codeRot_v7.py:265-278) ───────────────────────────────

function computeTsvNSerM(
  dep_service_ms: number, arr_service_ms: number,
  tsv_j: number, tsv_j1: number,
  hasDeadHead: boolean,
  month: number,
): number {
  if (hasDeadHead) return 0;
  const moisDep = new Date(dep_service_ms).getUTCMonth() + 1;
  const moisArr = new Date(arr_service_ms).getUTCMonth() + 1;
  if (moisDep === month && moisArr === month) return r2(tsv_j + tsv_j1);
  if (moisDep === month && moisArr !== month) return tsv_j;
  if (moisDep !== month && moisArr === month) return tsv_j1;
  return 0;
}

// ─── Lookup tauxApp ──────────────────────────────────────────────────────────

export function lookupTauxApp(
  taux: TauxAppRow[], rotationCode: string | null, tempsSej: number,
): number | null {
  if (!rotationCode) return null;
  // Le rotation_code peut contenir un préfixe "9ON " — table indexée sans.
  const stripped = rotationCode.split(' ').slice(1).join(' ').trim() || rotationCode;
  const match = taux.find(t =>
    (t.rot_code === stripped || t.rot_code === rotationCode) &&
    tempsSej >= t.duree_min_h && tempsSej <= t.duree_max_h,
  );
  return match?.taux ?? null;
}

// ─── Builder principal ───────────────────────────────────────────────────────

export function buildEp4Rotation(
  detail: PairingDetail,
  rotationCode: string,
  zone: string | null,
  year: number,
  month: number,
  taux: TauxAppRow[],
  irRates: IrMfRate[] = [],
): Ep4Rotation {
  const rawServices = extractServices(detail);
  const pv0 = detail.pairingValue?.[0];

  const HDV       = pv0?.flightTime ?? 0;
  const HC        = pv0?.creditedHour ?? 0;
  const ON        = pv0?.nbOnDays ?? 0;
  const TDV_total = pv0?.workedFlightTime ?? 0;

  const debut_vol_ms = rawServices[0]?.begin_ms ?? 0;
  const fin_vol_ms   = rawServices[rawServices.length - 1]?.end_ms ?? 0;
  const TA  = (fin_vol_ms - debut_vol_ms) / HOUR_MS;
  const HCA = r2(TA * 5 / 24);

  // utc_offset pour IR : ARR offset du dernier leg du premier service (Python: first_service['UTC ARR'])
  const firstSvc = rawServices[0];
  const lastLegFirstSvc = firstSvc?.legs[firstSvc.legs.length - 1];
  const utc_arr_first_service = lastLegFirstSvc?.arr_utc_offset ?? 0;

  // Bornes mois pour HCVmoisM
  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd   = month === 12
    ? Date.UTC(year + 1, 0, 1)
    : Date.UTC(year, month, 1);

  const services: Ep4Service[] = rawServices.map(svc => {
    const legs: Ep4Leg[] = svc.legs.map((leg, i) => {
      const tdv_troncon = r2((leg.arr_ms - leg.dep_ms) / HOUR_MS);
      const dep_utc_h = utcHour(leg.dep_ms);
      const arr_utc_h = utcHour(leg.arr_ms);
      const dep_loc_h = adjustHour(dep_utc_h + leg.dep_utc_offset);
      return {
        flightNumber: leg.flightNumber,
        aircraft: leg.aircraft,
        dep: leg.dep,
        arr: leg.arr,
        dep_utc_h: r2(dep_utc_h),
        arr_utc_h: r2(arr_utc_h),
        dep_loc_h: r2(dep_loc_h),
        begin_ms: leg.dep_ms,
        end_ms: leg.arr_ms,
        tdv_troncon,
        troncon_index: i + 1,
        hv100r: r2(tdv_troncon + 0.58),
        hcv_mois_m: 0, // rempli juste après HCV
        dead_head: leg.dead_head,
      };
    });

    const tot_tdv = legs.reduce((s, l) => s + l.tdv_troncon, 0);
    const nb       = legs.length || 1;
    const TME      = r2(Math.max(1, tot_tdv / nb));
    const CMT      = TME <= 2 ? r2(70 / (21 * TME + 30)) : 1;
    const has_dead_head = legs.some(l => l.dead_head);
    const HCV      = r2(tot_tdv * CMT * (has_dead_head ? 0.5 : 1));
    const HCT      = r2(svc.tsv / 1.75);
    const H1       = r2(Math.max(HCV, HCT));

    const sumHv100r = legs.reduce((s, l) => s + l.hv100r, 0);
    const HCVr     = r2(sumHv100r * CMT * (has_dead_head ? 0.5 : 1));
    const H1r      = r2(Math.max(HCVr, HCT));

    for (const leg of legs) {
      leg.hcv_mois_m = prorateHcvMoisM(leg.begin_ms, leg.end_ms, HCV, monthStart, monthEnd);
    }

    const block_block = svc.legs.length
      ? r2((svc.legs[svc.legs.length - 1].arr_ms - svc.legs[0].dep_ms) / HOUR_MS)
      : 0;
    const dep_loc_h_svc = legs[0]?.dep_loc_h ?? 0;
    const tsv_nuit_j  = tsvNuitJ(dep_loc_h_svc,  block_block);
    const tsv_nuit_j1 = tsvNuitJ1(dep_loc_h_svc, block_block);
    const tsv_nuit    = r2(tsv_nuit_j + tsv_nuit_j1);
    const tsv_n_ser_m = svc.legs.length
      ? computeTsvNSerM(
          svc.legs[0].dep_ms, svc.legs[svc.legs.length - 1].arr_ms,
          tsv_nuit_j, tsv_nuit_j1, has_dead_head, month,
        )
      : 0;

    return {
      service_index: svc.service_index,
      legs,
      block_block,
      tsv: svc.tsv,
      has_dead_head,
      TME, CMT, HCV, HCT, H1, HCVr, H1r,
      tsv_nuit_j, tsv_nuit_j1, tsv_nuit, tsv_n_ser_m,
    };
  });

  const tsv_n_rot_m = r2(services.reduce((s, svc) => s + svc.tsv_n_ser_m, 0));

  // rtHDV = sum(HCVmoisM legs) / sum(HCV services)
  const sumHcvMoisM = services.reduce(
    (s, svc) => s + svc.legs.reduce((ss, l) => ss + l.hcv_mois_m, 0), 0);
  const sumHcv      = services.reduce((s, svc) => s + svc.HCV, 0);
  const rtHDV       = sumHcv > 0 ? r2(sumHcvMoisM / sumHcv) : 0;

  const sumH1  = services.reduce((s, svc) => s + svc.H1,  0);
  const sumH1r = services.reduce((s, svc) => s + svc.H1r, 0);

  const H2HC_initial  = r2(Math.max(HCA, sumH1));
  const H2HCr_initial = r2(Math.max(HCA, sumH1r));
  const H2HC          = r2(rtHDV * Math.max(HCA, sumH1));
  const H2HCr         = r2(rtHDV * Math.max(HCA, sumH1r));

  const ONm = computeOnM(debut_vol_ms, fin_vol_ms, ON, year, month);

  const irMf = computeIRandMF(detail, irRates, getPlanPrestation);
  const IR = irMf.ir;
  const MF = irMf.mf;
  const IR_eur = irMf.ir_eur;
  const MF_eur = irMf.mf_eur;
  const IR_missingRateEscales = irMf.missingRateEscales;

  const Prime = computePrime(rawServices);

  // tempsSej : DEPmm 1er leg du dernier service - ARRmm dernier leg du 1er service
  const arr_first_svc_last_leg = firstSvc?.legs[firstSvc.legs.length - 1]?.arr_ms ?? 0;
  const dep_last_svc_first_leg = rawServices[rawServices.length - 1]?.legs[0]?.dep_ms ?? 0;
  const tempsSej = r2((dep_last_svc_first_leg - arr_first_svc_last_leg) / HOUR_MS);

  const tauxApp = lookupTauxApp(taux, rotationCode, tempsSej);

  return {
    rotation_code: rotationCode,
    zone,
    HDV, HC, ON, TDV_total,
    TA: r2(TA), HCA,
    H2HC, H2HCr, H2HC_initial, H2HCr_initial,
    rtHDV, ONm, Prime, IR, MF, IR_eur, MF_eur, IR_missingRateEscales, tempsSej, tauxApp,
    tsv_n_rot_m,
    debut_vol_ms, fin_vol_ms,
    utc_arr_first_service,
    services,
  };
}
