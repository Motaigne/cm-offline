// Types publics du module EP4. Voir build.ts pour le porting depuis les
// scripts Python sources (8_ep4_V7.py, 8b_ep4_81.py, 6_codeRot_v7.py).

import type { PairingDetail } from '@/lib/scraper/types';

export interface Ep4Leg {
  flightNumber: string;
  aircraft: string;
  dep: string;
  arr: string;
  /** Heure de départ UTC en décimal (ex: 14.5 pour 14h30). */
  dep_utc_h: number;
  arr_utc_h: number;
  /** Heure locale de départ (UTC + offset escale, mod 24). */
  dep_loc_h: number;
  /** Timestamp ms UTC. */
  begin_ms: number;
  end_ms: number;
  /** (arr - dep) / 3.6e6 — équivaut au BLOCK du leg. */
  tdv_troncon: number;
  /** Index 1..N dans le service. */
  troncon_index: number;
  /** tdv_troncon + 0.58. */
  hv100r: number;
  /** Proration mensuelle de HCV au prorata des ms passées dans le mois M. */
  hcv_mois_m: number;
  dead_head: boolean;
}

export interface Ep4Service {
  /** Index 1..N (= flightDuty.sequenceNumber dans raw_detail). */
  service_index: number;
  legs: Ep4Leg[];
  /** (last leg arr - first leg dep) / 3.6e6 — durée block totale du service. */
  block_block: number;
  /** TSV = schFlDutyTime du flightDutyValue. */
  tsv: number;
  has_dead_head: boolean;
  TME: number; CMT: number; HCV: number; HCT: number; H1: number;
  HCVr: number; H1r: number;
  tsv_nuit_j: number; tsv_nuit_j1: number; tsv_nuit: number;
  /** TSV nuit projeté sur le mois M par service (0 si dead head). */
  tsv_n_ser_m: number;
}

export interface Ep4Rotation {
  rotation_code: string;
  zone: string | null;
  HDV: number;
  HC: number;
  ON: number;
  TDV_total: number;
  TA: number;
  HCA: number;
  /** Final = rtHDV × max(HCA, sum(H1)). */
  H2HC: number;
  H2HCr: number;
  /** Avant pondération rtHDV (utile pour debug / cross-check Python). */
  H2HC_initial: number;
  H2HCr_initial: number;
  rtHDV: number;
  /** ON projeté sur le mois M. */
  ONm: number;
  /** Bi-tronçon : 1 par service ≥ 2 legs hors TLV/BEY. */
  Prime: number;
  /** Indemnité Repas. */
  IR: number;
  tempsSej: number;
  tauxApp: number | null;
  /** Somme des tsv_n_ser_m. */
  tsv_n_rot_m: number;
  debut_vol_ms: number;
  fin_vol_ms: number;
  utc_arr_first_service: number;
  services: Ep4Service[];
}

export interface TauxAppRow {
  rot_code: string;
  duree_min_h: number;
  duree_max_h: number;
  taux: number;
}

export type { PairingDetail };
