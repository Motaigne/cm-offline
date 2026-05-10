// Lookup taux IR + MF par escale.
// Source : annexe_table slug 'ir_mf_rates' (cf. migration 0011).

export interface IrMfRate {
  escale: string;
  country: string;
  currency: string;
  ir_eur: number;
  mf_eur: number;
}

export interface ZoneEscalesRow {
  zone: string;
  /** Liste séparée par virgules pour lecture humaine. */
  escales: string;
}

export function lookupIrMfRate(rates: IrMfRate[], escale: string | null | undefined): IrMfRate | null {
  if (!escale) return null;
  const code = escale.trim().toUpperCase();
  return rates.find(r => r.escale === code) ?? null;
}
