// Parser EP4 (Air France) — converti les items texte+positions d'un PDF EP4
// en structures typées exploitables. Ce module est PURE : il prend en entrée
// les items déjà extraits par pdfjs (cf. ep4-pdf-extract.ts pour la couche
// pdfjs). Cette séparation permet de tester contre des dumps JSON sans avoir
// besoin de pdfjs runtime.
//
// Source de vérité du format : observation du PDF `AF_Activite_202601.pdf`
// (dump complet dans sources/sourcesEP4/dump.txt). Si AF change le layout,
// la fonction `assertExpectedPage` lèvera un `Ep4FormatError` plutôt que de
// produire des données silencieusement fausses.

// ────────────────────────────────────────────────────────────────────────────
// Types d'entrée (subset de ce que pdfjs fournit)
// ────────────────────────────────────────────────────────────────────────────

export interface PdfItem {
  x: number;
  y: number;
  w: number;
  h: number;
  fontName: string;
  str: string;
}

export interface PdfPage {
  page:   number;
  width:  number;
  height: number;
  items:  PdfItem[];
}

// ────────────────────────────────────────────────────────────────────────────
// Types de sortie
// ────────────────────────────────────────────────────────────────────────────

export interface Ep4Meta {
  base:       string | null;  // "CDG"
  specialite: string | null;  // "OPL"
  libelle:    string | null;  // "OPL 100%"
  fonction:   string | null;  // typiquement vide
  classe:     string | null;  // "2"
  echelon:    string | null;  // "03"
  monthLabel: string | null;  // "JANVIER 2026"
  /** ISO YYYY-MM dérivé de monthLabel ; null si non parsable. */
  monthIso:   string | null;
  nom:        string | null;
  prenom:     string | null;
  matricule:  string | null;
  /** "Édité le 25 février 2026" (date d'émission du PDF). */
  ediLe:      string | null;
}

/** "31 | 21.10" → { day: 31, hour: 21, decimal: 0.10 }. Centièmes industriels :
 *  21.10 = 21h06min (= 21 + 0.10×60). Le séparateur ":" parfois observé dans
 *  le PDF (typo AF) est normalisé en ".". `24.00` est une notation idiomatique
 *  = "minuit du jour suivant" (à expanser côté consumer). Null si non parsable. */
export interface HoraireJJHHMM {
  raw:     string;  // valeur brute observée
  day:     number;
  hour:    number;
  decimal: number;  // 0..0.99, centièmes (industriel)
}

export type RowKind =
  | 'normal'              // ligne comptée pour le calcul du mois (police regular)
  | 'spillover_info'      // ligne italique "info totale" (= ligne 1 du cas spillover)
  | 'spillover_prorata';  // ligne italique prorata m-1 ou m+1 (selon contexte)

export interface Ep4HoraireRow {
  /** Index d'apparition (top→bottom) dans la table — sert au matching avec
   *  l'EP4 calculé côté app. */
  index:      number;
  kind:       RowKind;
  natIrg:     string | null;   // "0 0"
  numLigne:   string | null;   // "0972"
  typeAvion:  string | null;   // "O-30" — bonus, pas dans le CSV cible
  immat:      string | null;   // "GZCN" — bonus
  sab:        string | null;   // "JND" / "JTD" / "JLD" ...
  escDep:     string | null;
  reelDep:    HoraireJJHHMM | null;
  progDep:    HoraireJJHHMM | null;
  escArr:     string | null;
  reelArr:    HoraireJJHHMM | null;
  progArr:    HoraireJJHHMM | null;
  reelVol:    number | null;   // centièmes industriels (9.42 = 9h25)
  progVol:    number | null;
  vref:       number | null;
  tsv:        number | null;
  ta:         number | null;
  tpsVolNuit: number | null;
}

export interface Ep4ActiviteRow {
  index:        number;
  kind:         RowKind;
  date:         string | null;  // "31/12/25"
  numVol:       string | null;  // "0972"
  typeAvion:    string | null;
  sab:          string | null;
  depart:       string | null;
  arrivee:      string | null;
  hvReal:       number | null;
  tme:          number | null;
  cmt:          number | null;
  hv100:        number | null;
  hcv:          number | null;
  hct:          number | null;
  hca:          number | null;
  h1:           number | null;
  h2hc:         number | null;
  hv100r:       number | null;
  hcvr:         number | null;
  h1r:          number | null;
  h2hcR:        number | null;
  montantHcR:   number | null;
  majoNuit:     number | null;
  montantNuit:  number | null;
  majo10:       number | null;
  primeCdb:     number | null;
}

export interface Ep4ActiviteTotaux {
  h2hc:        number | null;  // total H2/HC
  h2hcR:       number | null;
  montantHcR:  number | null;
  majoNuit:    number | null;
  montantNuit: number | null;
  majo10:      number | null;
  primeCdb:    number | null;
  /** Breakdown Vol / Sol affiché en bas-droite du PDF Décompte. Reflète le
   *  tableau "Vol/Sol/Total" du PDF AF, qui ventile les totaux entre activités
   *  de vol (rotations) et activités sol (formations, instruction…). `null`
   *  si le mois n'a pas d'activité sol (= tableau pas rendu côté AF). */
  vol?: Omit<Ep4ActiviteTotaux, 'vol' | 'sol'> | null;
  sol?: Omit<Ep4ActiviteTotaux, 'vol' | 'sol'> | null;
}

/** Bloc "1er mai/Noël" + KSP + PVEI + HS, en bas de la page 2. */
export interface Ep4ActiviteSummary {
  /** HS. Fixe :   unit (25.58)  · total (943.13)  · majoNuit (36.87) */
  hsFixe:    { unit: number | null; total: number | null; majoNuit: number | null };
  hsVol:     { unit: number | null; total: number | null; majoNuit: number | null };
  /** HS CAC : 1012.05 — valeur unique. */
  hsCac:     number | null;
  ksp:       number | null;
  pvei1:     number | null;  // "1ère pér"
  pvei2:     number | null;  // "2ème pér" — null si pas de basculement dans le mois
  calculHs:  number | null;  // 80.58
  totHcrPlusNuit: number | null;
  nb30e:     number | null;
  seuilHs:   number | null;
}

export interface Ep4FraisRow {
  index:        number;
  kind:         RowKind;
  numLigne:     string | null;
  sab:          string | null;  // "JND" / "JTD" — situation à bord
  escDep:       string | null;
  horaireDep:   HoraireJJHHMM | null;
  decDep:       number | null;
  pdejDep:      number | null;
  irDep:        number | null;
  mfDep:        number | null;
  escArr:       string | null;
  horaireArr:   HoraireJJHHMM | null;
  decArr:       number | null;
  pdejArr:      number | null;
  irArr:        number | null;
  mfArr:        number | null;
  totalIndem:   number | null;
  typeTransport:string | null;
  km:           number | null;
  mtDec:        number | null;
  pnExonere:    number | null;
  pnNonExonere: number | null;
}

export interface Ep4FraisTotaux {
  irDep:        number | null;
  mfDep:        number | null;
  decArr:       number | null;
  irArr:        number | null;
  mfArr:        number | null;
  totalIndem:   number | null;
  mtDec:        number | null;
  pnExonere:    number | null;
  pnNonExonere: number | null;
}

export interface Ep4PdfData {
  meta:     Ep4Meta;
  horaire:  { rows: Ep4HoraireRow[] };
  activite: { rows: Ep4ActiviteRow[]; totaux: Ep4ActiviteTotaux; summary: Ep4ActiviteSummary };
  frais:    { rows: Ep4FraisRow[];    totaux: Ep4FraisTotaux };
  /** Anomalies non bloquantes (libellés inattendus, item hors range, etc.). */
  warnings: string[];
}

export class Ep4FormatError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'Ep4FormatError';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Titres attendus (anchors) — la PREMIÈRE défense face à un format changé.
// ────────────────────────────────────────────────────────────────────────────

const TITLE_HORAIRE  = "FEUILLE HORAIRE D'ACTIVITE DU PERSONNEL NAVIGANT EP4";
const TITLE_ACTIVITE = "FEUILLE DE DECOMPTE D'ACTIVITE DU PERSONNEL NAVIGANT EP4";
const TITLE_FRAIS    = 'FRAIS DE DEPLACEMENT-HEBERGEMENT DU PERSONNEL NAVIGANT EP4';

// ────────────────────────────────────────────────────────────────────────────
// Définition des colonnes (ranges x). Ancrées par observation du PDF de
// référence (dump complet dans sources/sourcesEP4/dump.txt). Le `key` doit
// correspondre à un champ de la row TypeScript.
// ────────────────────────────────────────────────────────────────────────────

interface Col { key: string; xMin: number; xMax: number; }

const COLS_HORAIRE: Col[] = [
  { key: 'natIrg',     xMin:  25, xMax:  65 },
  { key: 'numLigne',   xMin:  65, xMax: 100 },
  { key: 'typeAvion',  xMin: 110, xMax: 150 },
  { key: 'immat',      xMin: 150, xMax: 195 },
  { key: 'sab',        xMin: 195, xMax: 240 },
  { key: 'escDep',     xMin: 240, xMax: 275 },
  { key: 'reelDep',    xMin: 275, xMax: 335 },
  { key: 'progDep',    xMin: 335, xMax: 390 },
  { key: 'escArr',     xMin: 390, xMax: 425 },
  { key: 'reelArr',    xMin: 425, xMax: 485 },
  { key: 'progArr',    xMin: 485, xMax: 545 },
  { key: 'reelVol',    xMin: 545, xMax: 595 },
  { key: 'progVol',    xMin: 595, xMax: 645 },
  { key: 'vref',       xMin: 645, xMax: 685 },
  { key: 'tsv',        xMin: 685, xMax: 735 },
  { key: 'ta',         xMin: 735, xMax: 785 },
  { key: 'tpsVolNuit', xMin: 785, xMax: 842 },
];

const COLS_ACTIVITE: Col[] = [
  { key: 'date',        xMin:  18, xMax:  70 },
  { key: 'numVol',      xMin:  70, xMax: 110 },
  { key: 'typeAvion',   xMin: 115, xMax: 150 },
  { key: 'sab',         xMin: 150, xMax: 185 },
  { key: 'depart',      xMin: 185, xMax: 225 },
  { key: 'arrivee',     xMin: 225, xMax: 265 },
  { key: 'hvReal',      xMin: 265, xMax: 295 },
  { key: 'tme',         xMin: 295, xMax: 325 },
  { key: 'cmt',         xMin: 325, xMax: 360 },
  { key: 'hv100',       xMin: 360, xMax: 390 },
  { key: 'hcv',         xMin: 390, xMax: 420 },
  { key: 'hct',         xMin: 420, xMax: 445 },
  { key: 'hca',         xMin: 445, xMax: 475 },
  { key: 'h1',          xMin: 475, xMax: 498 },
  { key: 'h2hc',        xMin: 498, xMax: 525 },
  { key: 'hv100r',      xMin: 525, xMax: 555 },
  { key: 'hcvr',        xMin: 555, xMax: 585 },
  { key: 'h1r',         xMin: 585, xMax: 612 },
  { key: 'h2hcR',       xMin: 612, xMax: 645 },
  { key: 'montantHcR',  xMin: 645, xMax: 685 },
  { key: 'majoNuit',    xMin: 685, xMax: 715 },
  { key: 'montantNuit', xMin: 715, xMax: 755 },
  { key: 'majo10',      xMin: 755, xMax: 785 },
  { key: 'primeCdb',    xMin: 785, xMax: 830 },
];

const COLS_FRAIS: Col[] = [
  { key: 'numLigne',     xMin:  20, xMax:  75 },
  { key: 'sab',          xMin:  75, xMax: 115 },  // "JND" / "JTD" / etc.
  { key: 'escDep',       xMin: 115, xMax: 150 },
  { key: 'horaireDep',   xMin: 150, xMax: 220 },
  { key: 'decDep',       xMin: 220, xMax: 250 },
  { key: 'pdejDep',      xMin: 250, xMax: 290 },
  { key: 'irDep',        xMin: 290, xMax: 325 },
  { key: 'mfDep',        xMin: 325, xMax: 360 },
  { key: 'escArr',       xMin: 360, xMax: 395 },
  { key: 'horaireArr',   xMin: 395, xMax: 460 },
  { key: 'decArr',       xMin: 460, xMax: 490 },
  { key: 'pdejArr',      xMin: 490, xMax: 520 },
  { key: 'irArr',        xMin: 520, xMax: 550 },
  { key: 'mfArr',        xMin: 550, xMax: 575 },
  { key: 'totalIndem',   xMin: 575, xMax: 620 },
  { key: 'typeTransport',xMin: 620, xMax: 655 },
  { key: 'km',           xMin: 655, xMax: 680 },
  { key: 'mtDec',        xMin: 680, xMax: 718 },
  { key: 'pnExonere',    xMin: 718, xMax: 762 },
  { key: 'pnNonExonere', xMin: 762, xMax: 830 },
];

// ────────────────────────────────────────────────────────────────────────────
// Helpers génériques
// ────────────────────────────────────────────────────────────────────────────

/** Groupe les items par même y (tolerance ±tol), tri par x croissant à l'intérieur. */
function groupByY(items: PdfItem[], tol = 1.5): PdfItem[][] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: PdfItem[][] = [];
  let current: PdfItem[] = [];
  let lastY = -Infinity;
  for (const it of sorted) {
    if (Math.abs(it.y - lastY) > tol) {
      if (current.length) rows.push(current);
      current = [];
    }
    current.push(it);
    lastY = it.y;
  }
  if (current.length) rows.push(current);
  // Tri x dans chaque row (sécurité au cas où le groupage casse l'ordre).
  return rows.map(r => r.sort((a, b) => a.x - b.x));
}

/** Assigne chaque item d'une row à une colonne par range x. Concatène les
 *  items qui tombent dans la même colonne (les chiffres+séparateurs sont
 *  parfois éclatés en plusieurs items pdfjs). */
function assignToColumns(row: PdfItem[], cols: Col[]): Record<string, string> {
  const out: Record<string, string[]> = Object.fromEntries(cols.map(c => [c.key, []]));
  for (const it of row) {
    const s = it.str.trim();
    if (!s) continue;
    const col = cols.find(c => it.x >= c.xMin && it.x < c.xMax);
    if (!col) continue; // hors colonne — ignore (margins ou décoration)
    out[col.key].push(s);
  }
  const merged: Record<string, string> = {};
  for (const [k, arr] of Object.entries(out)) merged[k] = arr.join(' ').trim();
  return merged;
}

/** Parse un nombre en notation FR ("1,234.56" / "13,892.45" — la virgule est
 *  un séparateur de milliers chez AF, le point la décimale). Empty → null. */
function parseNum(s: string | undefined | null): number | null {
  if (!s) return null;
  const t = s.replace(/\s/g, '').replace(/,/g, '');
  if (t === '' || t === '----' || t === '-') return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

/** Parse "31 | 21.10" (ou "31 | 24:00" — typo AF, on normalise `:` → `.`).
 *  Tolère les espaces variables autour du `|`. Null si non parsable. */
function parseHoraire(s: string | undefined | null): HoraireJJHHMM | null {
  if (!s) return null;
  const raw = s.trim();
  if (!raw || raw === '----') return null;
  // Format attendu : "DD | HH.MM" ou "DD | HH:MM" (typo AF)
  const m = /^(\d{1,2})\s*\|\s*(\d{1,2})[.:](\d{1,2})$/.exec(raw);
  if (!m) return null;
  const day  = parseInt(m[1], 10);
  const hour = parseInt(m[2], 10);
  const dec  = parseInt(m[3], 10) / 100;
  if (!Number.isFinite(day) || !Number.isFinite(hour) || !Number.isFinite(dec)) return null;
  return { raw, day, hour, decimal: dec };
}

/** Détermine si une row est en italique (= spillover info ou prorata). Se
 *  base sur la font de la PREMIÈRE cellule non-vide (la cellule "ancre" :
 *  date / numéro de ligne). Plus robuste qu'un test global car certaines
 *  colonnes (ex: SAB sur la page Activité) utilisent une font dédiée
 *  (g_d0_f4) qui n'est ni la regular ni l'italique. */
function isRowItalic(row: PdfItem[], regularFont: string): boolean {
  const first = [...row].sort((a, b) => a.x - b.x).find(it => it.str.trim() !== '');
  if (!first) return false;
  return first.fontName !== regularFont;
}

/** Identifie la font "regular" en se basant sur les libellés des en-têtes
 *  (haut de page, qui sont toujours en regular). Sécurité : retombe sur
 *  'g_d0_f1' si rien ne sort. */
function detectRegularFont(items: PdfItem[]): string {
  // Heuristique : la font la plus utilisée dans le haut de la page (y < 150)
  // est la regular.
  const counts: Record<string, number> = {};
  for (const it of items) {
    if (it.y > 150) continue;
    if (!it.str.trim()) continue;
    counts[it.fontName] = (counts[it.fontName] ?? 0) + 1;
  }
  let best = 'g_d0_f1';
  let bestN = -1;
  for (const [k, n] of Object.entries(counts)) {
    if (n > bestN) { best = k; bestN = n; }
  }
  return best;
}

const MONTHS_FR: Record<string, string> = {
  JANVIER: '01',   FEVRIER: '02',  FÉVRIER: '02', MARS:      '03', AVRIL:    '04',
  MAI:     '05',   JUIN:    '06',  JUILLET:  '07',AOUT:      '08', AOÛT:     '08',
  SEPTEMBRE:'09', OCTOBRE: '10',   NOVEMBRE: '11',DECEMBRE: '12',  DÉCEMBRE: '12',
};

function monthLabelToIso(label: string | null): string | null {
  if (!label) return null;
  // "JANVIER 2026" → "2026-01"
  const m = /^([A-ZÀÁÂÄÉÈÊËÎÏÔÖÙÛÜÇ]+)\s+(\d{4})$/i.exec(label.trim());
  if (!m) return null;
  const mm = MONTHS_FR[m[1].toUpperCase()];
  if (!mm) return null;
  return `${m[2]}-${mm}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Page parsing
// ────────────────────────────────────────────────────────────────────────────

function findPageByTitle(pages: PdfPage[], title: string): PdfPage {
  for (const p of pages) {
    const has = p.items.some(it => it.str.trim() === title);
    if (has) return p;
  }
  throw new Ep4FormatError(`Page introuvable : titre "${title}" absent du PDF. Format inattendu ?`);
}

/** Méta commune (Base/Spécialité/.../Mois). Présente sur les 3 pages, on
 *  la lit depuis la première qu'on trouve. */
function parseMeta(page: PdfPage): Ep4Meta {
  // Les libellés (Nom, Prénom, Matricule, Base, Spécialité, Libellé, Fonction,
  // Classe, Echelon, Mois) sont sur une ligne (y ≈ 90). Les valeurs sont sur
  // la ligne suivante (y ≈ 103). Stratégie : pour chaque libellé reconnu,
  // chercher l'item valeur le plus proche en x sur la row suivante.
  const labelRow = page.items.filter(it => it.y >= 88 && it.y <= 93 && it.str.trim() !== '');
  const valueRow = page.items
    .filter(it => it.y >= 100 && it.y <= 110 && it.str.trim() !== '')
    .sort((a, b) => a.x - b.x);

  // Mapping value→label par "closest x" : pour chaque item de la ligne valeur,
  // on l'attribue au libellé dont le x est le plus proche. Plus robuste qu'un
  // range x prédéfini : tolère les libellés tassés et les valeurs décalées à
  // gauche/droite de leur entête (cas observé : "JANVIER" x=739 sous "Mois"
  // x=760, et "OPL 100%" x=517 sous "Libellé" x=524).
  const labelsForMap = labelRow.filter(it => it.str.trim() !== '');
  const valueByLabel: Record<string, string[]> = {};
  for (const val of valueRow) {
    const valStr = val.str.trim();
    if (!valStr) continue;
    let best: { lab: PdfItem; dist: number } | null = null;
    for (const lab of labelsForMap) {
      const dist = Math.abs(lab.x - val.x);
      if (!best || dist < best.dist) best = { lab, dist };
    }
    if (!best) continue;
    const key = best.lab.str.trim();
    (valueByLabel[key] ??= []).push(valStr);
  }

  function valueNearLabel(labels: string[]): string | null {
    for (const lbl of labels) {
      const arr = valueByLabel[lbl];
      if (arr && arr.length) return arr.join(' ').trim();
    }
    return null;
  }

  const monthLabel = valueNearLabel(['Mois']);
  // Mois "JANVIER 2026" sort souvent éclaté en 2 items "JANVIER" + "2026"
  // → join naturel via map+join ci-dessus.

  const ediItem = page.items.find(it => /^Edit[éeê]\s+le\s+/.test(it.str));
  const ediLe = ediItem?.str.trim() ?? null;

  return {
    base:       valueNearLabel(['Base']),
    specialite: valueNearLabel(['Spécialité']),
    libelle:    valueNearLabel(['Libellé']),
    fonction:   valueNearLabel(['Fonction']),
    classe:     valueNearLabel(['Classe']),
    echelon:    valueNearLabel(['Echelon']),
    monthLabel,
    monthIso:   monthLabelToIso(monthLabel),
    nom:        valueNearLabel(['Nom']),
    prenom:     valueNearLabel(['Prénom']),
    matricule:  valueNearLabel(['Matricule']),
    ediLe,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Parsers spécifiques
// ────────────────────────────────────────────────────────────────────────────

function parseHoraireTable(page: PdfPage, regularFont: string, warnings: string[]): Ep4HoraireRow[] {
  // Bornes : démarre après le sous-libellé "Tps Vol Nuit", pas de "Totaux"
  // explicite sur cette page → on capture jusqu'au pied de page.
  const yStart = yLastHeader(page) + 5;
  const yEnd   = page.height - 30; // marge bas pour le footer (logo / "Page x/y").

  const dataItems = page.items.filter(it => it.y > yStart && it.y < yEnd);
  const rowsRaw   = groupByY(dataItems);

  const out: Ep4HoraireRow[] = [];
  let idx = 0;
  for (const rowItems of rowsRaw) {
    // Filtre : une vraie ligne data doit avoir un Esc. dep IATA (3 chars) ET
    // un identifiant (numéro de vol OU code activité sol comme "SST", "SOL",
    // "MED"). On accepte les codes alphanumériques 2-5 chars pour ne pas
    // skipper les vols annulés (CDG→CDG avec code lettré) ou les activités
    // sol. Fallback : si numLigne vide, on accepte si on a au moins une
    // horaire valide (= vraie data, pas un header résiduel).
    const cells = assignToColumns(rowItems, COLS_HORAIRE);
    const hasIdent = /^[A-Za-z0-9]{2,5}$/.test(cells.numLigne);
    const hasEscDep = cells.escDep.length === 3;
    const hasHoraire = parseHoraire(cells.reelDep) != null
                    || parseHoraire(cells.reelArr) != null
                    || parseHoraire(cells.progDep) != null
                    || parseHoraire(cells.progArr) != null;
    const looksLikeRow = hasEscDep && (hasIdent || hasHoraire);
    if (!looksLikeRow) continue;

    const italic = isRowItalic(rowItems, regularFont);
    // Détection sous-type spillover : marqueur XXX dans une des escales.
    const hasXXX = cells.escDep === 'XXX' || cells.escArr === 'XXX';
    // Présence d'une escale "XXX" → toujours un prorata (ligne L2 ou L3 d'un
    // vol à cheval, cf. cf1). L'italique seule (sans XXX) marque la ligne L1
    // "info totale" du vol entier. Sinon ligne classique.
    const kind: RowKind =
      hasXXX ? 'spillover_prorata' :
      italic ? 'spillover_info'    :
      'normal';

    out.push({
      index: idx++,
      kind,
      natIrg:     cells.natIrg     || null,
      numLigne:   cells.numLigne   || null,
      typeAvion:  cells.typeAvion  || null,
      immat:      cells.immat      || null,
      sab:        cells.sab        || null,
      escDep:     cells.escDep     || null,
      reelDep:    parseHoraire(cells.reelDep),
      progDep:    parseHoraire(cells.progDep),
      escArr:     cells.escArr     || null,
      reelArr:    parseHoraire(cells.reelArr),
      progArr:    parseHoraire(cells.progArr),
      reelVol:    parseNum(cells.reelVol),
      progVol:    parseNum(cells.progVol),
      vref:       parseNum(cells.vref),
      tsv:        parseNum(cells.tsv),
      ta:         parseNum(cells.ta),
      tpsVolNuit: parseNum(cells.tpsVolNuit),
    });
  }
  if (out.length === 0) warnings.push('Page 1 (Horaire) : aucune ligne data détectée');
  return out;
}

/** Position y du dernier libellé de header (= démarcation entre titres
 *  et data). Heuristique : on cherche le mot "Tps" ou "Prog" en haut de
 *  page (≤ 150) et on prend le y max. */
function yLastHeader(page: PdfPage): number {
  const hdrs = page.items.filter(
    it => it.y < 150 && ['Tps', 'Prog', 'Esc.', 'Vol Nuit'].includes(it.str.trim()),
  );
  if (hdrs.length === 0) return 150;
  return Math.max(...hdrs.map(h => h.y));
}

function parseActiviteTable(
  page: PdfPage, regularFont: string, warnings: string[],
): { rows: Ep4ActiviteRow[]; totaux: Ep4ActiviteTotaux; summary: Ep4ActiviteSummary } {
  const yHeader = yLastHeader(page);
  // La data s'arrête au mot "1er mai/Noël" (= début de la section summary).
  const ends = page.items.filter(it => it.str.trim() === '1er mai/Noël');
  const yEnd = ends.length > 0 ? Math.min(...ends.map(e => e.y)) : page.height;

  const dataItems = page.items.filter(it => it.y > yHeader + 5 && it.y < yEnd);
  const rowsRaw   = groupByY(dataItems);

  const rows: Ep4ActiviteRow[] = [];
  let idx = 0;
  let totaux: Ep4ActiviteTotaux = {
    h2hc: null, h2hcR: null, montantHcR: null,
    majoNuit: null, montantNuit: null, majo10: null, primeCdb: null,
  };
  for (const rowItems of rowsRaw) {
    const cells = assignToColumns(rowItems, COLS_ACTIVITE);
    // Détection de la ligne "Total" finale (en bas, sous "1er mai/Noël" si présent — ici on a yEnd qui coupe avant).
    // La ligne Total écrit "Total" en colonne date/numVol. On la repère.
    const isTotal = /^Total$/i.test(cells.date) || /^Total$/i.test(cells.numVol);
    if (isTotal) {
      totaux = {
        h2hc:        parseNum(cells.h2hc),
        h2hcR:       parseNum(cells.h2hcR),
        montantHcR:  parseNum(cells.montantHcR),
        majoNuit:    parseNum(cells.majoNuit),
        montantNuit: parseNum(cells.montantNuit),
        majo10:      parseNum(cells.majo10),
        primeCdb:    parseNum(cells.primeCdb),
      };
      continue;
    }

    // Vraie ligne data : Date (DD/MM/YY) + identifiant alphanumérique (numéro
    // de vol ou code activité sol type "SST", "SOL", "MED", "ANN"...). On
    // accepte aussi date présente sans identifiant si une horaire est lisible
    // (vols annulés sans num qui gardent date + horaires).
    const hasDate  = /^\d{1,2}\/\d{1,2}\/\d{1,2}$/.test(cells.date);
    const hasIdent = /^[A-Za-z0-9]{2,5}$/.test(cells.numVol);
    const looksLikeRow = hasDate && (hasIdent || cells.depart.length === 3);
    if (!looksLikeRow) continue;

    const italic = isRowItalic(rowItems, regularFont);
    const hasXXX = cells.depart === 'XXX' || cells.arrivee === 'XXX';
    // Présence d'une escale "XXX" → toujours un prorata (ligne L2 ou L3 d'un
    // vol à cheval, cf. cf1). L'italique seule (sans XXX) marque la ligne L1
    // "info totale" du vol entier. Sinon ligne classique.
    const kind: RowKind =
      hasXXX ? 'spillover_prorata' :
      italic ? 'spillover_info'    :
      'normal';

    rows.push({
      index: idx++,
      kind,
      date:        cells.date    || null,
      numVol:      cells.numVol  || null,
      typeAvion:   cells.typeAvion || null,
      sab:         cells.sab     || null,
      depart:      cells.depart  || null,
      arrivee:     cells.arrivee || null,
      hvReal:      parseNum(cells.hvReal),
      tme:         parseNum(cells.tme),
      cmt:         parseNum(cells.cmt),
      hv100:       parseNum(cells.hv100),
      hcv:         parseNum(cells.hcv),
      hct:         parseNum(cells.hct),
      hca:         parseNum(cells.hca),
      h1:          parseNum(cells.h1),
      h2hc:        parseNum(cells.h2hc),
      hv100r:      parseNum(cells.hv100r),
      hcvr:        parseNum(cells.hcvr),
      h1r:         parseNum(cells.h1r),
      h2hcR:       parseNum(cells.h2hcR),
      montantHcR:  parseNum(cells.montantHcR),
      majoNuit:    parseNum(cells.majoNuit),
      montantNuit: parseNum(cells.montantNuit),
      majo10:      parseNum(cells.majo10),
      primeCdb:    parseNum(cells.primeCdb),
    });
  }

  const summary = parseActiviteSummary(page, warnings);
  // Si la ligne Total n'a pas été captée dans la zone data (car en-dessous du
  // bloc "1er mai/Noël"), on tente une seconde passe sur la zone bas.
  const yRecapMin = ends.length > 0 ? Math.min(...ends.map(e => e.y)) : page.height;
  if (totaux.h2hc === null) {
    const totalRow = findTotalRowBelow(page, yRecapMin);
    if (totalRow) totaux = { ...totaux, ...parseRecapBucket(totalRow) };
  }
  // Mini-tableau Vol/Sol/Total en bas-droite : ventile les totaux entre
  // activités de vol et sol. Le label "Vol" / "Sol" est à x≈427, hors des
  // COLS_ACTIVITE classiques → parsing dédié. Absent dans les mois sans
  // activité sol (AF ne rend pas la ligne).
  const volRow = findRecapRow(page, yRecapMin, 'Vol');
  const solRow = findRecapRow(page, yRecapMin, 'Sol');
  if (volRow) totaux.vol = parseRecapBucket(volRow);
  if (solRow) totaux.sol = parseRecapBucket(solRow);

  if (rows.length === 0) warnings.push('Page 2 (Activité) : aucune ligne data détectée');
  return { rows, totaux, summary };
}

function findTotalRowBelow(page: PdfPage, yMin: number): PdfItem[] | null {
  const candidates = page.items.filter(it => it.y > yMin && it.str.trim() === 'Total');
  if (candidates.length === 0) return null;
  const y = candidates[0].y;
  return page.items.filter(it => Math.abs(it.y - y) < 1.5).sort((a, b) => a.x - b.x);
}

/** Cherche une row dont une cellule contient exactement `label` au-dessus de
 *  yMin. Sert au mini-tableau Vol/Sol/Total en bas-droite de la page Décompte
 *  (le label est à x=420-440, hors COLS_ACTIVITE classiques). */
function findRecapRow(page: PdfPage, yMin: number, label: 'Vol' | 'Sol'): PdfItem[] | null {
  const candidates = page.items.filter(it =>
    it.y > yMin && it.x > 415 && it.x < 450 && it.str.trim() === label,
  );
  if (candidates.length === 0) return null;
  const y = candidates[0].y;
  return page.items.filter(it => Math.abs(it.y - y) < 1.5).sort((a, b) => a.x - b.x);
}

function parseRecapBucket(rowItems: PdfItem[]): Omit<Ep4ActiviteTotaux, 'vol' | 'sol'> {
  const cells = assignToColumns(rowItems, COLS_ACTIVITE_TOTAL);
  return {
    h2hc:        parseNum(cells.h2hc),
    h2hcR:       parseNum(cells.h2hcR),
    montantHcR:  parseNum(cells.montantHcR),
    majoNuit:    parseNum(cells.majoNuit),
    montantNuit: parseNum(cells.montantNuit),
    majo10:      parseNum(cells.majo10),
    primeCdb:    parseNum(cells.primeCdb),
  };
}

// Colonnes spécifiques à la row "Total" du bas de page 2. Cette row n'a que
// 7 colonnes (vs 24 pour une row vol) et les x sont décalés vers la gauche.
const COLS_ACTIVITE_TOTAL: Col[] = [
  { key: 'h2hc',        xMin: 460, xMax: 510 },  // 478
  { key: 'h2hcR',       xMin: 510, xMax: 555 },  // 523
  { key: 'montantHcR',  xMin: 555, xMax: 620 },  // 563
  { key: 'majoNuit',    xMin: 620, xMax: 660 },  // 623
  { key: 'montantNuit', xMin: 660, xMax: 720 },  // 667
  { key: 'majo10',      xMin: 720, xMax: 765 },  // 738
  { key: 'primeCdb',    xMin: 765, xMax: 830 },  // 793
];

function parseActiviteSummary(page: PdfPage, _warnings: string[]): Ep4ActiviteSummary {
  // Le bas de page est multi-colonnes (HS / PVEI / Totaux). Pour chaque libellé,
  // on cherche la 1ère valeur numérique IMMÉDIATEMENT à droite — pas la 1ère
  // de la row globale (qui pourrait appartenir à un libellé voisin).
  const out: Ep4ActiviteSummary = {
    hsFixe: { unit: null, total: null, majoNuit: null },
    hsVol:  { unit: null, total: null, majoNuit: null },
    hsCac:  null, ksp: null, pvei1: null, pvei2: null,
    calculHs: null, totHcrPlusNuit: null, nb30e: null, seuilHs: null,
  };

  const bottom = page.items.filter(it => it.y > 450).sort((a, b) => a.y - b.y || a.x - b.x);
  const rowsRaw = groupByY(bottom, 2);

  function findLabel(label: string): { row: PdfItem[]; lab: PdfItem } | null {
    for (const r of rowsRaw) {
      const lab = r.find(it => it.str.trim() === label);
      if (lab) return { row: r, lab };
    }
    return null;
  }

  /** Récupère les N premières valeurs numériques à droite du label (x > label.x). */
  function rightOf(label: string, n = 1): (number | null)[] {
    const f = findLabel(label);
    if (!f) return Array(n).fill(null);
    const after = f.row
      .filter(it => it.x > f.lab.x + f.lab.w - 1 && /^[\d,.-]+$/.test(it.str.trim()))
      .sort((a, b) => a.x - b.x);
    const out: (number | null)[] = [];
    for (let i = 0; i < n; i++) out.push(parseNum(after[i]?.str ?? null));
    return out;
  }

  const [hsFixeUnit, hsFixeTotal, hsFixeMajo] = rightOf('HS. Fixe', 3);
  out.hsFixe = { unit: hsFixeUnit, total: hsFixeTotal, majoNuit: hsFixeMajo };
  const [hsVolUnit, hsVolTotal, hsVolMajo] = rightOf('HS. Vol', 3);
  out.hsVol = { unit: hsVolUnit, total: hsVolTotal, majoNuit: hsVolMajo };
  out.hsCac = rightOf('HS CAC', 1)[0];
  out.ksp = rightOf('K.S.P', 1)[0];
  out.pvei1 = rightOf('1ère pér', 1)[0];
  out.pvei2 = rightOf('2ème pér', 1)[0];
  out.calculHs = rightOf('Calcul HS', 1)[0];
  out.totHcrPlusNuit = rightOf('Tot HC(r)+Nuit', 1)[0];
  out.nb30e   = rightOf('Nb 30ème', 1)[0];
  out.seuilHs = rightOf('Seuil HS', 1)[0];
  return out;
}

function parseFraisTable(
  page: PdfPage, regularFont: string, warnings: string[],
): { rows: Ep4FraisRow[]; totaux: Ep4FraisTotaux } {
  const yHeader = yLastHeader(page);
  const ends = page.items.filter(it => it.str.trim() === 'Totaux');
  const yEnd = ends.length > 0 ? Math.max(...ends.map(e => e.y)) + 5 : page.height;

  const dataItems = page.items.filter(it => it.y > yHeader + 5 && it.y < yEnd);
  const rowsRaw = groupByY(dataItems);

  const rows: Ep4FraisRow[] = [];
  let idx = 0;
  let totaux: Ep4FraisTotaux = {
    irDep: null, mfDep: null, decArr: null, irArr: null, mfArr: null,
    totalIndem: null, mtDec: null, pnExonere: null, pnNonExonere: null,
  };

  for (const rowItems of rowsRaw) {
    const cells = assignToColumns(rowItems, COLS_FRAIS);
    // Ligne "Totaux"
    if (/^Totaux$/i.test(cells.numLigne)) {
      totaux = {
        irDep:        parseNum(cells.irDep),
        mfDep:        parseNum(cells.mfDep),
        decArr:       parseNum(cells.decArr),
        irArr:        parseNum(cells.irArr),
        mfArr:        parseNum(cells.mfArr),
        totalIndem:   parseNum(cells.totalIndem),
        mtDec:        parseNum(cells.mtDec),
        pnExonere:    parseNum(cells.pnExonere),
        pnNonExonere: parseNum(cells.pnNonExonere),
      };
      continue;
    }
    // Vraie ligne data : Esc. dep IATA + identifiant alphanumérique (numéro
    // de vol ou code activité sol). Fallback : si numLigne vide, on accepte
    // si une horaire valide est présente.
    const hasIdent = /^[A-Za-z0-9]{2,5}$/.test(cells.numLigne);
    const hasEscDep = cells.escDep.length === 3;
    const hasHoraire = parseHoraire(cells.horaireDep) != null
                    || parseHoraire(cells.horaireArr) != null;
    const looksLikeRow = hasEscDep && (hasIdent || hasHoraire);
    if (!looksLikeRow) continue;

    const italic = isRowItalic(rowItems, regularFont);
    const hasXXX = cells.escDep === 'XXX' || cells.escArr === 'XXX';
    // Présence d'une escale "XXX" → toujours un prorata (ligne L2 ou L3 d'un
    // vol à cheval, cf. cf1). L'italique seule (sans XXX) marque la ligne L1
    // "info totale" du vol entier. Sinon ligne classique.
    const kind: RowKind =
      hasXXX ? 'spillover_prorata' :
      italic ? 'spillover_info'    :
      'normal';

    rows.push({
      index: idx++,
      kind,
      numLigne:      cells.numLigne || null,
      sab:           cells.sab      || null,
      escDep:        cells.escDep   || null,
      horaireDep:    parseHoraire(cells.horaireDep),
      decDep:        parseNum(cells.decDep),
      pdejDep:       parseNum(cells.pdejDep),
      irDep:         parseNum(cells.irDep),
      mfDep:         parseNum(cells.mfDep),
      escArr:        cells.escArr   || null,
      horaireArr:    parseHoraire(cells.horaireArr),
      decArr:        parseNum(cells.decArr),
      pdejArr:       parseNum(cells.pdejArr),
      irArr:         parseNum(cells.irArr),
      mfArr:         parseNum(cells.mfArr),
      totalIndem:    parseNum(cells.totalIndem),
      typeTransport: cells.typeTransport || null,
      km:            parseNum(cells.km),
      mtDec:         parseNum(cells.mtDec),
      pnExonere:     parseNum(cells.pnExonere),
      pnNonExonere:  parseNum(cells.pnNonExonere),
    });
  }

  if (rows.length === 0) warnings.push('Page 4 (Frais) : aucune ligne data détectée');
  return { rows, totaux };
}

// ────────────────────────────────────────────────────────────────────────────
// Orchestrateur
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse un EP4 à partir des items déjà extraits par pdfjs (cf.
 * ep4-pdf-extract.ts). Retourne une structure typée + warnings non bloquants.
 * Lève un `Ep4FormatError` si la structure attendue (titres de pages) n'est
 * pas reconnue.
 */
export function parseEp4PdfItems(pages: PdfPage[]): Ep4PdfData {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Ep4FormatError('PDF vide ou non extrait.');
  }

  const pHoraire  = findPageByTitle(pages, TITLE_HORAIRE);
  const pActivite = findPageByTitle(pages, TITLE_ACTIVITE);
  const pFrais    = findPageByTitle(pages, TITLE_FRAIS);

  const warnings: string[] = [];
  const meta = parseMeta(pHoraire); // identique sur les 3 pages

  const regularHor = detectRegularFont(pHoraire.items);
  const regularAct = detectRegularFont(pActivite.items);
  const regularFra = detectRegularFont(pFrais.items);

  const horaireRows = parseHoraireTable(pHoraire, regularHor, warnings);
  const activite    = parseActiviteTable(pActivite, regularAct, warnings);
  const frais       = parseFraisTable(pFrais, regularFra, warnings);

  return {
    meta,
    horaire:  { rows: horaireRows },
    activite,
    frais,
    warnings,
  };
}
