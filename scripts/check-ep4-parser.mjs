#!/usr/bin/env node
// Vérifie la sortie de src/lib/ep4-pdf-parse.ts.
//
// Deux modes :
//   - Par défaut (dump JSON) : npx tsx scripts/check-ep4-parser.mjs [dump.json]
//   - Via PDF direct (exerce aussi ep4-pdf-extract.ts qui utilise pdfjs) :
//     npx tsx scripts/check-ep4-parser.mjs --pdf <file.pdf>

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEp4PdfItems } from '../src/lib/ep4-pdf-parse.ts';
import { parseEp4PdfFile } from '../src/lib/ep4-pdf-extract.ts';

async function main() {
  const args = process.argv.slice(2);
  const pdfMode = args.includes('--pdf');

  let result;
  if (pdfMode) {
    const pdfArg = args[args.indexOf('--pdf') + 1] ?? 'sources/sourcesEP4/AF_Activité_202601.pdf';
    const pdfPath = path.isAbsolute(pdfArg) ? pdfArg : path.resolve(process.cwd(), pdfArg);
    const buffer = await readFile(pdfPath);
    result = await parseEp4PdfFile(buffer);
  } else {
    const dumpArg = args[0] ?? 'sources/sourcesEP4/dump.json';
    const dumpPath = path.isAbsolute(dumpArg) ? dumpArg : path.resolve(process.cwd(), dumpArg);
    const raw = await readFile(dumpPath, 'utf-8');
    const pages = JSON.parse(raw);
    result = parseEp4PdfItems(pages);
  }

  // Affichage compact pour validation visuelle.
  console.log('═══ META ═══');
  console.log(JSON.stringify(result.meta, null, 2));

  console.log(`\n═══ HORAIRE — ${result.horaire.rows.length} rows ═══`);
  for (const r of result.horaire.rows) {
    console.log(
      `  [${r.index}] ${r.kind.padEnd(18)} ${r.numLigne}  ${r.escDep}→${r.escArr}  ` +
      `réel ${r.reelDep?.raw ?? '----'} → ${r.reelArr?.raw ?? '----'}  ` +
      `vol=${r.reelVol}  tsv=${r.tsv}  ta=${r.ta}  vN=${r.tpsVolNuit}`,
    );
  }

  console.log(`\n═══ ACTIVITÉ — ${result.activite.rows.length} rows ═══`);
  for (const r of result.activite.rows) {
    console.log(
      `  [${r.index}] ${r.kind.padEnd(18)} ${r.date}  ${r.numVol}  ${r.depart}→${r.arrivee}  ` +
      `HV=${r.hvReal}  HCV(r)=${r.hcvr}  Montant=${r.montantHcR}  Nuit=${r.montantNuit}`,
    );
  }
  console.log('  TOTAUX:', JSON.stringify(result.activite.totaux));
  console.log('  SUMMARY:', JSON.stringify(result.activite.summary, null, 2));

  console.log(`\n═══ FRAIS — ${result.frais.rows.length} rows ═══`);
  for (const r of result.frais.rows) {
    console.log(
      `  [${r.index}] ${r.kind.padEnd(18)} ${r.numLigne}  ${r.escDep}→${r.escArr}  ` +
      `horaireDep=${r.horaireDep?.raw ?? '----'} → ${r.horaireArr?.raw ?? '----'}  ` +
      `IRdep=${r.irDep} MFdep=${r.mfDep} IRarr=${r.irArr} MFarr=${r.mfArr}  ` +
      `Tot=${r.totalIndem}  PNexo=${r.pnExonere}  PNnonExo=${r.pnNonExonere}`,
    );
  }
  console.log('  TOTAUX:', JSON.stringify(result.frais.totaux));

  if (result.warnings.length) {
    console.log('\n═══ WARNINGS ═══');
    result.warnings.forEach(w => console.log('  ⚠', w));
  } else {
    console.log('\n(aucun warning)');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
