// Parse les CSV `1_extract_MMYYYY.csv` — équivalent du pairingsearch CrewBidd,
// AVANT la dédup. 1 ligne = 1 actID (= une rotation datée concrète).
// Sert à hydrater `pairing_instance` à toutes les dates réelles (Jan→Mai 2026).

import { parseCSV, parseFR } from './parse';

const HEADER_COLUMNS_EXTRACT = [
  'actID', 'deadHead', 'legsNumber', 'stationCode', 'stopovers', 'layovers',
  'firstLayover', 'firstFlightNumber', 'aircraftCode',
  'firstBlockOff', 'lastBlockOn', 'tsvBegin', 'tsvEnd',
  'nbOnDays', 'tdvTotal', 'hc', 'hcrCrew', 'hdv',
] as const;

const COL = Object.fromEntries(HEADER_COLUMNS_EXTRACT.map((c, i) => [c, i])) as Record<typeof HEADER_COLUMNS_EXTRACT[number], number>;

/** Une rotation datée concrète (1 ligne du fichier 1_extract). */
export interface ExtractRow {
  actID: string;
  /** Stopovers normalisés avec tirets (ex: "BZV-PNR-CDG"). */
  stopovers: string;
  /** firstLayover (ex: "BZV") — peut être vide pour les rotations sans escale. */
  firstLayover: string | null;
  firstFlightNumber: string;
  aircraftCode: string;
  /** Block-off du 1er leg = depart_at de l'instance. */
  firstBlockOffMs: number;
  /** Block-on du dernier leg = arrivee_at de l'instance. */
  lastBlockOnMs: number;
  /** scheduledBeginActivityDate = briefing. */
  tsvBeginMs: number;
  /** scheduledEndActivityDate = closeout. */
  tsvEndMs: number;
  nbOnDays: number;
  hc: number;
  hcrCrew: number;
  hdv: number;
  deadHead: boolean;
  legsNumber: number;
}

export function parseExtractCsv(text: string): ExtractRow[] {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const headerRow = rows[0];
  for (let i = 0; i < HEADER_COLUMNS_EXTRACT.length; i++) {
    if ((headerRow[i] ?? '').trim() !== HEADER_COLUMNS_EXTRACT[i]) {
      throw new Error(`Extract : colonne ${i} attendue "${HEADER_COLUMNS_EXTRACT[i]}", trouvé "${headerRow[i]}"`);
    }
  }
  const out: ExtractRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.every(c => (c ?? '').trim() === '')) continue;
    const actID = (row[COL.actID] ?? '').trim();
    if (!actID) continue;
    const layover = (row[COL.firstLayover] ?? '').trim();
    out.push({
      actID,
      stopovers:         (row[COL.stopovers] ?? '').trim(),
      firstLayover:      layover && layover !== 'N/A' ? layover : null,
      firstFlightNumber: (row[COL.firstFlightNumber] ?? '').trim(),
      aircraftCode:      (row[COL.aircraftCode] ?? '').trim(),
      firstBlockOffMs:   parseInt(row[COL.firstBlockOff] ?? '0', 10),
      lastBlockOnMs:     parseInt(row[COL.lastBlockOn]   ?? '0', 10),
      tsvBeginMs:        parseInt(row[COL.tsvBegin]      ?? '0', 10),
      tsvEndMs:          parseInt(row[COL.tsvEnd]        ?? '0', 10),
      nbOnDays:          Math.round(parseFR(row[COL.nbOnDays])),
      hc:                parseFR(row[COL.hc]),
      hcrCrew:           parseFR(row[COL.hcrCrew]),
      hdv:               parseFR(row[COL.hdv]),
      deadHead:          parseFR(row[COL.deadHead]) > 0,
      legsNumber:        Math.round(parseFR(row[COL.legsNumber])),
    });
  }
  return out;
}
