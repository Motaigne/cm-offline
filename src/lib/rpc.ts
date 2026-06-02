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
// Hard blockers (sol / sim / medical / instr / autre) : ne tronquent PLUS le
// RPC. Si le RPC les chevauche, on expose un segment hardConflict (rendu rouge
// par l'UI + alerte). Le placement reste autorisé. Fenêtre d'occupation :
//   - sol/medical/autre → 8h-18h Paris
//   - sim/instr         → jour entier
// (voir hardBlockerWindow).

import type { CalendarItem } from '@/app/page';

export type RpcSegment = { startMs: number; endMs: number };

export type EffectiveRpc = {
  /** Segments solides à dessiner (le bar bleu post-RPC). Vide si pas de RPC. */
  segments: RpcSegment[];
  /** Fin effective du RPC (= dernier endMs des segments). 0 si pas de RPC. */
  endMs: number;
  /** True si au moins une journée entière de congé/TAF est dans le RPC.
   *  En mode OFF c'est le déclencheur du flag visuel ; en mode ON c'est
   *  juste informatif (les pauses sont déjà dans segments). */
  hasConflict: boolean;
  /** Jours en conflit (chacun = [00:00 UTC, jour+1 00:00 UTC[) — utilisé pour
   *  positionner les pauses pointillées en mode ON. Vide en OFF même si
   *  hasConflict. */
  pauseIntervals: RpcSegment[];
  /** Portions du RPC qui chevauchent une fenêtre d'occupation d'un hard
   *  blocker (sol/medical/autre 8h-18h Paris, sim/instr jour entier).
   *  Rendues en rouge par l'UI avec une icône d'alerte. */
  hardConflict: RpcSegment[];
};

// Soft blockers : RPC peut les chevaucher (pause/resume en mode ON, flag en
// mode OFF). CSS suit la même logique que conge (jour non travaillé).
const BLOCKING_KINDS = new Set(['conge', 'conge_ss', 'taf']);
export const HARD_BLOCKERS = new Set(['sol', 'sim', 'medical', 'instr', 'autre']);
// Hard blockers à fenêtre journalière 8h-18h Paris. Les autres (sim, instr)
// gardent une représentation jour entier.
const PARIS_DAY_HARD_BLOCKERS = new Set(['sol', 'medical', 'autre']);

// ─── Paris time helpers ──────────────────────────────────────────────────────
// Convertit une heure locale Paris (gère CEST/CET automatiquement via Intl)
// vers un timestamp UTC ms. Utilisé pour positionner les fenêtres 8h-18h des
// hard blockers indépendamment du fuseau du serveur/client.

function parisOffsetMinutes(utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const find = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
  const parisAsUtc = Date.UTC(
    find('year'), find('month') - 1, find('day'),
    find('hour') % 24, find('minute'), find('second'),
  );
  return Math.round((parisAsUtc - utcMs) / 60_000);
}

/** Convertit "YYYY-MM-DD HH:00" en heure de Paris vers un timestamp UTC ms.
 *  Une passe de correction suffit (DST ne saute jamais entre 8h et 18h). */
export function parisHourToUtcMs(dateStr: string, hour: number): number {
  const y  = Number(dateStr.slice(0, 4));
  const m  = Number(dateStr.slice(5, 7));
  const d  = Number(dateStr.slice(8, 10));
  const naive = Date.UTC(y, m - 1, d, hour, 0, 0);
  const offset = parisOffsetMinutes(naive);
  return naive - offset * 60_000;
}

/** Fenêtre d'occupation d'un item considéré comme "hard blocker".
 *  - sol/medical/autre : 8h-18h Paris (10h, payés 4 HCr).
 *  - sim/instr         : jour entier [start_date 00:00 UTC, end_date+1 00:00 UTC[.
 *  Retourne null si kind ∉ HARD_BLOCKERS. */
export function hardBlockerWindow(item: CalendarItem): { startMs: number; endMs: number } | null {
  if (!HARD_BLOCKERS.has(item.kind)) return null;
  if (PARIS_DAY_HARD_BLOCKERS.has(item.kind)) {
    // Mono-jour 8h-18h Paris. Si end_date > start_date (rare), on étire jusqu'au
    // 18h Paris du dernier jour.
    return {
      startMs: parisHourToUtcMs(item.start_date, 8),
      endMs:   parisHourToUtcMs(item.end_date,   18),
    };
  }
  // sim / instr : jour entier
  return {
    startMs: new Date(item.start_date + 'T00:00:00Z').getTime(),
    endMs:   new Date(item.end_date   + 'T00:00:00Z').getTime() + 86_400_000,
  };
}

/** Collecte les fenêtres d'occupation des hard blockers qui peuvent croiser
 *  une plage temporelle donnée. Utilisé pour détecter les zones rouges du RPC. */
function collectHardBlockerWindows(items: CalendarItem[]): RpcSegment[] {
  const out: RpcSegment[] = [];
  for (const item of items) {
    const w = hardBlockerWindow(item);
    if (w && w.endMs > w.startMs) out.push(w);
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Intersecte une liste de segments avec une liste de fenêtres (hard blockers).
 *  Renvoie les portions de segments couvertes par au moins une fenêtre. */
function intersectSegmentsWithWindows(
  segments: RpcSegment[],
  windows: RpcSegment[],
): RpcSegment[] {
  const out: RpcSegment[] = [];
  for (const s of segments) {
    for (const w of windows) {
      const a = Math.max(s.startMs, w.startMs);
      const b = Math.min(s.endMs,   w.endMs);
      if (b > a) out.push({ startMs: a, endMs: b });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
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
    segments: [], endMs: 0,
    hasConflict: false, pauseIntervals: [], hardConflict: [],
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

  const others        = items.filter(it => it.id !== flight.id);
  const hardWindows   = collectHardBlockerWindows(others);
  const origEnd       = arrivee + restMs;

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

  // Mode OFF : pas de shift. Retourne le RPC d'origine + flag conflit + zones
  // de chevauchement avec hard blockers (rouges).
  if (!chevauchement) {
    const segments: RpcSegment[] = origEnd > arrivee
      ? [{ startMs: arrivee, endMs: origEnd }]
      : [];
    return {
      segments,
      endMs: origEnd,
      hasConflict: pausedDays.length > 0,
      pauseIntervals: [],
      hardConflict: intersectSegmentsWithWindows(segments, hardWindows),
    };
  }

  // Mode ON : pas de conflit (rien à signaler) → RPC normal + zones rouges.
  if (pausedDays.length === 0) {
    const segments: RpcSegment[] = origEnd > arrivee
      ? [{ startMs: arrivee, endMs: origEnd }]
      : [];
    return {
      segments,
      endMs: origEnd,
      hasConflict: false,
      pauseIntervals: [],
      hardConflict: intersectSegmentsWithWindows(segments, hardWindows),
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

  const segments: RpcSegment[] = [];
  let cursor = arrivee;
  for (const p of pauseIntervals) {
    if (p.startMs > cursor) segments.push({ startMs: cursor, endMs: p.startMs });
    cursor = p.endMs;
  }
  if (extendedEnd > cursor) segments.push({ startMs: cursor, endMs: extendedEnd });

  const endMs = segments.length > 0 ? segments[segments.length - 1].endMs : arrivee;
  return {
    segments,
    endMs,
    hasConflict: true,
    pauseIntervals,
    hardConflict: intersectSegmentsWithWindows(segments, hardWindows),
  };
}
