// Static zone map from AF_Paie_Rot81 - TauxApp.csv
// Key: layovers normalized with spaces (matching API layovers field with - replaced by space)
// Value: zone code

const ZONE_TABLE: Array<{ rot: string; zone: string }> = [
  { rot: 'ABJ',           zone: 'AFR' },
  { rot: 'ABV LFW',       zone: 'AFR' },
  { rot: 'ATL',           zone: 'AME' },
  { rot: 'BEY',           zone: 'MGI' },
  { rot: 'BKK',           zone: 'APC' },
  { rot: 'BLR',           zone: 'MGI' },
  { rot: 'BOG',           zone: 'CSA' },
  { rot: 'BOS',           zone: 'AME' },
  { rot: 'BZV',           zone: 'AFR' },
  { rot: 'BZV FIH',       zone: 'AFR' },
  { rot: 'BZV PNR',       zone: 'AFR' },
  { rot: 'CAI',           zone: 'AFR' },
  { rot: 'CKY',           zone: 'AFR' },
  { rot: 'CKY NKC',       zone: 'AFR' },
  { rot: 'CPT',           zone: 'AFR' },
  { rot: 'CPT JNB',       zone: 'AFR' },
  { rot: 'DFW',           zone: 'AME' },
  { rot: 'DLA',           zone: 'AFR' },
  { rot: 'DTW',           zone: 'AME' },
  { rot: 'EWR',           zone: 'AME' },
  { rot: 'EZE',           zone: 'CSA' },
  { rot: 'FIH BZV FIH',   zone: 'AFR' },
  { rot: 'FIH BZV PNR',   zone: 'AFR' },
  { rot: 'FOR',           zone: 'CSA' },
  { rot: 'GIG',           zone: 'CSA' },
  { rot: 'GRU',           zone: 'CSA' },
  { rot: 'HKG',           zone: 'APC' },
  { rot: 'HND',           zone: 'APC' },
  { rot: 'IAD',           zone: 'AME' },
  { rot: 'IAH',           zone: 'AME' },
  { rot: 'ICN',           zone: 'APC' },
  { rot: 'JFK',           zone: 'AME' },
  { rot: 'JIB',           zone: 'AFR' },
  { rot: 'JNB',           zone: 'AFR' },
  { rot: 'JRO ZNZ',       zone: 'AFR' },
  { rot: 'LAS',           zone: 'AME' },
  { rot: 'LAX PPT LAX',   zone: 'PAC' },
  { rot: 'LFW',           zone: 'AFR' },
  { rot: 'MCO',           zone: 'AME' },
  { rot: 'MEX',           zone: 'AME' },
  { rot: 'MIA',           zone: 'AME' },
  { rot: 'MNL',           zone: 'PAC' },
  { rot: 'MNL HKG',       zone: 'PAC' },
  { rot: 'NBJ',           zone: 'AFR' },
  { rot: 'NBO',           zone: 'AFR' },
  { rot: 'NBO JRO ZNZ',   zone: 'AFR' },
  { rot: 'NDJ NSI',       zone: 'AFR' },
  { rot: 'NKC',           zone: 'AFR' },
  { rot: 'NKC CKY',       zone: 'AFR' },
  { rot: 'NSI',           zone: 'AFR' },
  { rot: 'ORD',           zone: 'AME' },
  { rot: 'PHX',           zone: 'AME' },
  { rot: 'PTY',           zone: 'CSA' },
  { rot: 'RDU',           zone: 'AME' },
  { rot: 'RUH',           zone: 'AME' },
  { rot: 'SCL',           zone: 'CSA' },
  { rot: 'SEA',           zone: 'AME' },
  { rot: 'SFO',           zone: 'AME' },
  { rot: 'SGN',           zone: 'APC' },
  { rot: 'SJO',           zone: 'CSA' },
  { rot: 'SSA',           zone: 'CSA' },
  { rot: 'SSG DLA',       zone: 'AFR' },
  { rot: 'SXM',           zone: 'COI' },
  { rot: 'TNR',           zone: 'AFR' },
  { rot: 'YUL',           zone: 'AME' },
  { rot: 'YVR',           zone: 'AME' },
  { rot: 'YYZ',           zone: 'AME' },
];

export function getZone(layovers: string): string | null {
  if (!layovers) return null;
  // API layovers: "LAX-PPT-LAX" → normalize to "LAX PPT LAX"
  const normalized = layovers.replace(/-/g, ' ');
  const exact = ZONE_TABLE.find(z => z.rot === normalized);
  if (exact) return exact.zone;
  // Fallback: first station only
  const first = normalized.split(' ')[0];
  const fallback = ZONE_TABLE.find(z => z.rot === first);
  return fallback?.zone ?? null;
}
