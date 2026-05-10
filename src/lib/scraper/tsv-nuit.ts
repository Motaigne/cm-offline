// TSV nuit — formule officielle AF appliquée par service (et non par leg).
// Source : 6_codeRot_v7.py:49-59 (déjà portée dans src/lib/ep4/night.ts).
// Le TSV démarre 1h avant le block départ et finit 30 min après le block
// arrivée (= 1.5h padding total), couvert par les +1.5 dans les formules.

import type { PairingDetail } from './types';
import { tsvNuitJ, tsvNuitJ1 } from '@/lib/ep4/night';

const HOUR_MS = 3_600_000;

function decimalUtcHour(ms: number): number {
  const d = new Date(ms);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

function adjustHour(h: number): number {
  return ((h % 24) + 24) % 24;
}

export function computeTsvNuit(detail: PairingDetail): number {
  let total = 0;
  for (const duty of detail.flightDuty ?? []) {
    const legs = (duty.dutyLegAssociation ?? []).flatMap(d => d.legs ?? []);
    if (legs.length === 0) continue;
    legs.sort((a, b) => a.scheduledDepartureDate - b.scheduledDepartureDate);

    const firstLeg = legs[0];
    const lastLeg  = legs[legs.length - 1];

    const utcOffset = parseFloat(firstLeg.schDepStationCodeTz) || 0;
    const dep_loc   = adjustHour(decimalUtcHour(firstLeg.scheduledDepartureDate) + utcOffset);
    const block     = (lastLeg.scheduledArrivalDate - firstLeg.scheduledDepartureDate) / HOUR_MS;

    total += tsvNuitJ(dep_loc, block) + tsvNuitJ1(dep_loc, block);
  }
  return Math.round(total * 100) / 100;
}
