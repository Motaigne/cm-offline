// ─── RPC (Repos Post Courrier) report helper ─────────────────────────────────
//
// Calcule la plage effective du RPC d'un vol en tenant compte des congés / TAF
// qui peuvent soit le reporter (mode défaut), soit être chevauchés (mode
// "Autoriser chevauchement"). Renvoie les segments à dessiner dans le gantt
// ainsi que la fin effective du RPC (utilisée pour la détection de chevauchement
// au moment de poser un nouveau vol).
//
// 2 modes :
//
// - DEFAULT (report total) : si un congé/TAF démarre dans la fenêtre RPC
//   d'origine, le RPC est repoussé après la chaîne contiguë de congés/TAF.
//   La durée du RPC reste inchangée. Visuel : 1 seul segment, déplacé.
//
// - CHEVAUCHEMENT (overlap autorisé) : le compteur RPC "se met en pause"
//   pendant les congés/TAF qu'il traverse, puis reprend après. Visuel : N+1
//   segments séparés par N pauses (où N = nombre d'intervalles cong/TAF
//   traversés).
//
// Les items de type sol / sim / medical / instr / autre sont des hard blockers :
// ils ne peuvent jamais être chevauchés par un RPC. Le calcul s'arrête au début
// de tels items (la sortie est tronquée et un flag truncated=true est mis).

import type { CalendarItem } from '@/app/page';

export type RpcSegment = { startMs: number; endMs: number };

export type EffectiveRpc = {
  /** Segments à dessiner (trait plein). Vide si pas de RPC. */
  segments: RpcSegment[];
  /** Fin effective du RPC (= dernier endMs des segments). 0 si pas de RPC. */
  endMs: number;
  /** True si le calcul a été tronqué par un hard blocker (sol/sim/...). */
  truncated: boolean;
};

const BLOCKING_KINDS = new Set(['conge', 'taf']);
const HARD_BLOCKERS = new Set(['sol', 'sim', 'medical', 'instr', 'autre']);

/** [startMs, endMs) en ms epoch pour un item. Vols : depart_at → arrivee_at.
 *  Non-vols : start_date 00:00 UTC → end_date+1 00:00 UTC. Le gantt utilise
 *  UTC partout pour positionner les barres (dayFrac via accesseurs UTC). */
function itemRangeMs(item: CalendarItem): [number, number] {
  if (item.kind === 'flight') {
    const meta = (item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta))
      ? item.meta as Record<string, unknown>
      : null;
    const depart  = typeof meta?.depart_at  === 'string' ? new Date(meta.depart_at).getTime()  : NaN;
    const arrivee = typeof meta?.arrivee_at === 'string' ? new Date(meta.arrivee_at).getTime() : NaN;
    if (Number.isFinite(depart) && Number.isFinite(arrivee)) return [depart, arrivee];
  }
  const startMs = new Date(item.start_date + 'T00:00:00Z').getTime();
  const endMs   = new Date(item.end_date   + 'T00:00:00Z').getTime() + 86_400_000;
  return [startMs, endMs];
}

/** Calcule la fin de chaîne contiguë de congés/TAF démarrant à partir d'un
 *  item de référence. Une chaîne est dite contiguë si chaque item suivant
 *  démarre au plus tard 1ms après la fin du précédent (= jours consécutifs ou
 *  qui se chevauchent). */
function findChainEnd(startMs: number, items: CalendarItem[]): number {
  let chainEnd = startMs;
  let extended = true;
  while (extended) {
    extended = false;
    for (const it of items) {
      if (!BLOCKING_KINDS.has(it.kind)) continue;
      const [s, e] = itemRangeMs(it);
      if (s <= chainEnd && e > chainEnd) {
        chainEnd = e;
        extended = true;
      }
    }
  }
  return chainEnd;
}

/** Trouve les intervalles BLOCKING (conge/taf) qui touchent [from, to). Triés. */
function blockingIntervalsIn(
  from: number,
  to: number,
  items: CalendarItem[],
): RpcSegment[] {
  const out: RpcSegment[] = [];
  for (const it of items) {
    if (!BLOCKING_KINDS.has(it.kind)) continue;
    const [s, e] = itemRangeMs(it);
    if (e <= from || s >= to) continue;
    out.push({ startMs: Math.max(s, from), endMs: Math.min(e, to) });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Trouve le 1er hard blocker (sol/sim/...) à partir de `from`. Renvoie son startMs ou +∞. */
function nextHardBlockerStart(from: number, items: CalendarItem[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const it of items) {
    if (!HARD_BLOCKERS.has(it.kind)) continue;
    const [s] = itemRangeMs(it);
    if (s >= from && s < min) min = s;
  }
  return min;
}

/**
 * Calcule la plage effective du RPC d'un vol.
 *
 * @param flight - le vol dont on calcule le RPC. Doit avoir kind='flight' +
 *                 meta.arrivee_at + meta.rest_after_h.
 * @param items - tous les autres items du scénario (le vol lui-même peut être
 *                inclus, il sera ignoré via item.id !== flight.id).
 * @param chevauchement - si true, mode chevauchement (pauses) ; sinon mode
 *                         report total.
 */
export function computeEffectiveRpc(
  flight: CalendarItem,
  items: CalendarItem[],
  chevauchement: boolean,
): EffectiveRpc {
  if (flight.kind !== 'flight') return { segments: [], endMs: 0, truncated: false };
  const meta = (flight.meta && typeof flight.meta === 'object' && !Array.isArray(flight.meta))
    ? flight.meta as Record<string, unknown>
    : null;
  const arrivee = typeof meta?.arrivee_at === 'string' ? new Date(meta.arrivee_at).getTime() : NaN;
  const endAct  = typeof meta?.scheduled_end_activity_at === 'string'
    ? new Date(meta.scheduled_end_activity_at).getTime() : NaN;
  const restH   = typeof meta?.rest_after_h === 'number' ? meta.rest_after_h : 0;
  if (!Number.isFinite(arrivee)) return { segments: [], endMs: 0, truncated: false };

  // Préférer scheduled_end_activity_at (source de vérité) à rest_after_h
  // (qui est dérivé). Fallback à arrivee + restH * 3600000 si timestamp absent.
  const restMs = Number.isFinite(endAct) && endAct > arrivee
    ? endAct - arrivee
    : restH * 3_600_000;
  if (restMs <= 0) return { segments: [], endMs: 0, truncated: false };
  const others    = items.filter(it => it.id !== flight.id);
  const hardLimit = nextHardBlockerStart(arrivee, others);

  if (!chevauchement) {
    // Mode REPORT TOTAL : si un conge/TAF démarre dans [arrivee, arrivee+restMs[,
    // on déplace le RPC entier après la chaîne contiguë.
    const origEnd = arrivee + restMs;
    const overlapping = blockingIntervalsIn(arrivee, origEnd, others);
    if (overlapping.length === 0) {
      // Pas de report — éventuellement tronqué par un hard blocker.
      const endMs = Math.min(origEnd, hardLimit);
      return {
        segments: endMs > arrivee ? [{ startMs: arrivee, endMs }] : [],
        endMs,
        truncated: endMs < origEnd,
      };
    }
    const chainEnd = findChainEnd(overlapping[0].startMs, others);
    const newEnd   = chainEnd + restMs;
    const cappedEnd = Math.min(newEnd, hardLimit);
    return {
      segments: cappedEnd > chainEnd ? [{ startMs: chainEnd, endMs: cappedEnd }] : [],
      endMs: cappedEnd,
      truncated: cappedEnd < newEnd,
    };
  }

  // Mode CHEVAUCHEMENT : on consomme restMs ms réelles en sautant les
  // intervalles conge/TAF. Plusieurs segments possibles.
  const segments: RpcSegment[] = [];
  let cursor = arrivee;
  let remaining = restMs;
  let truncated = false;
  // Garde-fou : pas plus de N segments — évite une boucle infinie si données
  // étranges (overlapping intervals, etc.).
  for (let guard = 0; guard < 100 && remaining > 0; guard++) {
    if (cursor >= hardLimit) { truncated = true; break; }
    const blockers = blockingIntervalsIn(cursor, cursor + remaining + 365 * 86_400_000, others);
    const nextBlocker = blockers.find(b => b.endMs > cursor);
    if (!nextBlocker || nextBlocker.startMs >= cursor + remaining) {
      // Aucun blocker dans la fenêtre restante → segment final.
      let segEnd = cursor + remaining;
      if (segEnd > hardLimit) { segEnd = hardLimit; truncated = true; }
      if (segEnd > cursor) segments.push({ startMs: cursor, endMs: segEnd });
      remaining = 0;
      break;
    }
    // Segment partiel jusqu'au blocker
    if (nextBlocker.startMs > cursor) {
      let segEnd = nextBlocker.startMs;
      if (segEnd > hardLimit) { segEnd = hardLimit; truncated = true; }
      segments.push({ startMs: cursor, endMs: segEnd });
      remaining -= (segEnd - cursor);
      if (truncated) break;
    }
    cursor = nextBlocker.endMs;
  }
  const endMs = segments.length > 0 ? segments[segments.length - 1].endMs : arrivee;
  return { segments, endMs, truncated };
}
