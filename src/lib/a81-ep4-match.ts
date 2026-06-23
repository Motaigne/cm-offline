/**
 * EP4 PDF = source unique pour les mois où un PDF est importé.
 *
 * Pour ces mois, on EXTRAIT les rotations directement des rows EP4 (au lieu
 * de les chercher dans le calendrier). On ignore complètement les items du
 * calendrier de ce mois — l'EP4 fait foi.
 *
 * Algo :
 *  1. Détection de la base AF (escale la plus fréquente parmi escDep ∪ escArr).
 *  2. Reconstruction des timestamps : `day` étant juste un chiffre 1-31 sans
 *     mois, on infère le mois en suivant l'ordre chrono et en détectant les
 *     sauts de jour négatifs (ex 31 → 1) = passage au mois suivant. Permet
 *     de traiter correctement les rotations à cheval (rotation partie le 31
 *     déc, retour le 4 jan, présente dans le PDF décembre en kind='normal'
 *     avec des rows aux jours 31, 1, 3, 4).
 *  3. Groupement par "rotation" = séquence entre 2 retours-base (escDep=base
 *     pour ouvrir, escArr=base pour fermer).
 *  4. Pour chaque rotation, on construit :
 *     - debut_rotation     = date du reelDep du 1er row (1er block off)
 *     - debut_sejour_at    = reelArr du 1er row - 5 min (1er block ON)
 *     - escale_debut       = escArr du 1er row
 *     - fin_sejour_at      = reelDep du dernier row + 10 min (dernier block OFF)
 *     - escale_fin         = escDep du dernier row
 *     - rotation_code      = escales visitées hors-base, séparées par un
 *                            espace (ex "BZV PNR", "LAX PPT LAX")
 *
 * Offsets canoniques : cf optiP_DEF.md § ARTICLE81.
 */

import type { Ep4HoraireRow, Ep4PdfData, HoraireJJHHMM } from '@/lib/ep4-pdf-parse';

const DEBUT_OFFSET_MS = -5  * 60 * 1000;
const FIN_OFFSET_MS   = +10 * 60 * 1000;
const DAY_JUMP_THRESHOLD = 15;  // saut > 15 jours = changement de mois

/** Recompose un timestamp UTC ms avec un offset en mois par rapport au
 *  meta.monthIso du PDF. */
function horaireToMs(monthIso: string, monthOffset: number, h: HoraireJJHHMM): number {
  const [y, m] = monthIso.split('-').map(Number);
  const minutes = Math.round(h.decimal * 60);
  const safeMin = Math.min(59, Math.max(0, minutes));
  const hour = h.hour === 24 ? 0 : h.hour;
  const dayShift = h.hour === 24 ? 1 : 0;
  return Date.UTC(y, m - 1 + monthOffset, h.day + dayShift, hour, safeMin);
}

function usableRows(ep4: Ep4PdfData): Ep4HoraireRow[] {
  // On inclut TOUS les kinds (normal + spillover_info + spillover_prorata).
  // Les rows italique servent à reconstituer les rotations à cheval rattachées
  // à un autre mois — sans elles, NBJ 31 déc-4 jan n'apparaît jamais si l'user
  // n'a que le PDF janvier. La dédup côté caller gère le cas où on a aussi le
  // PDF de l'autre mois (= la même rotation en kind='normal').
  return ep4.horaire.rows.filter(r =>
    !!r.escDep && !!r.escArr &&
    !!r.reelDep && !!r.reelArr,
  );
}

/** Détecte la base AF du pilote = escale la plus fréquente. */
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

/** Pour chaque row kind='normal', reconstitue les timestamps depMs/arrMs en
 *  inférant le mois (offset par rapport à meta.monthIso) via la détection de
 *  sauts de jour. */
interface StampedRow {
  row: Ep4HoraireRow;
  depMs: number;
  arrMs: number;
}
function stampRows(ep4: Ep4PdfData): StampedRow[] {
  if (!ep4.meta.monthIso) return [];
  const monthIso = ep4.meta.monthIso;
  const rows = usableRows(ep4);
  if (rows.length === 0) return [];
  const out: StampedRow[] = [];

  // Offset initial : si la 1ère row a un jour élevé (≥ 25), c'est qu'on commence
  // par un spillover du mois précédent (rotation partie fin M-1, arrivée en M).
  // Sans cette correction, day=31 du PDF janvier serait calculé comme 31 jan.
  let monthOffset = rows[0].reelDep!.day >= 25 ? -1 : 0;
  let lastReferenceDay = -1;

  for (const r of rows) {
    const depDay = r.reelDep!.day;
    // Saut négatif majeur sur le depDay : on a basculé au mois suivant.
    if (lastReferenceDay >= 0 && depDay < lastReferenceDay - DAY_JUMP_THRESHOLD) {
      monthOffset++;
    }
    const depMs = horaireToMs(monthIso, monthOffset, r.reelDep!);

    // Pour l'arrivée d'un même vol, possible saut de jour intra-vol (vol nuit
    // qui passe minuit). Si arrDay < depDay - threshold, on est passé au
    // lendemain (= peut-être au mois suivant si depDay = 31).
    const arrDay = r.reelArr!.day;
    let arrOffset = monthOffset;
    if (arrDay < depDay - DAY_JUMP_THRESHOLD) arrOffset = monthOffset + 1;
    const arrMs = horaireToMs(monthIso, arrOffset, r.reelArr!);

    if (arrMs <= depMs) continue;
    out.push({ row: r, depMs, arrMs });
    lastReferenceDay = arrDay;
  }

  return out;
}

export interface Ep4Rotation {
  debut_rotation:   string;    // 'YYYY-MM-DD' (date du 1er reelDep)
  debut_sejour_at:  string;    // ISO UTC, -5 min appliqué
  fin_sejour_at:    string;    // ISO UTC, +10 min appliqué
  escale_debut:     string;
  escale_fin:       string;
  /** Escales visitées hors-base, séparées par un espace. Sert au lookup
   *  zone via la table annexe `rotation_zones`. */
  rotation_code:    string;
}

/** Extrait les rotations contenues dans un EP4 PDF. */
export function extractRotationsFromEp4(ep4: Ep4PdfData): Ep4Rotation[] {
  const base = detectBaseFromEp4(ep4);
  if (!base) return [];
  const stamped = stampRows(ep4);

  const out: Ep4Rotation[] = [];
  let bucket: StampedRow[] = [];
  let state: 'idle' | 'in_rotation' = 'idle';

  function emitBucket() {
    if (bucket.length === 0) return;
    const debutRow = bucket[0];
    const finRow   = bucket[bucket.length - 1];
    const escales: string[] = [];
    for (const b of bucket) {
      const e = b.row.escArr!;
      if (e !== base && escales[escales.length - 1] !== e) escales.push(e);
    }
    // Si la rotation ne se ferme pas par un retour-base (= bucket émis avant
    // la fin), escale_fin = escDep du dernier row utile (= dernière escale
    // hors-base avant que la trace ne s'arrête).
    const lastEscDep: string = finRow.row.escDep === base
      ? (finRow.row.escDep ?? '')
      : (escales[escales.length - 1] ?? finRow.row.escDep ?? '');
    out.push({
      debut_rotation:  new Date(debutRow.depMs).toISOString().slice(0, 10),
      debut_sejour_at: new Date(debutRow.arrMs + DEBUT_OFFSET_MS).toISOString(),
      fin_sejour_at:   new Date(finRow.depMs   + FIN_OFFSET_MS).toISOString(),
      escale_debut:    debutRow.row.escArr!,
      escale_fin:      lastEscDep,
      rotation_code:   escales.join(' '),
    });
  }

  for (const s of stamped) {
    if (state === 'idle') {
      if (s.row.escDep === base) {
        state = 'in_rotation';
        bucket = [s];
      }
    } else {
      bucket.push(s);
      if (s.row.escArr === base) {
        emitBucket();
        state = 'idle';
        bucket = [];
      }
    }
  }
  // Émission d'une rotation incomplète restée en buffer (= ne se ferme pas
  // dans ce PDF, ex rotation à cheval HKG fév-mars dont le retour CDG est
  // dans le PDF mars non importé).
  if (state === 'in_rotation' && bucket.length > 0) {
    emitBucket();
  }

  return out;
}
