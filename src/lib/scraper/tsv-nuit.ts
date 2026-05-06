import type { PairingDetail } from './types';

// TSV nuit : portion de chaque tronçon entre 18h00 et 06h00
// heure locale de l'escale de départ (source : feuille EP4 Google Sheet)
function legNightHours(depMs: number, arrMs: number, tzStr: string): number {
  const tz      = parseFloat(tzStr);
  const HOUR_MS = 3_600_000;
  const DAY_MS  = 86_400_000;
  const localDep = depMs + tz * HOUR_MS;
  const localArr = arrMs + tz * HOUR_MS;
  const dayStart = Math.floor(localDep / DAY_MS) * DAY_MS;

  let total = 0;
  for (let d = dayStart; d <= localArr; d += DAY_MS) {
    const nightStart = d + 18 * HOUR_MS;
    const nightEnd   = d + 30 * HOUR_MS; // 06h00 lendemain
    const from = Math.max(localDep, nightStart);
    const to   = Math.min(localArr, nightEnd);
    if (to > from) total += (to - from) / HOUR_MS;
  }
  return total;
}

export function computeTsvNuit(detail: PairingDetail): number {
  let total = 0;
  for (const duty of detail.flightDuty) {
    for (const dla of duty.dutyLegAssociation) {
      for (const leg of dla.legs) {
        if (leg.scheduledDepartureDate && leg.scheduledArrivalDate && leg.schDepStationCodeTz) {
          total += legNightHours(
            leg.scheduledDepartureDate,
            leg.scheduledArrivalDate,
            leg.schDepStationCodeTz,
          );
        }
      }
    }
  }
  return total;
}
