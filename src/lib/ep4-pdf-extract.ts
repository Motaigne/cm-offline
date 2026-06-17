// Couche d'extraction pdfjs → items texte+position. Utilisée côté browser
// (page /ep4) pour transformer un File uploadé par l'utilisateur en
// `PdfPage[]` que le parser pur (ep4-pdf-parse.ts) sait consommer.
//
// Choix techniques :
// - Legacy build (`pdfjs-dist/legacy/build/pdf.mjs`) : zero-config côté
//   browser, pas besoin de servir un worker JS séparé. Plus lourd (~2 Mo)
//   mais cohérent avec l'esprit offline-first du projet (1 seul chunk,
//   précachable par le SW comme le reste de l'app).
// - Dynamic import : pdfjs n'est chargé qu'à la première extraction —
//   évite de bundler le module dans les pages qui ne l'utilisent pas.
// - Aucun setup worker : on désactive explicitement le worker (disableWorker
//   n'existe plus en v6, mais le legacy build fonctionne sans).

import { parseEp4PdfItems, type Ep4PdfData, type PdfItem, type PdfPage } from './ep4-pdf-parse';

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfjsModule> | null = null;

function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsPromise;
}

function round(n: number): number { return Math.round(n * 100) / 100; }

interface PdfTextItem {
  str:       string;
  transform: number[];
  width:     number;
  height:    number;
  fontName:  string;
}

function isTextItem(it: unknown): it is PdfTextItem {
  return typeof it === 'object' && it !== null && 'str' in it && 'transform' in it;
}

/**
 * Extrait les items texte+positions d'un PDF (côté browser). Le buffer peut
 * venir d'un `File.arrayBuffer()` (drag-and-drop / input file). Retourne un
 * tableau de pages compatible avec `parseEp4PdfItems`.
 */
export async function extractPdfPages(data: ArrayBuffer | Uint8Array): Promise<PdfPage[]> {
  const pdfjs = await loadPdfjs();
  // pdfjs v6 rejette explicitement Node's Buffer (qui hérite pourtant de
  // Uint8Array) — on force la création d'un Uint8Array propre.
  const buffer = data instanceof Uint8Array
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);

  const doc = await pdfjs.getDocument({
    data: buffer,
    // Pas de DOM côté worker / node : pas de fontFace, pas de polices system.
    // On veut seulement le texte + positions, pas le rendering.
    disableFontFace: true,
    useSystemFonts:  false,
    // VerbosityLevel.ERRORS — sans ça pdfjs hurle des warnings sur stdout
    // ("standardFontDataUrl missing") inutiles pour le seul use case extraction.
    verbosity:       0,
  }).promise;

  const pages: PdfPage[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page     = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const tc       = await page.getTextContent({ includeMarkedContent: false });

    const items: PdfItem[] = [];
    for (const it of tc.items) {
      if (!isTextItem(it)) continue;
      if (it.str === '') continue;
      // convertToViewportPoint : (x, y) PDF (origin bottom-left) → viewport
      // (origin top-left). Tient compte de la rotation native de la page.
      const [vx, vy] = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
      items.push({
        x:        round(vx),
        y:        round(vy),
        w:        round(it.width),
        h:        round(it.height),
        fontName: it.fontName,
        str:      it.str,
      });
    }

    pages.push({
      page:   pageNum,
      width:  round(viewport.width),
      height: round(viewport.height),
      items,
    });
  }

  return pages;
}

/**
 * Orchestre extraction pdfjs + parsing typé. Façade unique pour l'UI :
 *   const data = await parseEp4PdfFile(await file.arrayBuffer());
 * Lève `Ep4FormatError` (depuis le parser) si le PDF n'est pas un EP4 reconnu.
 */
export async function parseEp4PdfFile(data: ArrayBuffer | Uint8Array): Promise<Ep4PdfData> {
  const pages = await extractPdfPages(data);
  return parseEp4PdfItems(pages);
}

// Re-export du type d'erreur du parser pour que les consumers n'aient pas
// besoin de l'importer séparément.
export { Ep4FormatError } from './ep4-pdf-parse';
export type { Ep4PdfData } from './ep4-pdf-parse';
