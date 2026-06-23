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
  // On inclut kind='normal' + kind='spillover_info'. Les spillover_info portent
  // l'info totale d'une rotation à cheval rattachée à un autre mois — sans
  // elles, NBJ 31 déc-4 jan ou HKG fév-mars ne seraient pas reconstituables
  // depuis un seul PDF.
  //
  // Exclusions :
  //  - escDep === escArr (avion parti puis revenu au parking, ex CDG→CDG) :
  //    ouvrirait une rotation fantôme (escDep=base).
  //  - escDep === 'XXX' ou escArr === 'XXX' : rows kind='spillover_prorata',
  //    lignes synthétiques du PDF AF qui matérialisent une coupure mois/mois.
  //    Si on les laisse passer, leur escDep=CDG (= base) ouvre une fausse
  //    rotation au milieu de la vraie, et debut_sejour_at finit sur le XXX
  //    synthétique à 24:00 au lieu du vrai block-on.
  return ep4.horaire.rows.filter(r =>
    !!r.escDep && !!r.escArr &&
    r.escDep !== r.escArr &&
    r.escDep !== 'XXX' && r.escArr !== 'XXX' &&
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

  // Inférence du `monthOffset` par row : on suit la chronologie. On part de
  // l'arrivée précédente (`prevArrOffset`) comme ancrage du dep courant.
  //
  // Offset initial : si la 1ère row a `day >= 25`, on commence par un
  // spillover du mois précédent → -1. Sans ça, day=31 du PDF janvier serait
  // calculé comme 31 janvier (faux).
  //
  // Transitions :
  //  - dep courant < prevArr précédent (saut négatif >15j) → +1 mois
  //  - arr < dep (vol nuit qui passe minuit) → +1 mois sur l'arr seulement
  let prevArrOffset = rows[0].reelDep!.day >= 25 ? -1 : 0;
  let prevArrDay = -1;

  for (const r of rows) {
    const depDay = r.reelDep!.day;
    let depOffset = prevArrOffset;
    if (prevArrDay >= 0 && depDay < prevArrDay - DAY_JUMP_THRESHOLD) {
      depOffset++;
    }
    const depMs = horaireToMs(monthIso, depOffset, r.reelDep!);

    const arrDay = r.reelArr!.day;
    let arrOffset = depOffset;
    if (arrDay < depDay - DAY_JUMP_THRESHOLD) arrOffset = depOffset + 1;
    const arrMs = horaireToMs(monthIso, arrOffset, r.reelArr!);

    if (arrMs <= depMs) continue;
    out.push({ row: r, depMs, arrMs });
    prevArrDay = arrDay;
    prevArrOffset = arrOffset;
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
  /** Escales individuelles visitées (ordonnées, dédup successifs). Sert au
   *  lookup zone fallback : si `rotation_code` exact ne matche pas (bucket
   *  pollué par des rows spillover), on cherche chaque escale dans la table. */
  escales_visitees: string[];
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
      debut_rotation:    new Date(debutRow.depMs).toISOString().slice(0, 10),
      debut_sejour_at:   new Date(debutRow.arrMs + DEBUT_OFFSET_MS).toISOString(),
      fin_sejour_at:     new Date(finRow.depMs   + FIN_OFFSET_MS).toISOString(),
      escale_debut:      debutRow.row.escArr!,
      escale_fin:        lastEscDep,
      rotation_code:     escales.join(' '),
      escales_visitees:  escales,
    });
  }

  for (const s of stamped) {
    // Si on rencontre un nouveau départ-base alors qu'une rotation n'est pas
    // fermée, on émet ce qu'on a et on redémarre. Sans ce reset, les rows de
    // la nouvelle rotation polluent le bucket précédent et on émet une
    // rotation fantôme du genre "EZE → HKG" (escale_debut de la 1ère, escale_fin
    // de la 2e).
    if (state === 'in_rotation' && s.row.escDep === base) {
      emitBucket();
      bucket = [];
      state = 'idle';
    }
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
