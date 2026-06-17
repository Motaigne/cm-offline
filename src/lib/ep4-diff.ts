// Calcule les rows divergentes entre l'EP4 calculé par l'app (à partir des
// rotations Dexie) et l'EP4 PDF importé (parsé). Permet aux onglets Feuille
// Horaire / Décompte de surligner les lignes où le programmé diverge des
// valeurs officielles AF — cf. demande user 2026-06-17 PM.
//
// Convention :
// - Matching par `numVol-normalisé | jour-UTC-du-départ`. Le numéro de vol PDF
//   ("0972") a un 0 leading qu'on enlève via `parseInt`. Le jour suffit comme
//   discriminant secondaire (un même numéro de vol 2× le même jour est très
//   rare dans un planning mensuel).
// - On compare uniquement les rows PDF `kind === 'normal'` : les lignes
//   spillover (info / prorata m-1 / m+1) ne sont pas matchables 1-1 avec le
//   calculé (qui ne sépare pas la portion d'un vol à cheval par mois).
// - Tolérance numérique 0.011 : les centièmes industriels (formats 9.42) ne
//   sont précis qu'à la minute → ±0.01 = ±0.6 minute, sous le bruit normal.

import type { Ep4Rotation } from '@/lib/ep4';
import type { Ep4PdfData } from '@/lib/ep4-pdf-parse';

type ConsoFlight = { ep4: Ep4Rotation; is_spillover: boolean };

const EPSILON = 0.011;

function near(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return true; // une des deux valeurs manque → on n'affirme pas une diff
  return Math.abs(a - b) < EPSILON;
}

export function diffKey(numVol: string | null | undefined, day: number | null | undefined): string {
  const n = parseInt(numVol ?? '0', 10) || 0;
  return `${n}|${day ?? 0}`;
}

function dayUtc(ms: number): number {
  return new Date(ms).getUTCDate();
}

export interface Ep4DiffResult {
  horaireKeys:  Set<string>;
  decompteKeys: Set<string>;
}

/** Pour chaque leg calculé, lookup la row PDF correspondante et compare les
 *  champs équivalents. Renvoie l'ensemble des `diffKey` divergents par onglet. */
export function computeEp4Diff(flights: ConsoFlight[], pdfData: Ep4PdfData): Ep4DiffResult {
  // Index PDF Horaire (par numLigne + day de l'arrivée si dispo, sinon départ).
  const pdfHoraire = new Map<string, { progVol: number | null; tpsVolNuit: number | null }>();
  for (const r of pdfData.horaire.rows) {
    if (r.kind !== 'normal') continue;
    // Pour les vols "normaux", reelArr/progArr existent ; on indexe sur le
    // jour de départ pour matcher le `begin_ms` du calculé.
    const day = r.reelDep?.day ?? r.progDep?.day ?? null;
    pdfHoraire.set(diffKey(r.numLigne, day), {
      progVol:    r.progVol,
      tpsVolNuit: r.tpsVolNuit,
    });
  }

  // Index PDF Décompte (date "JJ/MM/AA").
  const pdfDecompte = new Map<string, { hv100r: number | null; hcvr: number | null }>();
  for (const r of pdfData.activite.rows) {
    if (r.kind !== 'normal') continue;
    const dayStr = r.date?.split('/')[0];
    const day = dayStr ? parseInt(dayStr, 10) : null;
    pdfDecompte.set(diffKey(r.numVol, day), {
      hv100r: r.hv100r,
      hcvr:   r.hcvr,
    });
  }

  const horaireKeys  = new Set<string>();
  const decompteKeys = new Set<string>();

  for (const { ep4, is_spillover } of flights) {
    if (is_spillover) continue; // rotation à cheval = pas matchable 1-1 avec les rows PDF normales
    for (const svc of ep4.services) {
      for (const leg of svc.legs) {
        const k = diffKey(leg.flightNumber, dayUtc(leg.begin_ms));

        // Horaire : Tps Vol (calc tdv_troncon) ≈ Prog vol (PDF) ;
        //           TSV nuit (svc.tsv_nuit) ≈ Tps Vol Nuit (PDF)
        const ph = pdfHoraire.get(k);
        if (ph) {
          if (!near(leg.tdv_troncon, ph.progVol)) horaireKeys.add(k);
          // tsv_nuit côté calc est par service (somme des legs nuit) — on le
          // compare sur la clé du PREMIER leg du service pour éviter de
          // doublonner. Sinon plusieurs legs d'un même svc déclencheraient
          // tous le highlight pour la même valeur de TSV nuit.
          if (leg === svc.legs[0] && !near(svc.tsv_nuit, ph.tpsVolNuit)) horaireKeys.add(k);
        }

        // Décompte : HV100r (calc leg.hv100r) ≈ HV 100%(r) (PDF) ;
        //            HCVr (svc.HCVr, 1er leg du svc) ≈ HCV(r) (PDF)
        const pd = pdfDecompte.get(k);
        if (pd) {
          if (!near(leg.hv100r, pd.hv100r)) decompteKeys.add(k);
          if (leg === svc.legs[0] && !near(svc.HCVr, pd.hcvr)) decompteKeys.add(k);
        }
      }
    }
  }

  return { horaireKeys, decompteKeys };
}
