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
import { getPlanPrestation } from '@/lib/plan-prestation';

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
  fraisKeys:    Set<string>;
}

/** Fraction PN Exonéré / PN Non Exonéré du Total Indem (règle AF : 70 / 30). */
const PN_EXO_FRACTION = 0.7;

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

  // Index PDF Frais. On garde aussi les rows spillover_prorata (vols à cheval
  // dont le PDF garde la trace côté Frais, ex: ligne XXX→NBJ) — la logique
  // d'inclusion est alignée sur le calendrier qui affiche aussi les spillovers.
  const pdfFrais = new Map<string, {
    decDep: number | null; irDep: number | null; mfDep: number | null;
    irArr: number | null;  mfArr: number | null;
    totalIndem: number | null; pnExonere: number | null;
  }>();
  for (const r of pdfData.frais.rows) {
    if (r.kind === 'spillover_info') continue; // ligne "vol entier informative" → pas matchable
    const day = r.horaireDep?.day ?? r.horaireArr?.day ?? null;
    pdfFrais.set(diffKey(r.numLigne, day), {
      decDep:     r.decDep,
      irDep:      r.irDep,
      mfDep:      r.mfDep,
      irArr:      r.irArr,
      mfArr:      r.mfArr,
      totalIndem: r.totalIndem,
      pnExonere:  r.pnExonere,
    });
  }

  const horaireKeys  = new Set<string>();
  const decompteKeys = new Set<string>();
  const fraisKeys    = new Set<string>();

  for (const { ep4, is_spillover } of flights) {
    // Horaire / Décompte : ignore les rotations à cheval (le PDF les sépare en
    // info + prorata, pas matchable 1-1 par leg). Frais : on inclut (cf. user).
    if (!is_spillover) {
      for (const svc of ep4.services) {
        for (const leg of svc.legs) {
          const k = diffKey(leg.flightNumber, dayUtc(leg.begin_ms));

          // Horaire : Tps Vol (calc tdv_troncon) ≈ Prog vol (PDF) ;
          //           TSV nuit (svc.tsv_nuit) ≈ Tps Vol Nuit (PDF)
          const ph = pdfHoraire.get(k);
          if (ph) {
            if (!near(leg.tdv_troncon, ph.progVol)) horaireKeys.add(k);
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

    // Frais : 1 row par service côté calc, mais les valeurs IR/MF/Indem sont
    // assignées uniquement au 1er service de la rotation → on ne compare qu'à
    // ce niveau. Le matching se fait via la clé du premier leg du 1er service.
    const firstSvc = ep4.services[0];
    const firstLeg = firstSvc?.legs[0];
    if (firstSvc && firstLeg) {
      const k = diffKey(firstLeg.flightNumber, dayUtc(firstLeg.begin_ms));
      const pf = pdfFrais.get(k);
      if (pf) {
        // Règles côté calc (alignées sur Ep4FraisEP4Consolidee.tsx) :
        //   - spillover (retour)   → IR/MF côté DÉPART
        //   - normal aller         → IR/MF côté ARRIVÉE
        const irDep = is_spillover ? ep4.IR : 0;
        const mfDep = is_spillover ? ep4.MF : 0;
        const irArr = is_spillover ? 0 : ep4.IR;
        const mfArr = is_spillover ? 0 : ep4.MF;
        const totalIndem = ep4.IR_eur + ep4.MF_eur;
        const pnExonere  = totalIndem * PN_EXO_FRACTION;
        const meal = getPlanPrestation(firstLeg.flightNumber, firstLeg.dep);
        const decDep = meal ? (meal.dej ? 1 : 0) + (meal.din ? 1 : 0) : 0;

        const anyDiff =
          !near(irDep,      pf.irDep)      ||
          !near(mfDep,      pf.mfDep)      ||
          !near(irArr,      pf.irArr)      ||
          !near(mfArr,      pf.mfArr)      ||
          !near(totalIndem, pf.totalIndem) ||
          !near(pnExonere,  pf.pnExonere)  ||
          !near(decDep,     pf.decDep);
        if (anyDiff) fraisKeys.add(k);
      }
    }
  }

  return { horaireKeys, decompteKeys, fraisKeys };
}
