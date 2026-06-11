export interface PairingSummary {
  actId: number;
  activityNumber: string;
  deadHead: number;
  legsNumber: number;
  stationCode: string;
  stopovers: string;
  layovers: string;
  firstLayover: string;
  firstFlightNumber: string;
  aircraftSubtypeCode: string;
  beginBlockDate: number;
  endBlockDate: number;
  beginDutyDate: number;
  endDutyDate: number;
  /** Fin de l'activité (rotation officiellement close pour le crew). Utilisé
   *  pour calculer le RPC réel : (endActivityDate - endBlockDate) en ms.
   *  Les valeurs `pairingDetail.restPostHaulDuration` des endpoints SEARCH
   *  et DETAIL sont incohérentes — les timestamps sont la source de vérité. */
  scheduledEndActivityDate: number;
  scheduledBeginActivityDate: number;
  pairingDetail: {
    nbOnDays: number;
    workedFlightTime: number;
    creditedHour: number;
    paidCreditedTime: number;
    flightTime: number;
    restBeforeHaulDuration: number;
    restPostHaulDuration: number;
  };
  /** Payload brut complet renvoyé par CrewBidd `pairingsearch`, avant
   *  cherry-picking. Stocké en `raw_summary` (JSONB) pour permettre des
   *  formules / debug futurs sans re-scraper. Inclut tous les champs de
   *  `optiP_CREWBIDD_V1.md` : activityKey, activityCode, populationType,
   *  pairingArrivalStationCode, etc. */
  _raw?: Record<string, unknown>;
}

export interface LegDetail {
  legId: number;
  aircraftSubtypeCode: string;
  arrivalStationCode: string;
  departureStationCode: string;
  company: string;
  flightNumber: string;
  schArrStationCodeTz: string;
  schDepStationCodeTz: string;
  scheduledArrivalDate: number;
  scheduledDepartureDate: number;
}

export interface FlightDuty {
  /** **block-off du premier leg du service** (≠ briefing). Cf.
   *  `optiP_CREWBIDD_PAYRINGSEARCH.md:38`. Piège classique : dans `PairingSummary`
   *  (endpoint pairingsearch) `beginDutyDate` = briefing (TSV Manex, ~1h45 avant
   *  block) ; ici dans `PairingDetail.flightDuty` la sémantique est **block**, pas
   *  TSV. Ne pas confondre. */
  schBeginDate: number;
  /** **block-on du dernier leg du service** (≠ closeout). Cf.
   *  `optiP_CREWBIDD_PAYRINGSEARCH.md:39`. Idem note sur `schBeginDate` :
   *  attention au nom ambigu vs `endDutyDate` du PairingSummary. */
  schEndDate: number;
  sequenceNumber: number;
  flightDutyValue: Array<{
    schFlDutyTime: number;
    inFunctionSchFlightTime: number;
  }>;
  dutyLegAssociation: Array<{
    legId: number;
    sequenceNumber: number;
    deadHead: number;
    layover: number;
    legs: LegDetail[];
  }>;
}

export interface PairingDetail {
  activityId: number;
  pairingValue: Array<{
    nbOnDays: number;
    workedFlightTime: number;
    creditedHour: number;
    creditedFlightDutyTime: number;
    paidCreditedTime: number;
    flightTime: number;
    restBeforeHaulDuration: number;
    restPostHaulDuration: number;
  }>;
  flightDuty: FlightDuty[];
  serviceRest: Array<{
    sequenceNumber: number;
    scheduledStopDuration: number;
    beginStationCode: string;
    endStationCode: string;
    scheduledStopBeginDate: number;
    scheduledStopEndDate: number;
  }>;
}

export type ScrapeEvent =
  | { type: 'start'; total_instances: number; unique_sigs: number }
  | { type: 'progress'; current: number; total: number; rotation: string }
  | { type: 'done'; snapshot_id: string; signatures: number; instances: number }
  | { type: 'error'; message: string };
