import type { Database } from '@/types/supabase';

export type ActivityKind = Database['public']['Enums']['activity_kind'];
export type BidCategory = Database['public']['Enums']['bid_category'];
export type Regime = Database['public']['Enums']['regime_enum'];
export type Fonction = Database['public']['Enums']['fonction_enum'];

type ActivityMeta = {
  label: string;
  color: string;       // fond
  textColor: string;   // texte lisible sur le fond
  order: number;       // ordre d'affichage dans la palette
};

export const ACTIVITY_META: Record<ActivityKind, ActivityMeta> = {
  flight:  { label: 'Vol',         color: '#3B82F6', textColor: '#FFFFFF', order: 8 }, // bleu
  conge:   { label: 'Congés',      color: '#15803D', textColor: '#FFFFFF', order: 2 }, // vert foncé
  off:     { label: 'OFF',         color: '#4ADE80', textColor: '#052E16', order: 3 }, // vert clair
  sol:     { label: 'Sol/Réserve', color: '#EC4899', textColor: '#FFFFFF', order: 4 }, // rose
  medical: { label: 'Visite méd.', color: '#BE185D', textColor: '#FFFFFF', order: 5 }, // rose foncé
  instr:   { label: 'Instruction', color: '#FBCFE8', textColor: '#831843', order: 6 }, // rose clair
  taf:     { label: 'TAF',         color: '#EAB308', textColor: '#422006', order: 7 }, // jaune
};

export const REGIME_LABEL: Record<Regime, string> = {
  TP:           'Temps plein',
  TAF7_10_12:   'TAF7 · 7j OFF × 10 mois',
  TAF7_12_12:   'TAF7 · 7j OFF × 12 mois',
  TAF10_10_12:  'TAF10 · 10j OFF × 10 mois',
  TAF10_12_12:  'TAF10 · 10j OFF × 12 mois',
  TTA92:        'TTA 92% · 1 mois OFF/an',
  TTA83:        'TTA 83% · 2 mois OFF/an',
  TTA75:        'TTA 75% · 4 mois OFF/an',
};

export const FONCTION_LABEL: Record<Fonction, string> = {
  CDB:     'Commandant de Bord',
  OPL:     'Officier Pilote de Ligne',
  INSTR:   'Instructeur',
  TRI_CDB: 'TRI CDB',
  TRI_OPL: 'TRI OPL',
};

export const BID_LABEL: Record<BidCategory, string> = {
  dda_vol: 'DDA Vol',
  vol_p:   'Vol P',
  dda_off: 'DDA OFF',
};
