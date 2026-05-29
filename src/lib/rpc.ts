// ─── RPC (Repos Post Courrier) report helper ─────────────────────────────────
//
// Calcule la plage effective du RPC d'un vol et identifie les conflits avec
// congés / TAF. Un conflit n'existe que si la JOURNÉE ENTIÈRE [00:00 → 24:00]
// du congé/TAF est entièrement couverte par le RPC. Un chevauchement partiel
// (ex: RPC fini le 11 à 6h, congé le 11) est toujours toléré sans flag.
//
// 2 modes (toggle global "Chevauchement" dans la barre du mois) :
//
// - OFF (défaut) : aucun report automatique. Le RPC reste à sa position
//   d'origine. Si un jour entier de congé/TAF est dans le RPC, un flag
//   hasConflict=true est levé (l'UI peut afficher un avertissement).
//
// - ON : modèle "pause/resume" itératif. Chaque journée entière de congé/TAF
//   au sein du RPC le décale de 24h. Cascade : si l'extension englobe un
//   nouveau jour de congé/TAF, on continue.
//
// Hard blockers (sol / sim / medical / instr / autre) : ne peuvent JAMAIS
// être chevauchés. Le RPC est tronqué au début du 1er hard blocker rencontré.

import type { CalendarItem } from '@/app/page';

export type RpcSegment = { startMs: number; endMs: number };

export type EffectiveRpc = {
  /** Segments solides à dessiner (le bar bleu post-RPC). Vide si pas de RPC. */
  segments: RpcSegment[];
  /** Fin effective du RPC (= dernier endMs des segments). 0 si pas de RPC. */
  endMs: number;
  /** True si le calcul a été tronqué par un hard blocker (sol/sim/...). */
  truncated: boolean;
  /** True si au moins une journée entière de congé/TAF est dans le RPC.
   *  En mode OFF c'est le déclencheur du flag visuel ; en mode ON c'est
   *  juste informatif (les pauses sont déjà dans segments). */
  hasConflict: boolean;
  /** Jours en conflit (chacun = [00:00 UTC, jour+1 00:00 UTC[) — utilisé pour
   *  positionner les pauses pointillées en mode ON. Vide en OFF même si
   *  hasConflict. */
  pauseIntervals: RpcSegment[];
};

const BLOCKING_KINDS = new Set(['conge', 'taf']);
const HARD_BLOCKERS = new Set(['sol', 'sim', 'medical', 'instr', 'autre']);

/** Trouve le 1er hard blocker (sol/sim/...) à partir de `from`. Renvoie son
 *  startMs ou +∞ si aucun. */
function nextHardBlockerStart(from: number, items: CalendarItem[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const item of items) {
    if (!HARD_BLOCKERS.has(item.kind)) continue;
    const startMs = new Date(item.start_date + 'T00:00:00Z').getTime();
    if (startMs >= from && startMs < min) min = startMs;
  }
  return min;
}

/** Décompose les items congé/TAF en jours individuels (un objet par 24h).
 *  Trié par startMs. Utilise les dates UTC pour rester cohérent avec dayFrac
 *  du gantt (qui utilise les accesseurs UTC). */
function collectBlockingDays(items: CalendarItem[]): RpcSegment[] {
  const out: RpcSegment[] = [];
  for (const item of items) {
    if (!BLOCKING_KINDS.has(item.kind)) continue;
    const start = new Date(item.start_date + 'T00:00:00Z');
    const end   = new Date(item.end_date   + 'T00:00:00Z');
    const cursor = new Date(start);
    while (cursor <= end) {
      const startMs = cursor.getTime();
      out.push({ startMs, endMs: startMs + 86_400_000 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Calcule la plage effective du RPC d'un vol.
 *
 * @param flight - le vol dont on calcule le RPC (kind='flight' + meta.arrivee_at).
 * @param items - tous les autres items du scénario (le vol lui-même est filtré
 *                via item.id !== flight.id).
 * @param chevauchement - true = mode pause/resume (RPC étendu), false = pas
 *                         de shift, juste flag (hasConflict).
 */
export function computeEffectiveRpc(
  flight: CalendarItem,
  items: CalendarItem[],
  chevauchement: boolean,
): EffectiveRpc {
  const empty: EffectiveRpc = {
    segments: [], endMs: 0, truncated: false,
    hasConflict: false, pauseIntervals: [],
  };
  if (flight.kind !== 'flight') return empty;
  const meta = (flight.meta && typeof flight.meta === 'object' && !Array.isArray(flight.meta))
    ? flight.meta as Record<string, unknown>
    : null;
  const arrivee = typeof meta?.arrivee_at === 'string' ? new Date(meta.arrivee_at).getTime() : NaN;
  const endAct  = typeof meta?.scheduled_end_activity_at === 'string'
    ? new Date(meta.scheduled_end_activity_at).getTime() : NaN;
  const restH   = typeof meta?.rest_after_h === 'number' ? meta.rest_after_h : 0;
  if (!Number.isFinite(arrivee)) return empty;

  // Préférer scheduled_end_activity_at (source de vérité) à rest_after_h
  // (dérivé). Fallback à arrivee + restH * 3600000 si timestamp absent.
  const restMs = Number.isFinite(endAct) && endAct > arrivee
    ? endAct - arrivee
    : restH * 3_600_000;
  if (restMs <= 0) return empty;

  const others    = items.filter(it => it.id !== flight.id);
  const hardLimit = nextHardBlockerStart(arrivee, others);
  const origEnd   = arrivee + restMs;

  // Itère : pour chaque jour entier de congé/TAF couvert par le RPC (de plus
  // en plus étendu), on l'ajoute à pauses et on décale endMs de 24h. Cascade
  // jusqu'à stabilité (ou guard 100 itérations).
  const blockingDays = collectBlockingDays(others);
  const pausedSet    = new Set<number>();
  const pausedDays: RpcSegment[] = [];
  let extendedEnd = origEnd;
  for (let guard = 0; guard < 100; guard++) {
    let changed = false;
    for (const d of blockingDays) {
      if (pausedSet.has(d.startMs)) continue;
      // Jour entier doit être COMPLÈTEMENT dans la fenêtre RPC actuelle.
      if (arrivee <= d.startMs && d.endMs <= extendedEnd) {
        pausedSet.add(d.startMs);
        pausedDays.push(d);
        extendedEnd += 86_400_000;
        changed = true;
      }
    }
    if (!changed) break;
  }
  pausedDays.sort((a, b) => a.startMs - b.startMs);

  // Mode OFF : pas de shift. Retourne le RPC d'origine + flag conflit.
  if (!chevauchement) {
    const cappedEnd = Math.min(origEnd, hardLimit);
    return {
      segments: cappedEnd > arrivee ? [{ startMs: arrivee, endMs: cappedEnd }] : [],
      endMs: cappedEnd,
      truncated: cappedEnd < origEnd,
      hasConflict: pausedDays.length > 0,
      pauseIntervals: [],
    };
  }

  // Mode ON : pas de conflit (rien à signaler) → RPC normal.
  if (pausedDays.length === 0) {
    const cappedEnd = Math.min(origEnd, hardLimit);
    return {
      segments: cappedEnd > arrivee ? [{ startMs: arrivee, endMs: cappedEnd }] : [],
      endMs: cappedEnd,
      truncated: cappedEnd < origEnd,
      hasConflict: false,
      pauseIntervals: [],
    };
  }

  // Mode ON avec conflit : merge les jours contigus en intervalles de pause
  // puis génère les segments solides entre.
  const pauseIntervals: RpcSegment[] = [];
  for (const d of pausedDays) {
    const last = pauseIntervals[pauseIntervals.length - 1];
    if (last && last.endMs === d.startMs) last.endMs = d.endMs;
    else pauseIntervals.push({ startMs: d.startMs, endMs: d.endMs });
  }

  const rawSegments: RpcSegment[] = [];
  let cursor = arrivee;
  for (const p of pauseIntervals) {
    if (p.startMs > cursor) rawSegments.push({ startMs: cursor, endMs: p.startMs });
    cursor = p.endMs;
  }
  if (extendedEnd > cursor) rawSegments.push({ startMs: cursor, endMs: extendedEnd });

  // Truncation par hard blocker
  const segments: RpcSegment[] = [];
  let truncated = false;
  for (const s of rawSegments) {
    if (s.startMs >= hardLimit) { truncated = true; continue; }
    const cappedEnd = Math.min(s.endMs, hardLimit);
    if (cappedEnd > s.startMs) segments.push({ startMs: s.startMs, endMs: cappedEnd });
    if (cappedEnd < s.endMs) truncated = true;
  }
  // Pause intervals tronqués aussi
  const trimmedPauses: RpcSegment[] = [];
  for (const p of pauseIntervals) {
    if (p.startMs >= hardLimit) continue;
    trimmedPauses.push({ startMs: p.startMs, endMs: Math.min(p.endMs, hardLimit) });
  }

  const endMs = segments.length > 0 ? segments[segments.length - 1].endMs : arrivee;
  return {
    segments,
    endMs,
    truncated,
    hasConflict: true,
    pauseIntervals: trimmedPauses,
  };
}
