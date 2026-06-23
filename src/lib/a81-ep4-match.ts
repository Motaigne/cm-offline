/**
 * EP4 PDF = source unique pour les mois où un PDF est importé.
 *
 * Pour ces mois, on EXTRAIT les rotations directement des rows EP4 (au lieu
 * de les chercher dans le calendrier). On ignore complètement les items du
 * calendrier de ce mois — l'EP4 fait foi.
 *
 * Algo : on détecte la base AF du pilote (escale la plus fréquente en escDep
 * + escArr) puis on groupe les rows `kind='normal'` en rotations (= séquences
 * entre 2 retours à la base). Pour chaque rotation :
 *   - debut_rotation     = date du reelDep du 1er row
 *   - debut_sejour_at    = reelArr du 1er row - 5 min   (1er block ON, cf optiP_DEF.md)
 *   - escale_debut       = escArr du 1er row
 *   - fin_sejour_at      = reelDep du dernier row + 10 min (dernier block OFF)
 *   - escale_fin         = escDep du dernier row
 *
 * Pour la zone Article 81 (absente du PDF), on s'appuie sur un lookup
 * `escale → zone` extrait des signatures déjà cachées en Dexie. Si zone
 * introuvable, la rotation s'affiche avec zone=null/taux=null/montant=0.
 */

import type { Ep4HoraireRow, Ep4PdfData, HoraireJJHHMM } from '@/lib/ep4-pdf-parse';

const DEBUT_OFFSET_MS = -5  * 60 * 1000;
const FIN_OFFSET_MS   = +10 * 60 * 1000;

/** Recompose un timestamp UTC ms à partir d'un (monthIso, JJHHMM). */
function horaireToMs(monthIso: string, h: HoraireJJHHMM): number {
  const [y, m] = monthIso.split('-').map(Number);
  const minutes = Math.round(h.decimal * 60);
  const safeMin = Math.min(59, Math.max(0, minutes));
  const hour = h.hour === 24 ? 0 : h.hour;
  const dayShift = h.hour === 24 ? 1 : 0;
  return Date.UTC(y, m - 1, h.day + dayShift, hour, safeMin);
}

function usableRows(ep4: Ep4PdfData): Ep4HoraireRow[] {
  return ep4.horaire.rows.filter(r =>
    r.kind === 'normal' &&
    !!r.escDep && !!r.escArr &&
    !!r.reelDep && !!r.reelArr,
  );
}

/** Détecte la base AF du pilote = escale la plus fréquente (escDep ∪ escArr). */
export function detectBaseFromEp4(ep4: Ep4PdfData): string | null {
  const counts = new Map<string, number>();
  for (const r of usableRows(ep4)) {
    counts.set(r.escDep!, (counts.get(r.escDep!) ?? 0) + 1);
    counts.set(r.escArr!, (counts.get(r.escArr!) ?? 0) + 1);
  }
  let best: { code: string; n: number } | null = null;
  for (const [code, n] of counts) {
    if (!best || n > best.n) best = { code, n };
  }
  return best?.code ?? null;
}

export interface Ep4Rotation {
  debut_rotation:   string;    // 'YYYY-MM-DD' (date du 1er reelDep)
  debut_sejour_at:  string;    // ISO UTC, -5 min appliqué
  fin_sejour_at:    string;    // ISO UTC, +10 min appliqué
  escale_debut:     string;
  escale_fin:       string;
}

/** Extrait les rotations contenues dans un EP4 PDF (un mois). Une rotation
 *  = séquence de vols entre 2 retours à la base (escDep base → ... → escArr base).
 *  Les rotations qui ne se ferment pas à la base (rotation à cheval avec le
 *  mois suivant) sont retournées avec ce qu'on a — le caller peut décider de
 *  les jeter ou les conserver. */
export function extractRotationsFromEp4(ep4: Ep4PdfData): Ep4Rotation[] {
  const base = detectBaseFromEp4(ep4);
  if (!base || !ep4.meta.monthIso) return [];
  const monthIso = ep4.meta.monthIso;
  const rows = usableRows(ep4);

  const out: Ep4Rotation[] = [];
  let bucket: Ep4HoraireRow[] = [];
  let state: 'idle' | 'in_rotation' = 'idle';

  for (const r of rows) {
    if (state === 'idle') {
      if (r.escDep === base) {
        state = 'in_rotation';
        bucket = [r];
      }
      // sinon : row orpheline (ex spillover non-normal mais kind=normal),
      // on l'ignore — pas de borne sûre.
    } else {
      bucket.push(r);
      if (r.escArr === base) {
        const debutRow = bucket[0];
        const finRow   = bucket[bucket.length - 1];
        const debutMs = horaireToMs(monthIso, debutRow.reelArr!);
        const finMs   = horaireToMs(monthIso, finRow.reelDep!);
        if (finMs > debutMs) {
          // Date du 1er block-off (reelDep du tout premier row de la rotation)
          const depMs = horaireToMs(monthIso, debutRow.reelDep!);
          out.push({
            debut_rotation:  new Date(depMs).toISOString().slice(0, 10),
            debut_sejour_at: new Date(debutMs + DEBUT_OFFSET_MS).toISOString(),
            fin_sejour_at:   new Date(finMs   + FIN_OFFSET_MS).toISOString(),
            escale_debut:    debutRow.escArr!,
            escale_fin:      finRow.escDep!,
          });
        }
        state = 'idle';
        bucket = [];
      }
    }
  }

  return out;
}
