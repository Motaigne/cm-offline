// Transforme une ParsedRotation (CSV historique) en rows DB :
//   - pairing_signature (avec raw_detail synthétique)
//   - pairing_instance (1 instance par rotation — chaque ID Ligne du CSV = 1 ligne)
//
// Spécificités CSV vs scrape CrewBidd :
//   - Pas de timestamp absolu par leg : on dérive depuis DebutVol + DEP/UTC[0]
//     (ancre 1) et FinVol + ARR/UTC[last] (ancre 2).
//   - Les legs intermédiaires sont datés en walk-forward monotone : day++ chaque
//     fois que l'heure UTC franchit minuit. Le résidu de jours (cas long
//     layover) est absorbé sur le dernier layover pour rester cohérent avec
//     l'ancre 2.
//   - Pas de rest_before/after : NULL (le calendrier les ignore).
//   - hcr_crew = hc (le CSV ne distingue pas) ; a81 = temps_sej > 0.

import type { ParsedRotation, ParsedLeg } from './parse';
import type { FlightDuty, LegDetail, PairingDetail } from '@/lib/scraper/types';
import { getZone } from '@/lib/scraper/zone-lookup';
import { computeTsvNuit } from '@/lib/scraper/tsv-nuit';

const FIVE_MIN_MS = 5  * 60 * 1000;
const TEN_MIN_MS  = 10 * 60 * 1000;
const HOUR_MS     = 3600 * 1000;
const DAY_MS      = 24 * HOUR_MS;

function dateStrToUtcMs(yyyymmdd: string, hoursDecimal: number): number {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 0, 0, 0, 0) + Math.round(hoursDecimal * HOUR_MS);
}

/** Walk-forward monotone : étant donné un point d'ancrage initial, calcule
 *  les ms UTC de chaque {dep, arr} en franchissant minuit dès que l'heure UTC
 *  redescend. Retourne un tableau parallèle aux legs. */
function computeLegTimes(
  rot: ParsedRotation,
): Array<{ schDep: number; schArr: number }> {
  const out: Array<{ schDep: number; schArr: number }> = [];
  const firstDep = dateStrToUtcMs(rot.debutVol, rot.legs[0].depUtcH);
  let prev = firstDep;
  for (const leg of rot.legs) {
    // Avance le jour jusqu'à ce que depUtcMs >= prev
    let depMs = Math.floor(prev / DAY_MS) * DAY_MS + Math.round(leg.depUtcH * HOUR_MS);
    while (depMs < prev) depMs += DAY_MS;
    let arrMs = Math.floor(depMs / DAY_MS) * DAY_MS + Math.round(leg.arrUtcH * HOUR_MS);
    while (arrMs < depMs) arrMs += DAY_MS;
    out.push({ schDep: depMs, schArr: arrMs });
    prev = arrMs;
  }

  // Recale : la dernière arrivée doit tomber sur FinVol + lastLeg.arrUtcH.
  // Si l'on a sous-estimé un layover (cas 24h+), on ajoute le delta jours sur
  // tous les legs à partir du dernier service-change (= début du dernier duty).
  const lastLeg = rot.legs[rot.legs.length - 1];
  const targetLastArr = dateStrToUtcMs(rot.finVol, lastLeg.arrUtcH);
  const computedLastArr = out[out.length - 1].schArr;
  if (targetLastArr > computedLastArr) {
    const deltaDays = Math.round((targetLastArr - computedLastArr) / DAY_MS);
    if (deltaDays > 0) {
      // Trouve l'index du 1er leg du dernier service (dernier duty).
      const lastService = rot.legs[rot.legs.length - 1].service;
      let lastDutyStart = rot.legs.length - 1;
      while (lastDutyStart > 0 && rot.legs[lastDutyStart - 1].service === lastService) {
        lastDutyStart--;
      }
      const shift = deltaDays * DAY_MS;
      for (let i = lastDutyStart; i < out.length; i++) {
        out[i].schDep += shift;
        out[i].schArr += shift;
      }
    }
  }
  return out;
}

/** Groupe les legs par Service column → renvoie les indices [start, end] par duty. */
function groupByService(legs: ParsedLeg[]): Array<{ start: number; end: number }> {
  const groups: Array<{ start: number; end: number }> = [];
  if (legs.length === 0) return groups;
  let curService = legs[0].service;
  let start = 0;
  for (let i = 1; i < legs.length; i++) {
    if (legs[i].service !== curService) {
      groups.push({ start, end: i - 1 });
      start = i;
      curService = legs[i].service;
    }
  }
  groups.push({ start, end: legs.length - 1 });
  return groups;
}

/** Synthétise un PairingDetail compatible avec le compute offline (A81, IR, MF).
 *  Les champs non utilisés par optiP sont laissés à 0 / vides. */
function synthesizeRawDetail(
  rot: ParsedRotation,
  legTimes: Array<{ schDep: number; schArr: number }>,
): PairingDetail {
  const dutyGroups = groupByService(rot.legs);
  let legIdSeq = 1;
  const flightDuty: FlightDuty[] = dutyGroups.map((g, idx) => {
    const dutyLegs = rot.legs.slice(g.start, g.end + 1);
    const dutyTimes = legTimes.slice(g.start, g.end + 1);
    const legDetails: LegDetail[] = dutyLegs.map((leg, j) => ({
      legId:                  legIdSeq++,
      aircraftSubtypeCode:    leg.aircraftCode,
      arrivalStationCode:     leg.arr,
      departureStationCode:   leg.dep,
      company:                leg.flightNumber.replace(/[0-9]+$/, '') || 'AF',
      flightNumber:           leg.flightNumber.replace(/^\D+/, '') || '',
      schArrStationCodeTz:    '',
      schDepStationCodeTz:    '',
      scheduledArrivalDate:   dutyTimes[j].schArr,
      scheduledDepartureDate: dutyTimes[j].schDep,
    }));
    const schBeginDate = dutyTimes[0].schDep;
    const schEndDate   = dutyTimes[dutyTimes.length - 1].schArr;
    return {
      schBeginDate,
      schEndDate,
      sequenceNumber: idx + 1,
      flightDutyValue: [{ schFlDutyTime: 0, inFunctionSchFlightTime: 0 }],
      dutyLegAssociation: [{
        legId:          legDetails[0].legId,
        sequenceNumber: 1,
        deadHead:       dutyLegs.every(l => l.deadHead) ? 1 : 0,
        layover:        idx === dutyGroups.length - 1 ? 0 : 1,
        legs:           legDetails,
      }],
    };
  });

  return {
    activityId: parseInt(rot.idLigne, 10) || 0,
    pairingValue: [{
      nbOnDays:                rot.on,
      workedFlightTime:        rot.tdvTotal,
      creditedHour:            rot.hc,
      creditedFlightDutyTime:  rot.hc,
      paidCreditedTime:        rot.hc,
      flightTime:              rot.hdv,
      restBeforeHaulDuration:  0,
      restPostHaulDuration:    0,
    }],
    flightDuty,
    serviceRest: [],
  };
}

export interface SignatureRow {
  snapshot_id?: string;            // rempli par l'appelant
  activity_number: string;
  rotation_code: string;
  nb_on_days: number;
  aircraft_code: string;
  zone: string | null;
  hc: number;
  hcr_crew: number;
  hdv: number;
  a81: boolean;
  heure_debut: string;             // "HH:MM:00"
  heure_fin:   string;
  temps_sej: number;
  legs_number: number;
  prime: number;
  rest_before_h: number | null;
  rest_after_h: number | null;
  tsv_nuit: number;
  dead_head: boolean;
  first_flight_number: string;
  first_layover: string | null;
  layovers: number;
  stopovers: string;
  station_code: string;
  tdv_total: number;
  raw_detail: PairingDetail;
  debut_sejour_at: string | null;
  fin_sejour_at:   string | null;
  escale_debut:    string | null;
  escale_fin:      string | null;
}

export interface InstanceRow {
  signature_id?: string;           // rempli après insert sig
  activity_id: string;
  depart_date: string;             // YYYY-MM-DD
  depart_at: string;               // ISO
  arrivee_at: string;
  rest_before_h: number | null;
  rest_after_h: number | null;
  scheduled_begin_activity_at: string | null;
  scheduled_end_activity_at: string | null;
}

function msToTimeStr(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:00`;
}

/** Transforme une rotation parsée en {signature, instance} prêts à insérer.
 *  Renvoie null si la rotation est invalide (pas de legs). */
export function rotationToRows(rot: ParsedRotation): { sig: SignatureRow; inst: InstanceRow } | null {
  if (rot.legs.length === 0) return null;
  const legTimes = computeLegTimes(rot);

  const firstLegDep = legTimes[0].schDep;
  const lastLegArr  = legTimes[legTimes.length - 1].schArr;
  const detail      = synthesizeRawDetail(rot, legTimes);

  // temps_sej + ancrages A81 (mêmes formules que computeA81Meta côté scraper)
  const firstDuty = detail.flightDuty[0];
  const lastDuty  = detail.flightDuty[detail.flightDuty.length - 1];
  const hasSejour = detail.flightDuty.length >= 2;
  const tempsSej  = hasSejour ? (lastDuty.schBeginDate - firstDuty.schEndDate) / HOUR_MS : 0;
  const debutSejourMs = hasSejour ? firstDuty.schEndDate - FIVE_MIN_MS : null;
  const finSejourMs   = hasSejour ? lastDuty.schBeginDate + TEN_MIN_MS : null;

  const firstDutyLegs = firstDuty.dutyLegAssociation[0].legs;
  const lastDutyLegs  = lastDuty.dutyLegAssociation[0].legs;
  const escaleDebut = hasSejour ? firstDutyLegs[firstDutyLegs.length - 1].arrivalStationCode : null;
  const escaleFin   = hasSejour ? lastDutyLegs[0].departureStationCode : null;

  const zone        = getZone(rot.rot);
  // TSV nuit : on prend la valeur CSV directement (calculée avec les bonnes
  // timezones par le pipeline historique) — computeTsvNuit sur raw_detail
  // synthétique serait faux car nos LegDetail ont schDepStationCodeTz vide.
  void computeTsvNuit;
  const layoverNum  = rot.rot ? rot.rot.split(/\s+/).filter(Boolean).length : 0;
  const firstLayover = layoverNum > 0 ? rot.rot.split(/\s+/)[0] : null;

  const sig: SignatureRow = {
    activity_number:     rot.idLigne,
    rotation_code:       rot.code,
    nb_on_days:          rot.on,
    aircraft_code:       rot.avion,
    zone,
    hc:                  rot.hc,
    hcr_crew:            rot.hc,           // CSV ne distingue pas — A81 calculé via temps_sej
    hdv:                 rot.hdv,
    a81:                 hasSejour && tempsSej > 0,
    heure_debut:         msToTimeStr(firstLegDep),
    heure_fin:           msToTimeStr(lastLegArr),
    temps_sej:           tempsSej,
    legs_number:         rot.legs.length,
    prime:               rot.prime,
    rest_before_h:       null,
    rest_after_h:        null,
    tsv_nuit:            rot.tsvNuit,
    dead_head:           rot.legs.some(l => l.deadHead),
    first_flight_number: rot.legs[0].flightNumber,
    first_layover:       firstLayover,
    layovers:            layoverNum,
    stopovers:           rot.rot.replace(/\s+/g, '-'),
    station_code:        rot.legs[0].dep,
    tdv_total:           rot.tdvTotal,
    raw_detail:          detail,
    debut_sejour_at:     debutSejourMs != null ? new Date(debutSejourMs).toISOString() : null,
    fin_sejour_at:       finSejourMs   != null ? new Date(finSejourMs).toISOString()   : null,
    escale_debut:        escaleDebut,
    escale_fin:          escaleFin,
  };

  const inst: InstanceRow = {
    activity_id:                 rot.idLigne,
    depart_date:                 rot.debutVol,
    depart_at:                   new Date(firstLegDep).toISOString(),
    arrivee_at:                  new Date(lastLegArr).toISOString(),
    rest_before_h:               null,
    rest_after_h:                null,
    scheduled_begin_activity_at: null,
    scheduled_end_activity_at:   null,
  };

  return { sig, inst };
}
