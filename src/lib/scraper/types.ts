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
  pairingDetail: {
    nbOnDays: number;
    workedFlightTime: number;
    creditedHour: number;
    paidCreditedTime: number;
    flightTime: number;
    restBeforeHaulDuration: number;
    restPostHaulDuration: number;
  };
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
  schBeginDate: number;
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
