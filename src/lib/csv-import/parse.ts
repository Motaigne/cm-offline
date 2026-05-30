// Parse les CSV historiques `8_cleanEp4_MMYYYY.csv` (sources Jan→Mai 2026).
//
// Structure du CSV :
//   - 1 ligne d'en-tête de colonnes
//   - puis blocs : 1 ligne "header rotation" (Code rempli) + N lignes legs
//     (Code vide) + 1 ligne vide (séparateur)
//   - décimales FR (virgule), dates au format dd/mm/yyyy

const HEADER_COLUMNS = [
  'Code', 'ROT', 'N° Vol', 'Avion', 'DEP', 'ARR', 'DEP/UTC', 'ARR/UTC',
  'DebutVol', 'FinVol', 'HDV', 'HC', 'TSV', 'ON', 'ONm', 'TDV Total',
  'Service', 'Tronçon', 'ID Ligne', 'ID Tronçon', 'TDV/troncon', 'BLOCK/BLOCK',
  'TA', 'TSV nuit J', 'TSV nuit J+1', 'TSV nuit', 'TSVnSerM', 'TSVnRotM',
  'TME', 'CMT', 'HCV', 'HCVmoisM', 'HCT', 'HCA', 'H1', 'H2HC', 'rtHDV',
  'HV100r', 'HCVr', 'H1r', 'H2HCr', 'Prime', 'deadHead', 'IR',
] as const;

const COL = Object.fromEntries(HEADER_COLUMNS.map((c, i) => [c, i])) as Record<typeof HEADER_COLUMNS[number], number>;

/** Cellule CSV → number FR (virgule décimale). Retourne 0 si vide / invalide. */
export function parseFR(s: string | undefined): number {
  if (!s) return 0;
  const n = parseFloat(s.replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/** "01/01/2026" → "2026-01-01". null si vide ou format invalide. */
export function parseDateFR(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Parse CSV (RFC 4180 simplifié avec quote ") → tableau de tableaux de cellules. */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let cell = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuote = false;
      } else cell += c;
    } else {
      if (c === '"') inQuote = true;
      else if (c === ',') { cur.push(cell); cell = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { cur.push(cell); cell = ''; rows.push(cur); cur = []; }
      else cell += c;
    }
  }
  if (cell.length || cur.length) { cur.push(cell); rows.push(cur); }
  return rows;
}

/** Une jambe (leg) parsée depuis une ligne du CSV. */
export interface ParsedLeg {
  /** Service column = numéro de duty (1, 2, 3, ...) — légers groupés par même service. */
  service: number;
  /** Tronçon dans la duty (1.0, 2.0, ...). Float dans le CSV ; on stocke tel quel. */
  troncon: number;
  flightNumber: string;
  aircraftCode: string;
  dep: string;
  arr: string;
  /** Heure de départ UTC en décimal (ex: 17.92 = 17h55). */
  depUtcH: number;
  /** Heure d'arrivée UTC en décimal. */
  arrUtcH: number;
  deadHead: boolean;
}

/** Une rotation parsée : metadata (depuis la 1re ligne) + N legs. */
export interface ParsedRotation {
  /** Code rotation (ex: "8ON 25LAX PPT LAX"). */
  code: string;
  /** Layovers (ex: "LAX PPT LAX"). */
  rot: string;
  /** ID Ligne = identifiant unique du pairing (= activity_number, == activity_id). */
  idLigne: string;
  /** Avion (359, 777, 332, …). */
  avion: string;
  /** Date début rotation (YYYY-MM-DD). */
  debutVol: string;
  /** Date fin rotation (YYYY-MM-DD). */
  finVol: string;
  /** Totaux rotation. */
  hdv: number;
  hc: number;
  tsv: number;
  on: number;
  tdvTotal: number;
  tsvNuit: number;
  prime: number;
  ir: number;
  legs: ParsedLeg[];
}

/** Parse un texte CSV en rotations. Lève si le header ne correspond pas. */
export function parseRotationsCsv(text: string): ParsedRotation[] {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  // Vérification header
  const headerRow = rows[0];
  for (let i = 0; i < HEADER_COLUMNS.length; i++) {
    if ((headerRow[i] ?? '').trim() !== HEADER_COLUMNS[i]) {
      throw new Error(`Colonne ${i} attendue "${HEADER_COLUMNS[i]}", trouvé "${headerRow[i]}"`);
    }
  }

  const rotations: ParsedRotation[] = [];
  let cur: ParsedRotation | null = null;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const code = (row[COL.Code] ?? '').trim();
    const hasContent = row.some(c => (c ?? '').trim() !== '');
    if (!hasContent) {
      // Séparateur entre rotations
      if (cur) { rotations.push(cur); cur = null; }
      continue;
    }
    if (code) {
      // Nouveau header rotation
      if (cur) rotations.push(cur);
      const debutVol = parseDateFR(row[COL.DebutVol]);
      const finVol = parseDateFR(row[COL.FinVol]);
      if (!debutVol || !finVol) {
        throw new Error(`Rotation "${code}" : DebutVol/FinVol invalide (${row[COL.DebutVol]} / ${row[COL.FinVol]})`);
      }
      cur = {
        code,
        rot: (row[COL.ROT] ?? '').trim(),
        idLigne: (row[COL['ID Ligne']] ?? '').trim(),
        avion: (row[COL.Avion] ?? '').trim(),
        debutVol,
        finVol,
        hdv:      parseFR(row[COL.HDV]),
        hc:       parseFR(row[COL.HC]),
        tsv:      parseFR(row[COL.TSV]),
        on:       parseFR(row[COL.ON]),
        tdvTotal: parseFR(row[COL['TDV Total']]),
        tsvNuit:  parseFR(row[COL['TSV nuit']]),
        prime:    parseFR(row[COL.Prime]),
        ir:       parseFR(row[COL.IR]),
        legs: [],
      };
    }
    if (!cur) continue;
    cur.legs.push({
      service:      Math.round(parseFR(row[COL.Service])),
      troncon:      parseFR(row[COL['Tronçon']]),
      flightNumber: (row[COL['N° Vol']] ?? '').trim(),
      aircraftCode: (row[COL.Avion] ?? '').trim(),
      dep:          (row[COL.DEP] ?? '').trim(),
      arr:          (row[COL.ARR] ?? '').trim(),
      depUtcH:      parseFR(row[COL['DEP/UTC']]),
      arrUtcH:      parseFR(row[COL['ARR/UTC']]),
      deadHead:     parseFR(row[COL.deadHead]) > 0,
    });
  }
  if (cur) rotations.push(cur);
  return rotations;
}
