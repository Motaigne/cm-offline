#!/usr/bin/env node
// Dump le texte d'un PDF EP4 (Air France) avec positions x/y + fontName, pour
// préparer la couche de parsing. Usage :
//   node scripts/dump-ep4.mjs sources/sourcesEP4/AF_Activite_202601.pdf [--json]
//
// Sortie par défaut : un tableau lisible par page (page, item index, x, y,
// fontName, str). Avec --json : JSON brut prêt à reparser.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// pdfjs exige une URL avec slash final. On évite les pièges Windows
// (back-slashes) en passant par pathToFileURL.
const STANDARD_FONTS_URL = pathToFileURL(
  path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'standard_fonts') + path.sep,
).href;

async function main() {
  const args = process.argv.slice(2);
  const pdfArg = args.find(a => !a.startsWith('--'));
  const jsonMode = args.includes('--json');

  if (!pdfArg) {
    console.error('usage: node scripts/dump-ep4.mjs <pdf-path> [--json]');
    process.exit(1);
  }

  const pdfPath = path.isAbsolute(pdfArg) ? pdfArg : path.resolve(process.cwd(), pdfArg);
  const data = new Uint8Array(await readFile(pdfPath));

  // disableFontFace + standardFontDataUrl : pdfjs en Node n'a pas de DOM, on
  // évite les warnings de chargement de polices. On garde seulement les noms
  // de polices (utiles pour distinguer italique / normal).
  const doc = await getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: STANDARD_FONTS_URL,
  }).promise;

  const out = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent({ includeMarkedContent: false });

    // Récupère le mapping fontName → descripteur (italic, weight) via commonObjs.
    // PDF.js stocke les polices côté commonObjs après getTextContent.
    const fontMap = {};
    for (const it of tc.items) {
      if (!it.fontName || fontMap[it.fontName]) continue;
      try {
        // commonObjs.get est synchrone si l'objet est déjà résolu.
        const f = page.commonObjs.get(it.fontName);
        if (f) {
          fontMap[it.fontName] = {
            name:    f.name        ?? null,
            italic:  Boolean(f.italic) || /italic|oblique/i.test(f.name ?? ''),
            bold:    Boolean(f.bold)   || /bold/i.test(f.name ?? ''),
          };
        }
      } catch { /* font pas encore résolue — ignore, on garde au moins le tag */ }
    }

    const items = tc.items
      .filter(it => 'str' in it && it.str !== '')
      .map((it, idx) => {
        // Convertit (x, y) du système PDF (origin bottom-left) vers le
        // viewport (origin top-left). Tient compte de la rotation native de
        // la page (paysage / portrait).
        const [vx, vy] = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
        return {
          idx,
          x:        round(vx),
          y:        round(vy),
          w:        round(it.width),
          h:        round(it.height),
          fontName: it.fontName,
          font:     fontMap[it.fontName] ?? null,
          str:      it.str,
        };
      });

    out.push({
      page:        pageNum,
      width:       round(viewport.width),
      height:      round(viewport.height),
      items,
    });
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(out, null, 2));
    return;
  }

  // Format texte : une ligne par item, regroupé par page. Tri par y puis x
  // pour suivre l'ordre de lecture humain.
  for (const p of out) {
    console.log(`\n══════ PAGE ${p.page}  (${p.width} × ${p.height}) ══════`);
    const sorted = [...p.items].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    let lastY = -1;
    for (const it of sorted) {
      if (lastY >= 0 && Math.abs(it.y - lastY) > 1.5) console.log(''); // saut de ligne visuel
      const italic = it.font?.italic ? ' I' : '  ';
      const bold   = it.font?.bold   ? ' B' : '  ';
      const f      = it.fontName.padEnd(10);
      console.log(
        `  y=${pad(it.y, 6)}  x=${pad(it.x, 6)}  w=${pad(it.w, 5)}  ${f}${italic}${bold}  "${it.str}"`,
      );
      lastY = it.y;
    }
  }
}

function round(n) { return Math.round(n * 100) / 100; }
function pad(n, w) { return String(n).padStart(w, ' '); }

main().catch(e => { console.error(e); process.exit(1); });
