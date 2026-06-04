// ─── DDA / VOL P rules validator ─────────────────────────────────────────────
//
// Vérifie les enchaînements entre activités selon les règles stockées dans
// annexe_table (slug: 'dda_rules' et 'vol_p_rules'). 100% client-side, donc
// fonctionne offline tant que les règles sont hydratées dans IndexedDB.
//
// Catégories : DDA_REPOS | DDA_VOL | VOL_P | CONGES | ELABO_SUIVI (exempt).
// Mapping CalendarItem :
//   - kind 'off'    → DDA_REPOS
//   - kind 'conge'  → CONGES
//   - kind 'flight' :
//       · bid_category 'vol_p'       → VOL_P
//       · bid_category 'elabo_suivi' → ELABO_SUIVI (exempt)
//       · sinon (dda_vol / dda_off / null) → DDA_VOL
//   - autres kinds (sim, sol, medical, instr, taf, autre) → ignorés.

import type { CalendarItem } from '@/app/page';

export type DdaCategory = 'DDA_REPOS' | 'DDA_VOL' | 'VOL_P' | 'CONGES' | 'ELABO_SUIVI';

type GapFrom = 'end' | 'rpc_first_day' | 'rpc_last_day' | 'end_no_rpc';
type GapTo   = 'start' | 'block_off';

// Formule générale : gap = diffDays(refTo(B), refFrom(A)) - 1.
//   refFrom(A, 'end')           = A.end_date                   (= block ON pour un vol)
//   refFrom(A, 'rpc_first_day') = A.end_date + 1               (= 1er jour de RPC)
//   refFrom(A, 'rpc_last_day')  = A.end_date + RPC_days        (= dernier jour de RPC)
//   refFrom(A, 'end_no_rpc')    = A.end_date                   (option report RPC)
//   refTo(B, 'start' | 'block_off') = B.start_date             (= block OFF pour un vol)

type GapBucket = {
  ok: number[];
  forbidden: number[];
  min_ok_above: number;
};

type RuleBase = {
  from: DdaCategory;
  to: DdaCategory;
  gap_from: GapFrom;
  gap_to: GapTo;
};

type RuleSimple = RuleBase & GapBucket & {
  rpc_dependent?: false;
  rpc_report_alt?: {
    gap_from: GapFrom;
    gap_to?: GapTo;
    ok?: number[];
    forbidden?: number[];
    min_ok_above?: number;
  };
};

type RuleRpcDependent = RuleBase & {
  rpc_dependent: true;
  rpc: Record<'1' | '2' | '3', GapBucket>;
};

export type DdaRule = RuleSimple | RuleRpcDependent;

export type DdaRulesData = {
  version: string;
  rules: DdaRule[];
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function dateToOrdinal(dateStr: string): number {
  // Convert YYYY-MM-DD to days since epoch (UTC). Used only for diffs.
  return Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 86_400_000);
}

function diffDays(a: string, b: string): number {
  return dateToOrdinal(a) - dateToOrdinal(b);
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function readMeta(item: CalendarItem): Record<string, unknown> | null {
  if (item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta)) {
    return item.meta as Record<string, unknown>;
  }
  return null;
}

/** Nombre de jours UTC ENTIÈREMENT couverts par le RPC après la fin du vol.
 *  Un jour partiel (RPC se terminant en cours de journée) ne compte pas.
 *  Ex: arrivee J5 06h Paris + 72h RPC → rpcEnd J8 06h Paris, jours pleins =
 *  J6+J7 = 2. Capé 0-3. Fallback ceil(h/24) si pas de timestamp arrivee_at. */
function rpcDaysOf(item: CalendarItem): number {
  const meta = readMeta(item);
  const h = typeof meta?.rest_after_h === 'number' ? meta.rest_after_h : 0;
  if (h <= 0) return 0;

  const arriveeAtStr = typeof meta?.arrivee_at === 'string' ? meta.arrivee_at : null;
  if (!arriveeAtStr) {
    return Math.min(3, Math.max(0, Math.ceil(h / 24)));
  }

  const arriveeMs = new Date(arriveeAtStr).getTime();
  const endActAtStr = typeof meta?.scheduled_end_activity_at === 'string'
    ? meta.scheduled_end_activity_at : null;
  const endActMs = endActAtStr ? new Date(endActAtStr).getTime() : NaN;
  const restMs = Number.isFinite(endActMs) && endActMs > arriveeMs
    ? endActMs - arriveeMs
    : h * 3_600_000;
  const rpcEndMs = arriveeMs + restMs;

  // 1er jour candidat = end_date + 1 (00:00 UTC). On compte les jours [00:00, 24:00]
  // entièrement dans [arrivee, rpcEnd].
  const dayMs = 86_400_000;
  let dayStart = new Date(item.end_date + 'T00:00:00Z').getTime() + dayMs;
  let count = 0;
  while (dayStart + dayMs <= rpcEndMs && count < 3) {
    count++;
    dayStart += dayMs;
  }
  return count;
}

/** Jour de référence "from" selon le mode. Renvoie une date YYYY-MM-DD. */
function refFrom(item: CalendarItem, mode: GapFrom): string {
  const end = item.end_date;
  if (mode === 'end' || mode === 'end_no_rpc') return end;
  if (mode === 'rpc_first_day') return addDays(end, 1);
  if (mode === 'rpc_last_day')  return addDays(end, rpcDaysOf(item));
  return end;
}

/** Jour de référence "to". 'block_off' et 'start' renvoient tous deux start_date
 *  (qui est le jour de départ pour kind=flight). */
function refTo(item: CalendarItem): string {
  return item.start_date;
}

/** Catégorie DDA d'un item, ou null si exempt. */
export function categoryOf(item: CalendarItem): DdaCategory | null {
  if (item.kind === 'off')      return 'DDA_REPOS';
  if (item.kind === 'conge')    return 'CONGES';
  // CSS (congés sans solde) = traité comme CONGES pour les règles DDA.
  if (item.kind === 'conge_ss') return 'CONGES';
  // TAF = "Temps Alterné" (régime TAF7 notamment). La spec optiP_DEF parle
  // de "CONGES/TA" partout — mêmes règles, mêmes seuils que CONGES.
  if (item.kind === 'taf')      return 'CONGES';
  // Exempts explicites : ces kinds occupent le calendrier mais ne participent
  // ni à la dispersion ni aux violations de règles d'enchaînement.
  // Marqués ELABO_SUIVI pour cohérence (même bucket que bid_category=elabo_suivi)
  // — le validator filtre ELABO_SUIVI en amont (cf validateScenario).
  if (item.kind === 'sim'
   || item.kind === 'instr'
   || item.kind === 'sol'
   || item.kind === 'medical'
   || item.kind === 'autre')    return 'ELABO_SUIVI';
  if (item.kind === 'flight') {
    if (item.bid_category === 'vol_p')       return 'VOL_P';
    if (item.bid_category === 'elabo_suivi') return 'ELABO_SUIVI';
    return 'DDA_VOL';
  }
  return null;
}

function evaluateBucket(bucket: GapBucket, gap: number): 'OK' | 'X' {
  if (bucket.ok.includes(gap))        return 'OK';
  if (gap >= bucket.min_ok_above)     return 'OK';
  if (bucket.forbidden.includes(gap)) return 'X';
  // Gap négatif (chevauchement non couvert par les règles) ou hors zone — par
  // défaut on considère OK pour ne pas crier sur des cas non spécifiés.
  return 'OK';
}

// ─── Violation type ──────────────────────────────────────────────────────────

export type Violation = {
  scenario_id: string;
  scenario_name: string;
  item_a_id: string;
  item_b_id: string;
  cat_a: DdaCategory;
  cat_b: DdaCategory;
  gap_days: number;
  rpc_days?: number;
  /** 1er jour de la fenêtre interdite (= refFrom + 1, exprime le démarrage
   *  du gap mesuré par la règle ; exclut RPC pour les règles rpc_last_day,
   *  exclut juste end pour les règles 'end'/'rpc_first_day'). Sert au rendu
   *  visuel : la bande couvre [pivot_date, b_start_date - 1] = gap_days j. */
  pivot_date: string;
  /** Date de début de l'item B — pour clipper le rendu de l'overlay. */
  b_start_date: string;
  rule_label: string;
  /** Vrai si DDA_VOL → CONGES avec gap_no_rpc ∈ {0,1} : option de report RPC. */
  can_accept_rpc_report?: boolean;
};

// ─── Core validator ──────────────────────────────────────────────────────────

function findRule(rules: DdaRule[], from: DdaCategory, to: DdaCategory): DdaRule | null {
  return rules.find(r => r.from === from && r.to === to) ?? null;
}

function ruleLabel(rule: DdaRule, gap: number, rpc?: number): string {
  const rpcStr = rule.rpc_dependent && rpc != null ? ` (RPC ${rpc}j)` : '';
  return `${rule.from} → ${rule.to}${rpcStr} : gap ${gap}j`;
}

/**
 * Valide les enchaînements d'un scénario.
 *
 * @param items - items du scénario (déjà triés par start_date ou non)
 * @param rules - règles combinées (dda_rules + vol_p_rules)
 * @param scenarioId, scenarioName - identification du scénario pour le retour
 * @param acceptedRpcReports - set d'IDs de vols pour lesquels le report de RPC
 *   à la fin des CONGES suivants est accepté.
 */
export function validateScenario(
  items: CalendarItem[],
  rules: DdaRule[],
  scenarioId: string,
  scenarioName: string,
  acceptedRpcReports: ReadonlySet<string> = new Set(),
): Violation[] {
  // On garde TOUS les items à catégorie connue (y compris ELABO_SUIVI) dans
  // l'ordre chronologique : un item ELABO_SUIVI (medical/sol/autre/sim/instr
  // ou vol elabo_suivi) qui tombe entre A et B casse la chaîne — on ne compare
  // pas A↔B directement (et aucune règle ne s'applique à un pair impliquant
  // ELABO_SUIVI).
  // CSS et TAF restent bucketés en CONGES, donc validés normalement.
  // Les spillovers (vols partis en M-1 et arrivant en M) SONT inclus : ils
  // peuvent former la 1ère moitié d'une violation cross-mois avec un item de M
  // (typique : JNB du 31/07 au 03/08 suivi d'un DDA REPOS le 08/08, le 1er
  // poseur est un spillover en vue M). Les paires both-spillover sont
  // skippées plus bas (déjà validées dans la vue de M-1).
  const sorted = [...items]
    // Pause-spillovers (M-1 conges/TAF inclus uniquement comme contexte RPC)
    // ne participent jamais à la validation DDA — ils auraient déjà été pris
    // en compte dans la vue M-1.
    .filter(it => !it._isPauseSpillover)
    .filter(it => categoryOf(it) !== null)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  const violations: Violation[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];

    // Paire entièrement issue de M-1 → déjà validée dans la vue M-1.
    if (a._isSpillover && b._isSpillover) continue;

    const catA = categoryOf(a);
    const catB = categoryOf(b);
    if (!catA || !catB) continue;
    // ELABO_SUIVI casse la chaîne : ni A ni B ne peut être ELABO_SUIVI.
    if (catA === 'ELABO_SUIVI' || catB === 'ELABO_SUIVI') continue;

    const rule = findRule(rules, catA, catB);
    if (!rule) continue;

    const fromDay = refFrom(a, rule.gap_from);
    const toDay   = refTo(b);
    const gap     = diffDays(toDay, fromDay) - 1;

    let bucket: GapBucket;
    let rpcDays: number | undefined;
    if (rule.rpc_dependent) {
      rpcDays = rpcDaysOf(a);
      const key = String(Math.max(1, Math.min(3, rpcDays))) as '1' | '2' | '3';
      bucket = rule.rpc[key];
    } else {
      bucket = { ok: rule.ok, forbidden: rule.forbidden, min_ok_above: rule.min_ok_above };
    }

    const verdict = evaluateBucket(bucket, gap);
    if (verdict === 'X') {
      // Cas spécial DDA VOL → CONGES : option de report du RPC.
      let canAcceptRpcReport = false;
      if (
        !rule.rpc_dependent && rule.rpc_report_alt &&
        catA === 'DDA_VOL' && catB === 'CONGES'
      ) {
        const altFrom = refFrom(a, rule.rpc_report_alt.gap_from);
        const altTo   = refTo(b);
        const altGap  = diffDays(altTo, altFrom) - 1;
        const altBucket: GapBucket = {
          ok: rule.rpc_report_alt.ok ?? [],
          forbidden: rule.rpc_report_alt.forbidden ?? [],
          min_ok_above: rule.rpc_report_alt.min_ok_above ?? Number.POSITIVE_INFINITY,
        };
        canAcceptRpcReport = evaluateBucket(altBucket, altGap) === 'OK';
        if (canAcceptRpcReport && acceptedRpcReports.has(a.id)) {
          continue; // utilisateur a déjà acquitté → on n'émet pas la violation
        }
      }

      violations.push({
        scenario_id: scenarioId,
        scenario_name: scenarioName,
        item_a_id: a.id,
        item_b_id: b.id,
        cat_a: catA,
        cat_b: catB,
        gap_days: gap,
        rpc_days: rpcDays,
        pivot_date: addDays(fromDay, 1),
        b_start_date: b.start_date,
        rule_label: ruleLabel(rule, gap, rpcDays),
        can_accept_rpc_report: canAcceptRpcReport,
      });
    }
  }

  return violations;
}

/** Charge les règles depuis 2 lignes annexe_table (data jsonb). */
export function mergeRules(...rulesData: (DdaRulesData | undefined | null)[]): DdaRule[] {
  const out: DdaRule[] = [];
  for (const d of rulesData) {
    if (!d || !Array.isArray(d.rules)) continue;
    out.push(...d.rules);
  }
  return out;
}
