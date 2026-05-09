import type { PairingSummary, PairingDetail } from './types';

const BASE_URL = 'https://crewbidd.airfrance.fr';
const SEARCH_URL = `${BASE_URL}/api/cert/pairingsearch/v1`;
const DETAIL_URL = `${BASE_URL}/api/cert/pairing/v1/ids/{id}/pairingsearch`;

export interface CrewBiddConfig {
  cookie: string;
  sn: string;
  userId: string;
}

function headers(cfg: CrewBiddConfig) {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': BASE_URL,
    'Referer': `${BASE_URL}/cm/timeline?userId=${cfg.userId}`,
    'SN': cfg.sn,
    'User-Agent': 'Mozilla/5.0',
    'Cookie': cfg.cookie,
  };
}

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

function monthBounds(month: string) {
  const [y, m] = month.split('-').map(Number);
  // La DB de M ne contient QUE les rotations qui décollent en M.
  // L'API CrewBidd exclut implicitement les rotations dont des éléments dépassent
  // `scheduledDepartureDateTo`. Une fenêtre étroite (M+1) coupe certaines variantes
  // d'horaire en fin de mois. On élargit donc à fin M+2 — le filtre client
  // (pipeline.ts) restreint ensuite aux décollages en M.
  return {
    scheduledArrivalAfterDate:  Date.UTC(y, m - 1, 1),                    // 1st of M
    scheduledDepartureDateFrom: Date.UTC(y, m - 1, 1),                    // 1st of M
    scheduledDepartureDateTo:   Date.UTC(y, m + 2, 0, 23, 59, 59, 999),   // last day of M+2
  };
}

/**
 * Convertit `YYYY-MM-DD` en bornes UTC start-of-day/end-of-day.
 */
function dayBounds(from: string, to: string) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return {
    scheduledArrivalAfterDate:  Date.UTC(fy, fm - 1, fd),
    scheduledDepartureDateFrom: Date.UTC(fy, fm - 1, fd),
    scheduledDepartureDateTo:   Date.UTC(ty, tm - 1, td, 23, 59, 59, 999),
  };
}

export interface FetchPairingsOptions {
  /** Surcharge la fenêtre par défaut (mois M complet) — utilisé pour backfill ciblé. */
  windowFrom?: string; // YYYY-MM-DD
  windowTo?:   string; // YYYY-MM-DD
}

export async function fetchAllPairings(
  month: string,
  cfg: CrewBiddConfig,
  opts: FetchPairingsOptions = {},
): Promise<PairingSummary[]> {
  const dates = (opts.windowFrom && opts.windowTo)
    ? dayBounds(opts.windowFrom, opts.windowTo)
    : monthBounds(month);
  const hdrs  = headers(cfg);
  const PAGE  = 500;
  const results: PairingSummary[] = [];

  for (let page = 0; page < 10; page++) {
    const body = {
      aircraftTypes: '332-359',
      arrDays: '2-3-4-5-6-7-1',
      commonPairing: -1,
      depDays: '2-3-4-5-6-7-1',
      isTypeC: 0,
      layoverStationCode: null,
      populationType: 2,
      preemptedPairing: 0,
      resultNumber: PAGE,
      startOffset: page * PAGE,
      showIntersectPairing: true,
      startStationCode: 'PAR',
      stopoverStationCode: null,
      ...dates,
    };

    const res = await fetch(SEARCH_URL, { method: 'POST', headers: hdrs, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`pairingsearch HTTP ${res.status}`);

    const data: any[] = await res.json();
    if (!data?.length) break;

    for (const r of data) {
      // activityNumber is a direct field; fall back to deriving from activityKey
      const actNum: string = r.activityNumber ?? (typeof r.activityKey === 'string' ? r.activityKey.slice(8) : String(r.actId));
      results.push({
        actId:              r.actId,
        activityNumber:     actNum,
        deadHead:           r.deadHead ?? 0,
        legsNumber:         r.legsNumber ?? 0,
        stationCode:        r.stationCode ?? 'CDG',
        stopovers:          r.stopovers ?? '',
        layovers:           r.layovers ?? '',
        firstLayover:       r.firstLayover ?? '',
        firstFlightNumber:  r.firstFlightNumber ?? '',
        aircraftSubtypeCode: r.aircraftSubtypeCode ?? '',
        beginBlockDate:     r.beginBlockDate ?? r.scheduledBeginBlockDate ?? 0,
        endBlockDate:       r.endBlockDate   ?? r.scheduledEndBlockDate   ?? 0,
        beginDutyDate:      r.beginDutyDate  ?? r.scheduledBeginDutyDate  ?? 0,
        endDutyDate:        r.endDutyDate    ?? r.scheduledEndDutyDate    ?? 0,
        pairingDetail: {
          nbOnDays:         r.pairingDetail?.nbOnDays         ?? 0,
          workedFlightTime: r.pairingDetail?.workedFlightTime ?? 0,
          creditedHour:     r.pairingDetail?.creditedHour     ?? 0,
          paidCreditedTime: r.pairingDetail?.paidCreditedTime ?? 0,
          flightTime:       r.pairingDetail?.flightTime       ?? 0,
        },
      });
    }

    if (data.length < PAGE) break;
    await sleep(2000);
  }

  return results;
}

export async function fetchPairingDetail(
  actId: number,
  cfg: CrewBiddConfig,
): Promise<PairingDetail | null> {
  const url = DETAIL_URL.replace('{id}', String(actId));
  const res = await fetch(url, { headers: headers(cfg) });
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0] as PairingDetail;
}
