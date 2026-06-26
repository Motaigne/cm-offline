'use client';

import { useState, useEffect, useCallback, useTransition, useRef, useMemo, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  DndContext, DragOverlay, MouseSensor, TouchSensor,
  useSensor, useSensors, useDraggable,
  type DragStartEvent, type DragEndEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import {
  getScenariosWithItems,
  resetPlanningScenarios,
} from '@/app/actions/planning';
import { ACTIVITY_META, type ActivityKind, type BidCategory } from '@/lib/activity-meta';
import type { Scenario, CalendarItem } from '@/app/page';
import type { ScenarioName } from '@/app/actions/planning';
import type { Database } from '@/types/supabase';
import { SearchPanel } from './search-panel';
import { ScrapeDialog } from './scrape-dialog';
import { rotationValue, monthlyFinancialsP, PVEI, KSP, FIXE_MENSUEL, NB_30E, REGIME_NB30E } from '@/lib/finance';
import { computeArticle81, computeTSej24, getPlafondJours, TAXI_TSEJ_ADJUST_H } from '@/lib/article81';
import type { Article81Data } from '@/lib/article81';
import { createClient } from '@/lib/supabase/client';
import { hydrateDB, loadFromDB, hasPendingOps, loadScenariosForMonth, cacheRotations, purgeScenarios, hydrateNotes, loadNotesForMonth, loadRotationsFromDB } from '@/lib/local-db';
import { computePrimeNoel, computePrimeMai } from '@/lib/prime-mai-noel';
import type { RotationInstance, RotationSignature } from '@/app/actions/search';
import { enqueueAdd, enqueueDelete, enqueueUpdate, enqueueBidCategoryUpdate, enqueueMetaUpdate, pendingOpsCount, PENDING_CHANGED_EVENT } from '@/lib/sync-service';
import {
  validateScenario, mergeRules,
  type DdaRule, type DdaRulesData, type Violation, type DdaCategory,
} from '@/lib/dda-validator';
import { getRotationsForMonth } from '@/app/actions/search';
import { getCurrentUserScrapeRights } from '@/app/actions/auth';
import { computeA81CumulBeforeLocal } from '@/lib/a81-local';
import { computeFullProfile, getAnnexeDataFromRows, type AnnexeData, type AnnexeRow } from '@/lib/annexe';
import type { ProfileVersion } from '@/app/actions/profile-version';
import { computeMonthlyIrMfFromLocalCache } from '@/lib/ir-mf-local';
import { computeEffectiveRpc, hardBlockerWindow } from '@/lib/rpc';
import { enqueueAddNote, enqueueUpdateNote, enqueueDeleteNote } from '@/lib/sync-service';
import { listNotesForMonth, type UserNote } from '@/app/actions/notes';
import { NavBar } from '@/app/components/nav';
import { EmptyCacheBanner } from '@/app/components/empty-cache-banner';
import { MonthReleaseIcon } from '@/app/components/month-release-icon';
import { usePushSubscription } from '@/hooks/use-push-subscription';
import { useLocalStorageState } from '@/hooks/use-local-storage-state';

type RegimeEnum = Database['public']['Enums']['regime_enum'];

// ─── layout constants ────────────────────────────────────────────────────────

const LABEL_W = 96;
const DAY_H   = 44;
const ROW_H   = 180;
const BAR_H   = 52;

// ─── locale / calendar helpers ───────────────────────────────────────────────

const MONTH_FR  = ['Janvier','Février','Mars','Avril','Mai','Juin',
                   'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
const DAY_ABBR  = ['D','L','M','M','J','V','S']; // 0=Sun

function localStr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function addDays(dateStr: string, n: number) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localStr(d);
}
function shiftMonth(m: string, delta: number) {
  const [y, mo] = m.split('-').map(Number);
  return localStr(new Date(y, mo - 1 + delta, 1)).slice(0, 7);
}
function daysInMonth(y: number, mo: number) { return new Date(y, mo, 0).getDate(); }
function dayNum(dateStr: string) { return parseInt(dateStr.slice(8), 10); }
/** Décale une date YYYY-MM-DD de n jours (n négatif autorisé). */
function shiftDay(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Calcule la fenêtre interdite (left%, width%) d'une violation clippée au
 *  mois courant. Renvoie null si la fenêtre est hors mois ou vide. */
function clipViolationGap(pivot: string, bStart: string, y: number, mo: number):
  { left: number; width: number } | null {
  const dim = daysInMonth(y, mo);
  const prefix = `${y}-${String(mo).padStart(2, '0')}`;
  const monthStartStr = `${prefix}-01`;
  const monthEndStr   = `${prefix}-${String(dim).padStart(2, '0')}`;
  const endStr = shiftDay(bStart, -1);
  if (endStr < monthStartStr) return null;
  if (pivot   > monthEndStr)  return null;
  const startStr = pivot < monthStartStr ? monthStartStr : pivot;
  const clippedEnd = endStr > monthEndStr ? monthEndStr : endStr;
  if (startStr > clippedEnd) return null;
  const startDay = dayNum(startStr);
  const endDay   = dayNum(clippedEnd);
  return {
    left:  ((startDay - 1) / dim) * 100,
    width: ((endDay - startDay + 1) / dim) * 100,
  };
}
function isWeekend(y: number, mo: number, d: number) {
  const dow = new Date(y, mo - 1, d).getDay();
  return dow === 0 || dow === 6;
}

// ─── regime helpers ──────────────────────────────────────────────────────────

function getTafDuration(regime: RegimeEnum): number {
  if (regime.startsWith('TAF7'))  return 7;
  if (regime.startsWith('TAF10')) return 10;
  return 0;
}

function isTafAvailable(regime: RegimeEnum, month: string): boolean {
  const mo = parseInt(month.slice(5), 10);
  if (regime === 'TAF7_10_12' || regime === 'TAF10_10_12') return mo !== 7 && mo !== 8;
  if (regime === 'TAF7_12_12'  || regime === 'TAF10_12_12') return true;
  return false;
}

// TAF*_10_12 : en juillet/août le pilote est off, mais A330 et Instruction
// passent à 100% (× 30/nb30e) au lieu de la proration mensuelle habituelle.
function isFullPrimeMonth(regime: RegimeEnum, mo: number): boolean {
  if (regime === 'TAF7_10_12' || regime === 'TAF10_10_12') return mo === 7 || mo === 8;
  return false;
}

// ─── overlap detection ───────────────────────────────────────────────────────

function hasOverlap(
  items: CalendarItem[],
  start: string, end: string,
  excludeId?: string,
): boolean {
  return items.some(i => {
    if (i.id === excludeId) return false;
    return i.start_date <= end && i.end_date >= start;
  });
}

// ─── sub-day fractional position (returns day-of-month + hour fraction) ─────

function dayFrac(isoStr: string, y: number, mo: number, dim: number): number {
  const d = new Date(isoStr);
  const dY = d.getUTCFullYear(), dM = d.getUTCMonth() + 1, dD = d.getUTCDate();
  if (dY < y || (dY === y && dM < mo)) return 1;
  if (dY > y || (dY === y && dM > mo)) return dim + 1;
  return dD + (d.getUTCHours() + d.getUTCMinutes() / 60) / 24;
}

// ─── clip activity to current month ─────────────────────────────────────────

function clipItem(item: CalendarItem, y: number, mo: number) {
  const prefix = `${y}-${String(mo).padStart(2,'0')}`;
  // Pause-spillover : contexte de calcul RPC uniquement, jamais rendu.
  if (item._isPauseSpillover) return null;
  // RPC-only spillover : corps en M-1, RPC étendu en M. Clip synthétique pour
  // déclencher DraggableBar (qui ne rendra que les barres post-RPC).
  if (item._rpcOnlySpillover) return { start: 1, end: 1 };
  if (item.end_date.slice(0,7) < prefix || item.start_date.slice(0,7) > prefix) return null;
  const dim = daysInMonth(y, mo);
  const start = item.start_date.slice(0,7) < prefix ? 1 : dayNum(item.start_date);
  const end   = item.end_date.slice(0,7)   > prefix ? dim : dayNum(item.end_date);
  return { start, end };
}

// ─── prorata table (DDA OFF) ─────────────────────────────────────────────────

type ProrataThreshold = { range: string; ji_restants: number; duree_min: number; duree_min_opt6: number };

function lookupJI(n: number, thresholds: ProrataThreshold[]): number {
  for (const t of thresholds) {
    if (t.range.startsWith('>')) {
      if (n > parseInt(t.range.slice(1))) return t.ji_restants;
    } else {
      const [lo, hi] = t.range.split('-').map(Number);
      if (n >= lo && n <= hi) return t.ji_restants;
    }
  }
  return 0;
}

/** DDA repos max (= duree_min_opt6) pour un nb de jours de prorata donné.
 *  Même résolution de plage que lookupJI. */
function lookupDureeMax(n: number, thresholds: ProrataThreshold[]): number {
  for (const t of thresholds) {
    if (t.range.startsWith('>')) {
      if (n > parseInt(t.range.slice(1))) return t.duree_min_opt6;
    } else {
      const [lo, hi] = t.range.split('-').map(Number);
      if (n >= lo && n <= hi) return t.duree_min_opt6;
    }
  }
  return 0;
}

// Fallback local des seuils prorata (= valeurs annexe slug='prorata'). Garantit
// un calcul DDA repos 100 % offline même si l'annexe n'est pas encore hydratée
// dans IndexedDB (1er boot hors-ligne). Seuls ji_restants / duree_min_opt6 sont
// consommés par le calcul du max ; duree_min n'y intervient pas.
const PRORATA_FALLBACK: ProrataThreshold[] = [
  { range: '0-2',   ji_restants: 11, duree_min: 0, duree_min_opt6: 6 },
  { range: '3-4',   ji_restants: 10, duree_min: 0, duree_min_opt6: 6 },
  { range: '5-7',   ji_restants: 9,  duree_min: 0, duree_min_opt6: 6 },
  { range: '8-9',   ji_restants: 8,  duree_min: 0, duree_min_opt6: 5 },
  { range: '10-12', ji_restants: 7,  duree_min: 0, duree_min_opt6: 5 },
  { range: '13-14', ji_restants: 6,  duree_min: 0, duree_min_opt6: 4 },
  { range: '15-17', ji_restants: 5,  duree_min: 0, duree_min_opt6: 4 },
  { range: '18-19', ji_restants: 4,  duree_min: 0, duree_min_opt6: 3 },
  { range: '20-22', ji_restants: 3,  duree_min: 0, duree_min_opt6: 2 },
  { range: '23-24', ji_restants: 2,  duree_min: 0, duree_min_opt6: 2 },
  { range: '25-27', ji_restants: 1,  duree_min: 0, duree_min_opt6: 1 },
  { range: '>27',   ji_restants: 0,  duree_min: 0, duree_min_opt6: 0 },
];

// ─── prorata mois (rotations à cheval) ───────────────────────────────────────

// Activités qui comptent pour l'Indemnité Transport (IT) :
// vol AR, sol/réserve, visite médicale, simulateur, autre. Pas conge / off.
const IT_ACTIVITY_KINDS: ReadonlySet<ActivityKind> = new Set(['flight', 'sol', 'medical', 'sim', 'autre']);

/** Nombre d'activités (au sens IT) visibles sur un mois donné. Item à cheval
 *  (start_date dans mois M, end_date dans mois M±1) = 0.5 sur chaque mois. */
function countItActivities(items: CalendarItem[], year: number, mo: number): number {
  const monthStr = `${year}-${String(mo).padStart(2, '0')}`;
  let n = 0;
  for (const item of items) {
    if (!IT_ACTIVITY_KINDS.has(item.kind)) continue;
    if (!clipItem(item, year, mo)) continue;
    const startInMonth = item.start_date.slice(0, 7) === monthStr;
    const endInMonth   = item.end_date.slice(0, 7) === monthStr;
    n += (startInMonth && endInMonth) ? 1 : 0.5;
  }
  return n;
}

/** IT mensuelle selon le mode profil. Navigo = forfait (0 si aucune activité). */
function computeItEur(
  transport: string | null,
  nbActivites: number,
  navigoEur: number,
  voitureKmAller: number,
  voitureIndemniteKm: number,
): number {
  if (transport === 'Navigo')  return nbActivites > 0 ? navigoEur : 0;
  if (transport === 'Voiture') return nbActivites * 2 * voitureKmAller * voitureIndemniteKm;
  return 0;
}

function prorateForMonth(val: number, departAt: string, arriveeAt: string, year: number, mo: number): number {
  const monthStart = Date.UTC(year, mo - 1, 1);
  const monthEnd   = Date.UTC(year, mo,     1);
  const dep = new Date(departAt).getTime();
  const arr = new Date(arriveeAt).getTime();
  if (arr <= dep) return val;
  const ratio = Math.max(0, (Math.min(arr, monthEnd) - Math.max(dep, monthStart)) / (arr - dep));
  return Math.round(val * ratio * 100) / 100;
}

// ─── stats + financials ──────────────────────────────────────────────────────

function computeStats(
  items: CalendarItem[],
  year: number,
  mo: number,
  cngPv = 0,
  cngHs = 0,
  regime: RegimeEnum = 'TAF7_10_12',
  monthlyFixedPrimes = 0,
  article81Data: Article81Data | null = null,
  valeurJour = 600,
  a81CumulBefore = 0,
  irMfEur = 0,
  itEur = 0,
  // Éléments de paie issus de l'annexe (version applicable au mois M). Si non
  // fournis → fallback aux constantes legacy de lib/finance.
  pvei = PVEI,
  ksp = KSP,
  fixeRegime = FIXE_MENSUEL,   // fixe proratisé selon nb30e du régime
  fixeTPArg: number | null = null,    // fixe TP (nb30e=30) ; si null → calculé via FIXE_MENSUEL * 30 / nb30eRegime
) {
  let onDays = 0, congeDays = 0, cssDays = 0;
  const flights = items.filter(i => i.kind === 'flight').length;
  let totalHcr = 0, totalHc = 0, totalPrime = 0, totalTsvNuit = 0;
  // HCr forfaitaires hors-vol : activités sol (réserve, visite méd., autre) =
  // 4 HCr/jour ; simulateur = 5 HCr/jour. Contribuent à PV via totalHcr.
  let solDays = 0, simDays = 0;
  // 1ère passe : agrégats simples sur les non-flights + collect des flights pour A81
  const flightItems: CalendarItem[] = [];
  /** Décomposition par vol pour le panneau détail : PV ventilé HCr / PVnuit. */
  const flightBreakdown: { destination: string; hcrEur: number; pvNuitEur: number; instanceId: string | null }[] = [];
  for (const item of items) {
    // RPC-only spillover : corps + tSej + HCr déjà comptés en M-1. En M, seul le
    // bandeau RPC est dessiné (DraggableBar). Surtout pas de +1 onDays, ni de
    // push dans flightBreakdown (sinon ICN fantôme à 0€ + compteur ON faussé).
    if (item._rpcOnlySpillover) continue;
    const clip = clipItem(item, year, mo);
    if (clip) {
      const days = clip.end - clip.start + 1;
      if (item.kind === 'flight' || item.kind === 'sol' || item.kind === 'medical' || item.kind === 'sim' || item.kind === 'instr') onDays += days;
      if (item.kind === 'conge')    congeDays += days;
      if (item.kind === 'conge_ss') cssDays   += days;
      if (item.kind === 'sol' || item.kind === 'medical' || item.kind === 'autre') solDays += days;
      if (item.kind === 'sim') simDays += days;
    }
    if (item.kind !== 'flight') continue;
    flightItems.push(item);
    const m = item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta)
      ? item.meta as Record<string, unknown> : null;
    if (!m) continue;
    const departAt  = typeof m.depart_at  === 'string' ? m.depart_at  as string : null;
    const arriveeAt = typeof m.arrivee_at === 'string' ? m.arrivee_at as string : null;
    let hcr     = typeof m.hcr_crew === 'number' ? m.hcr_crew  as number : 0;
    let hc      = typeof m.hc       === 'number' ? m.hc        as number : 0;
    let tsvNuit = typeof m.tsv_nuit === 'number' ? m.tsv_nuit  as number : 0;
    if (departAt && arriveeAt) {
      hcr     = prorateForMonth(hcr,     departAt, arriveeAt, year, mo);
      hc      = prorateForMonth(hc,      departAt, arriveeAt, year, mo);
      tsvNuit = prorateForMonth(tsvNuit, departAt, arriveeAt, year, mo);
    }
    totalHcr     += hcr;
    totalHc      += hc;
    totalPrime   += typeof m.prime === 'number' ? (m.prime as number) : 0;
    totalTsvNuit += tsvNuit;
    flightBreakdown.push({
      destination: typeof m.destination === 'string' ? m.destination as string : '?',
      hcrEur:      hcr * pvei * ksp,
      pvNuitEur:   (tsvNuit / 2) * pvei * ksp,
      instanceId:  item.pairing_instance_id ?? null,
    });
  }

  // Cumul forfaitaire sol + sim — comptés à la fois en HCr (→ PV) et en HC
  // (→ seuil HS). sol = 4/j (réserve+méd+autre), sim = 5/j.
  const solHcr    = solDays * 4;
  const simHcr    = simDays * 5;
  const solHcrEur = solHcr * pvei * ksp;
  const simHcrEur = simHcr * pvei * ksp;
  totalHcr += solHcr + simHcr;
  totalHc  += solHcr + simHcr;

  // 2e passe : Article 81 avec plafond annuel — sort chronologique pour appliquer
  // le cap "tant que cumulJours ≤ plafond". Cumul = tSej24 entier de la rotation
  // (pas proratisé), montant = montantPrimeSej proratisé au mois.
  //
  // Les spillovers (rotations parties en M-1 visibles en M) sont EXCLUS : leur
  // tSej24 entier est déjà comptabilisé dans le mois de départ (M-1), et
  // a81CumulBefore les inclut déjà — sinon double-comptage qui fait monter le
  // cumul affiché en M puis "redescendre" au mois M+1 (qui voit la cumul réelle
  // sans le doublon).
  const plafondJours = getPlafondJours(regime);
  let cumulJoursRunning = a81CumulBefore;
  let totalA81 = 0;
  const sortedFlights = [...flightItems]
    .filter(f => !f._isSpillover)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  for (const item of sortedFlights) {
    const m = item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta)
      ? item.meta as Record<string, unknown> : null;
    if (!m) continue;
    const tempsSej = typeof m.temps_sej === 'number' ? m.temps_sej as number : null;
    const zone     = typeof m.zone      === 'string' ? m.zone      as string : null;
    if (tempsSej == null || !zone) continue;

    // m.temps_sej = block-to-block (scraper, sans taxi). Compensation pour
    // approximer l'atterrissage/décollage réels — cf TAXI_TSEJ_ADJUST_H.
    const tempsSejAdj = tempsSej + TAXI_TSEJ_ADJUST_H;
    const tSej24 = computeTSej24(tempsSejAdj);
    if (tSej24 === 0) continue; // < 24h → pas Article 81

    // Plafond : si on dépasse, on n'ajoute pas le montant de cette rotation
    if (cumulJoursRunning >= plafondJours) continue;
    cumulJoursRunning += tSej24;

    const a81 = computeArticle81({ tSej: tempsSejAdj, zone, valeurJour, data: article81Data });
    const departAt  = typeof m.depart_at  === 'string' ? m.depart_at  as string : null;
    const arriveeAt = typeof m.arrivee_at === 'string' ? m.arrivee_at as string : null;
    const montant = (departAt && arriveeAt)
      ? prorateForMonth(a81.montantPrimeSej, departAt, arriveeAt, year, mo)
      : a81.montantPrimeSej;
    totalA81 += montant;
  }
  const totalA81Net = totalA81 * 0.82;
  // nb30eEff = nb30eR − CSS − congés classiques. Seul MGA (et hsSeuil, par
  // construction dans monthlyFinancialsP) dépendent de nb30eEff. Le fixe et
  // les primes (A330, Instruction) ne sont PAS abattus par CSS ni congés.
  const nb30eRegime = REGIME_NB30E[regime] ?? NB_30E;
  const fullPrime   = isFullPrimeMonth(regime, mo);
  const nb30eR      = fullPrime ? 30 : nb30eRegime;
  const nb30eEff    = Math.max(0, nb30eR - cssDays - congeDays);
  // En jul/août pour TAF*_10_12 (full-prime month) : on bascule sur le fixe TP.
  // fixeTPArg fourni par le caller (depuis l'annexe versionnée) ; sinon legacy
  // = FIXE_MENSUEL * 30 / nb30eRegime.
  const fixeTPVal   = fixeTPArg ?? (nb30eRegime > 0 ? FIXE_MENSUEL * 30 / nb30eRegime : FIXE_MENSUEL);
  const fixeForFin  = fullPrime ? fixeTPVal : fixeRegime;
  // Calcul mensuel complet : HS (fixe + vol), MGA, DIF, total — cf finance.ts.
  // total = fixe + pv + hs + dif (hors primes — primes mensuelles fixes ajoutées
  // dans le brut plus bas via primesTotal).
  const finBase = monthlyFinancialsP(totalHcr, totalHc, totalPrime, totalTsvNuit, { pvei, ksp, fixe: fixeForFin, nb30e: nb30eEff });
  // PRIME = bi-tronçon (sommée par vol via finBase.primes) + primes mensuelles
  // fixes (incit + A330 + instruction + Mai + Noël). monthlyFixedPrimes est calculé
  // en amont avec proration régime + boost 100% en juillet/août pour TAF*_10_12.
  const primesTotal = finBase.primes + monthlyFixedPrimes;
  const congeAmount = congeDays * (cngPv + cngHs);
  // BRUT : plancher MGA déjà appliqué via DIF dans finBase.total → addition simple.
  // IT (Indemnité Transport) ajoutée comme IR/MF — calculée en amont par le caller
  // selon profil.transport (Navigo = forfait mensuel ; Voiture = nbActivités × 2
  // × km_aller × indemnité_km, vol à cheval = 0.5/mois).
  const brut = finBase.total + congeAmount + primesTotal + irMfEur + itEur;
  const fin = {
    ...finBase,
    primes: primesTotal,  // remplace les primes bi-tronçon par le total (bi-tronçon + fixes mensuelles)
  };
  return {
    flights, onDays, congeDays, cssDays, totalHcr, totalHc, totalPrime, totalTsvNuit,
    fin, congeAmount, brut,
    totalA81, totalA81Net, cumulJoursRunning, plafondJours,
    hsH: finBase.hsH, hsFixeRate: finBase.hsFixeRate, hsVolRate: finBase.hsVolRate, hsSeuil: finBase.hsSeuil,
    flightBreakdown,
    solDays, simDays, solHcrEur, simHcrEur,
    nb30eEff,
  };
}

// ─── PrimePicker (popover compact pour sélecteur prime d'incitation / IrgAv) ─

function PrimePicker({
  label, title, value, range, onChange, open, onToggle, onClose,
}: {
  label: string;
  title: string;
  value: number;
  range: number[];
  onChange: (n: number) => void;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  // Position absolue (viewport) du popover, mesurée à l'ouverture. Évite le
  // clipping par les conteneurs overflow-x-auto au-dessus de la barre.
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  useEffect(() => {
    if (!open || !btnRef.current) { setPos(null); return; }
    const r = btnRef.current.getBoundingClientRect();
    setPos({ left: r.left, bottom: window.innerHeight - r.top + 4 });
  }, [open]);

  return (
    <div className="flex-shrink-0">
      <button
        ref={btnRef}
        type="button"
        onClick={onToggle}
        title={title}
        className={[
          'h-7 px-2.5 inline-flex items-center gap-1.5 rounded-full text-xs font-semibold border-2 transition-all',
          value > 0
            ? 'border-zinc-800 dark:border-zinc-100 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
            : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:border-zinc-400',
        ].join(' ')}
      >
        <span className="text-[10px] uppercase tracking-wide opacity-80">{label}</span>
        <span className="font-mono">{value}</span>
      </button>
      {open && pos && (
        <>
          <div className="fixed inset-0 z-[100]" onClick={onClose} />
          <div
            className="fixed z-[101] p-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg"
            style={{ left: pos.left, bottom: pos.bottom }}
          >
            <p className="text-[10px] text-zinc-400 uppercase tracking-wide mb-1 whitespace-nowrap">{title}</p>
            <div className="flex items-center gap-1">
              {range.map(n => (
                <button
                  key={n}
                  type="button"
                  onClick={() => { onChange(n); onClose(); }}
                  className={[
                    'w-7 h-7 rounded-full text-xs font-semibold border-2 transition-all',
                    value === n
                      ? 'border-zinc-800 dark:border-zinc-100 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
                      : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:border-zinc-400',
                  ].join(' ')}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── FinRow ──────────────────────────────────────────────────────────────────

function FinRow({ label, value, cls, bold }: { label: string; value: number; cls: string; bold?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-0.5">
      <span className={`text-[7.5px] font-mono leading-none ${cls} opacity-70`}>{label}</span>
      <span className={`text-[8.5px] font-mono leading-none ${cls} ${bold ? 'font-bold' : ''}`}>
        {Math.round(value)}
      </span>
    </div>
  );
}

// ─── DraggableBar ────────────────────────────────────────────────────────────

const REST_H = 6;

function DraggableBar({
  item, clip, dim, year, mo, onEdit, isDragSource,
  scenarioItems, rpcChevauchement, isFictive = false,
  pvei = PVEI, ksp = KSP, hasMep = false,
}: {
  item: CalendarItem;
  clip: { start: number; end: number };
  dim: number;
  year: number;
  mo: number;
  onEdit: (item: CalendarItem) => void;
  isDragSource: boolean;
  /** Tous les items du scénario — nécessaire pour calculer l'effective RPC
   *  (interactions avec congés/TAF/sol/etc.). */
  scenarioItems: CalendarItem[];
  /** Mode RPC : true = pauses dans congés/TAF, false = report total après. */
  rpcChevauchement: boolean;
  /** True si l'item est sur un mois de projection (snapshot fictif) →
   *  override de la couleur du bar en violet clair. */
  isFictive?: boolean;
  /** Valeurs profil-aware pour `rotationValue` — sinon défaut aux constantes
   *  (search panel n'a pas le profil). Ici on a accès au profil donc on les
   *  passe pour aligner la valeur affichée sur la bar avec le popup/détail. */
  pvei?: number;
  ksp?: number;
  /** True si la rotation comporte au moins une MEP (sig.dead_head). Rend un
   *  bandeau magenta translucide en haut du bloc, par-dessus tout. */
  hasMep?: boolean;
}) {
  const readOnly = !!item._isSpillover;
  // RPC-only spillover : vol dont le corps est en M-1 et dont la queue RPC
  // (mode chevauchement) atteint M. On ne dessine que les barres post-RPC.
  const isRpcOnly = !!item._rpcOnlySpillover;
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: item.id,
    data: { item, clip },
    disabled: readOnly,
  });

  const actMeta = ACTIVITY_META[item.kind];
  const metaObj = item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta)
    ? item.meta as Record<string, unknown>
    : null;
  const label = item.kind === 'flight' && metaObj?.destination
    ? String(metaObj.destination)
    : actMeta.label;

  const hcrCrew      = typeof metaObj?.hcr_crew      === 'number' ? metaObj.hcr_crew      as number : null;
  const prime        = typeof metaObj?.prime         === 'number' ? metaObj.prime         as number : 0;
  const restBeforeH  = typeof metaObj?.rest_before_h === 'number' ? metaObj.rest_before_h as number : 0;
  const departAt     = typeof metaObj?.depart_at     === 'string' ? metaObj.depart_at     as string : null;
  const arriveeAt    = typeof metaObj?.arrivee_at    === 'string' ? metaObj.arrivee_at    as string : null;
  const beginActAt   = typeof metaObj?.scheduled_begin_activity_at === 'string' ? metaObj.scheduled_begin_activity_at as string : null;
  const tsvNuit      = typeof metaObj?.tsv_nuit === 'number' ? metaObj.tsv_nuit as number : 0;

  const hcrDisplay = hcrCrew !== null && departAt && arriveeAt
    ? prorateForMonth(hcrCrew, departAt, arriveeAt, year, mo)
    : hcrCrew;
  const tsvDisplay = departAt && arriveeAt
    ? prorateForMonth(tsvNuit, departAt, arriveeAt, year, mo)
    : tsvNuit;
  const isProrated = hcrDisplay !== null && hcrCrew !== null && hcrDisplay < hcrCrew - 0.01;
  const euroVal    = item.kind === 'flight' && hcrDisplay !== null
    ? rotationValue(hcrDisplay, prime, tsvDisplay, pvei, ksp) : null;

  // Sub-day precision for flights with timestamps, integer days for others
  let leftPct: number, wPct: number;
  let restBeforeBar: { left: number; width: number } | null = null;
  const restBeforeHardBars: { left: number; width: number }[] = [];
  // Post-RPC : N segments solides + M pauses (mode chevauchement).
  // En mode OFF, 1 segment d'origine + hasRpcConflict = true si un jour
  // entier de congé/TAF est dans le RPC (déclenche le flag visuel).
  const restAfterSegments: { left: number; width: number }[] = [];
  const restAfterPauses:   { left: number; width: number }[] = [];
  const restAfterHardBars: { left: number; width: number }[] = [];
  let hasRpcConflict = false;
  let hasHardConflict = false;

  // Helper utilisé pour convertir un intervalle UTC ms en barre relative au mois.
  const segToBar = (startMs: number, endMs: number): { left: number; width: number } | null => {
    const sFrac = dayFrac(new Date(startMs).toISOString(), year, mo, dim);
    const eFrac = dayFrac(new Date(endMs).toISOString(),   year, mo, dim);
    const sClamped = Math.max(sFrac, 1);
    const eClamped = Math.min(eFrac, dim + 1);
    if (eClamped <= sClamped) return null;
    const sLeft  = (sClamped - 1) / dim * 100;
    const sWidth = (eClamped - sClamped) / dim * 100;
    if (sWidth < 0.05) return null;
    return { left: sLeft, width: sWidth };
  };

  if (item.kind === 'flight' && departAt && arriveeAt) {
    if (isRpcOnly) {
      // Corps + pré-repos en M-1 : non rendus en M.
      leftPct = 0;
      wPct = 0;
    } else {
      const startFrac = dayFrac(departAt,  year, mo, dim);
      const endFrac   = dayFrac(arriveeAt, year, mo, dim);
      leftPct = Math.max(0, (startFrac - 1) / dim * 100);
      wPct    = Math.max(0.3, (Math.min(endFrac, dim + 1) - Math.max(startFrac, 1)) / dim * 100);

      // Barre pré-activité : du début d'activité (briefing) jusqu'au block-off.
      // Source de vérité : scheduled_begin_activity_at ; fallback sur rest_before_h
      // (durée en heures, soustraite du block-off) si pas de timestamp.
      const preStartIso = beginActAt
        ?? (restBeforeH > 0 ? new Date(new Date(departAt).getTime() - restBeforeH * 3_600_000).toISOString() : null);
      if (preStartIso) {
        const rFrac = dayFrac(preStartIso, year, mo, dim);
        const rLeft = Math.max(0, (rFrac - 1) / dim * 100);
        const rW    = leftPct - rLeft;
        if (rW > 0.05) restBeforeBar = { left: rLeft, width: rW };
        // Chevauchement éventuel avec une fenêtre hard blocker → bandes rouges.
        const preStartMs = new Date(preStartIso).getTime();
        const departMs   = new Date(departAt).getTime();
        for (const other of scenarioItems) {
          if (other.id === item.id) continue;
          const w = hardBlockerWindow(other);
          if (!w) continue;
          const a = Math.max(preStartMs, w.startMs);
          const b = Math.min(departMs,   w.endMs);
          if (b > a) {
            const bar = segToBar(a, b);
            if (bar) restBeforeHardBars.push(bar);
          }
        }
      }
    }

    // Barres post-RPC : computeEffectiveRpc tient compte des congés/TAF
    // (selon mode chevauchement) et expose les segments hardConflict (rouges)
    // pour les portions chevauchant une fenêtre sol/medical/autre/sim/instr.
    const eff = computeEffectiveRpc(item, scenarioItems, rpcChevauchement);
    for (const seg of eff.segments) {
      const bar = segToBar(seg.startMs, seg.endMs);
      if (bar) restAfterSegments.push(bar);
    }
    for (const p of eff.pauseIntervals) {
      const bar = segToBar(p.startMs, p.endMs);
      if (bar) restAfterPauses.push(bar);
    }
    for (const hc of eff.hardConflict) {
      const bar = segToBar(hc.startMs, hc.endMs);
      if (bar) restAfterHardBars.push(bar);
    }
    hasRpcConflict  = eff.hasConflict && !rpcChevauchement;
    hasHardConflict = eff.hardConflict.length > 0 || restBeforeHardBars.length > 0;
  } else if ((item.kind === 'sol' || item.kind === 'medical' || item.kind === 'autre')) {
    // 8h-18h Paris : fenêtre temporelle au sein du jour (au lieu du jour entier).
    const w = hardBlockerWindow(item);
    if (w) {
      const sFrac = dayFrac(new Date(w.startMs).toISOString(), year, mo, dim);
      const eFrac = dayFrac(new Date(w.endMs).toISOString(),   year, mo, dim);
      const sClamped = Math.max(sFrac, 1);
      const eClamped = Math.min(eFrac, dim + 1);
      leftPct = Math.max(0, (sClamped - 1) / dim * 100);
      wPct    = Math.max(0.3, (eClamped - sClamped) / dim * 100);
    } else {
      const span = clip.end - clip.start + 1;
      leftPct = ((clip.start - 1) / dim) * 100;
      wPct    = (span / dim) * 100;
    }
  } else {
    const span = clip.end - clip.start + 1;
    leftPct = ((clip.start - 1) / dim) * 100;
    wPct    = (span / dim) * 100;
  }

  const restTop = `calc(50% - ${REST_H / 2}px)`;

  return (
    <>
      {/* Pre-repos bar */}
      {restBeforeBar && (
        <div
          className="absolute pointer-events-none rounded-l-sm z-[11]"
          style={{
            left: `${restBeforeBar.left}%`,
            width: `${restBeforeBar.width}%`,
            top: restTop,
            height: REST_H,
            backgroundColor: '#93C5FD',
            opacity: isDragSource ? 0.2 : 0.65,
          }}
        />
      )}
      {/* Overlay rouge sur la portion du repos pré-courrier qui chevauche un
          hard blocker (sol/medical/autre 8h-18h, sim/instr jour entier). */}
      {restBeforeHardBars.map((seg, i) => (
        <div
          key={`rest-before-hard-${i}`}
          className="absolute pointer-events-none z-[12] rounded-sm"
          style={{
            left: `${seg.left}%`,
            width: `${seg.width}%`,
            top: restTop,
            height: REST_H,
            backgroundColor: '#DC2626',
            opacity: isDragSource ? 0.3 : 0.85,
          }}
        />
      ))}

      {/* Post-repos : N segments solides (pleins) + M pauses (pointillés
          au-dessus des congés/TAF traversés en mode chevauchement).
          En mode OFF avec conflit (un jour entier de congé/TAF dans le RPC),
          on tint en ambre + ajoute une badge ⚠ pour signaler le conflit. */}
      {restAfterSegments.map((seg, i) => (
        <div
          key={`rest-seg-${i}`}
          className="absolute pointer-events-none z-[11] rounded-sm"
          style={{
            left: `${seg.left}%`,
            width: `${seg.width}%`,
            top: restTop,
            height: REST_H,
            backgroundColor: hasRpcConflict ? '#F59E0B' : '#93C5FD',
            opacity: isDragSource ? 0.2 : 0.65,
          }}
        />
      ))}
      {restAfterPauses.map((seg, i) => (
        <div
          key={`rest-pause-${i}`}
          className="absolute pointer-events-none z-[11]"
          style={{
            left: `${seg.left}%`,
            width: `${seg.width}%`,
            top: restTop,
            height: REST_H,
            backgroundImage:
              'repeating-linear-gradient(90deg,#93C5FD 0,#93C5FD 4px,transparent 4px,transparent 8px)',
            opacity: isDragSource ? 0.15 : 0.5,
          }}
        />
      ))}
      {/* Overlay rouge sur la portion du RPC qui chevauche un hard blocker. */}
      {restAfterHardBars.map((seg, i) => (
        <div
          key={`rest-hard-${i}`}
          className="absolute pointer-events-none z-[12] rounded-sm"
          style={{
            left: `${seg.left}%`,
            width: `${seg.width}%`,
            top: restTop,
            height: REST_H,
            backgroundColor: '#DC2626',
            opacity: isDragSource ? 0.3 : 0.85,
          }}
        />
      ))}
      {hasRpcConflict && restAfterSegments.length > 0 && (
        <span
          className="absolute pointer-events-none z-[12] text-amber-500 text-[10px] font-bold leading-none"
          title="RPC en conflit avec un congé/TAF (jour entier). Active Chevauchement pour reporter le RPC, ou retire le congé."
          style={{
            left: `calc(${restAfterSegments[0].left}% - 2px)`,
            top: `calc(50% - ${REST_H / 2 + 8}px)`,
          }}
        >
          ⚠
        </span>
      )}
      {hasHardConflict && (restAfterHardBars.length > 0 || restBeforeHardBars.length > 0) && (
        <span
          className="absolute pointer-events-none z-[13] text-red-600 text-[10px] font-bold leading-none"
          title="Le RPC ou le repos pré-courrier chevauche une activité sol/médicale/sim/instruction. Vol autorisé, mais à signaler."
          style={{
            left: `calc(${(restAfterHardBars[0] ?? restBeforeHardBars[0]).left}% - 2px)`,
            top: `calc(50% - ${REST_H / 2 + 8}px)`,
          }}
        >
          ⚠
        </span>
      )}

      {/* Main bar — masquée si _rpcOnlySpillover (corps en M-1, seule la
          queue RPC est rendue en M). */}
      {!isRpcOnly && (
        <div
          ref={setNodeRef}
          style={{
            position: 'absolute',
            left: `${leftPct}%`,
            width: `${wPct}%`,
            top: '50%',
            marginTop: -(BAR_H / 2),
            height: BAR_H,
            // Projection : fond violet clair, sinon couleur kind standard.
            backgroundColor: isFictive ? '#DDD6FE' : actMeta.color,
            color: isFictive ? '#5B21B6' : actMeta.textColor,
            opacity: isDragSource ? 0.35 : (readOnly ? 0.7 : 1),
            zIndex: 10,
            transform: transform ? CSS.Translate.toString(transform) : undefined,
            cursor: readOnly ? 'default' : 'grab',
            touchAction: readOnly ? 'auto' : 'none',
            fontStyle: readOnly ? 'italic' : 'normal',
            outline: readOnly ? '1px dashed rgba(255,255,255,0.6)' : 'none',
            outlineOffset: -2,
          }}
          className="flex items-center px-2 rounded-md select-none overflow-hidden"
          {...(readOnly ? {} : attributes)}
          {...(readOnly ? {} : listeners)}
          onClick={readOnly ? undefined : (e) => { e.stopPropagation(); onEdit(item); }}
          title={readOnly ? 'Vol à cheval (mois précédent) — modifiable depuis le mois de départ' : undefined}
        >
          {hasMep && (
            <div
              className="absolute top-0 left-0 right-0 pointer-events-none rounded-t-md"
              style={{ height: BAR_H / 8, backgroundColor: '#EC4899' }}
              aria-hidden
            />
          )}
          <div className="flex flex-col min-w-0 flex-1 gap-px">
            <span className="text-[11px] font-semibold truncate leading-none">{label}</span>
            {euroVal !== null && (
              <span className="text-[10px] font-mono leading-none opacity-95">
                {Math.round(euroVal)}€{isProrated ? '*' : ''}
              </span>
            )}
            {hcrDisplay !== null && (
              <span className="text-[9px] leading-none opacity-60">
                {hcrDisplay.toFixed(2)}h{prime > 0 ? ` +${prime}P` : ''}
              </span>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ─── BarPreview (DragOverlay content) ───────────────────────────────────────

function BarPreview({ item, span }: { item: CalendarItem; span: number }) {
  const meta = ACTIVITY_META[item.kind];
  const metaObj = item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta)
    ? item.meta as Record<string, unknown>
    : null;
  const label = item.kind === 'flight' && metaObj?.destination
    ? String(metaObj.destination)
    : meta.label;
  return (
    <div
      className="flex items-center px-3 rounded-md shadow-xl pointer-events-none"
      style={{
        width: `${span * 40}px`,
        height: BAR_H,
        backgroundColor: meta.color,
        color: meta.textColor,
        opacity: 0.9,
      }}
    >
      <span className="text-[11px] font-semibold truncate">{label}</span>
    </div>
  );
}

// ─── main component ──────────────────────────────────────────────────────────

type SheetMode = 'add' | 'edit';

interface SheetState {
  mode: SheetMode;
  scenarioId: string;
  scenarioName: ScenarioName;
  date: string;           // start date
  item?: CalendarItem;    // only for edit
}

export function GanttView({
  month, scenarios, userName, userRegime, cngPv, cngHs,
  primeIncitationUnit = 0, primeA330 = 0, primeInstruction = 0,
  pvei: pveiProp, ksp: kspProp, fixeRegime: fixeRegimeProp, fixeTP: fixeTPProp,
  annexeRows = [],
  financeProfile = null,
  profileVersions = [],
  article81Data = null, valeurJour = 600,
  a81CumulBefore = { A: 0, B: 0, C: 0 },
  irMfByScenario,
  irMfPerFlightByScenario,
  prorataThresholds = [],
  ddaRulesData = null,
  volPRulesData = null,
  transport = null,
  navigoEur = 0,
  voitureKmAller = 0,
  voitureIndemniteKm = 0,
  notes = [],
  fictiveMonths = [],
}: {
  month: string;
  scenarios: Scenario[];
  userName: string;
  userRegime: RegimeEnum;
  cngPv: number;
  cngHs: number;
  /** Montant unitaire de la prime d'incitation (multiplié par le compteur 0-5). */
  primeIncitationUnit?: number;
  /** Prime A330 mensuelle (déjà proratisée au régime). */
  primeA330?: number;
  /** Prime mensuelle d'instruction (TRI). */
  primeInstruction?: number;
  /** PVEI calculé depuis l'annexe versionnée du mois. Si absent → fallback constante. */
  pvei?: number;
  /** KSP (constante mais passé explicitement pour cohérence). */
  ksp?: number;
  /** Traitement fixe mensuel proratisé au régime utilisateur. */
  fixeRegime?: number;
  /** Traitement fixe TP (utilisé en jul/août pour TAF*_10_12). */
  fixeTP?: number;
  /** Toutes les rows de annexe_table (versionnées) — sert à recomputer finBase
   *  client-side lors d'un changeMonth. */
  annexeRows?: AnnexeRow[];
  /** Champs du profil nécessaires à computeFullProfile. */
  financeProfile?: {
    aircraft: string;
    fonction: string;
    classe: number;
    categorie: string;
    echelon: number;
    atpl: boolean;
    primeIncitationType: 'LC' | 'MC';
    primeInstFonction: string | null;
    primeInstAnnee: number | null;
    prime330Count: number | null;
  } | null;
  /** Toutes les versions du profil individuel — sert à recomputer finBase et
   *  les autres dépendances profil (régime, IT, congés, valeurJour) en
   *  client-side lors d'un changeMonth. */
  profileVersions?: ProfileVersion[];
  /** Mode transport profil pour calcul IT ('Navigo' | 'Voiture' | null). */
  transport?: string | null;
  /** IT mensuelle forfaitaire si transport = Navigo. */
  navigoEur?: number;
  /** Km aller (Voiture). */
  voitureKmAller?: number;
  /** Indemnité par km (Voiture). */
  voitureIndemniteKm?: number;
  /** Matrice Article 81 (taux de séjour par zone × durée). */
  article81Data?: Article81Data | null;
  /** Valeur jour (€) pour Article 81 — depuis profil. */
  valeurJour?: number;
  /** Cumul tSej24 par scénario depuis Jan jusqu'au mois précédent (pour plafond annuel). */
  a81CumulBefore?: Record<'A' | 'B' | 'C', number>;
  /** Totaux IR/MF (compte + €) par scénario pour le mois courant — pré-calculés
   *  côté serveur via raw_detail (cf. getMonthlyIrMfEuros). */
  irMfByScenario?: Record<'A' | 'B' | 'C', { ir: number; mf: number; ir_eur: number; mf_eur: number; skipped: number }>;
  /** Détail IR/MF par vol (instance_id + destination + €) pour le panneau détail. */
  irMfPerFlightByScenario?: Record<'A' | 'B' | 'C', { instance_id: string; destination: string; ir_eur: number; mf_eur: number }[]>;
  /** Seuils prorata DDA OFF depuis annexe_table slug='prorata'. */
  prorataThresholds?: ProrataThreshold[];
  /** Règles DDA + Vol P (slugs 'dda_rules' et 'vol_p_rules' dans annexe_table). */
  ddaRulesData?: { rules: unknown[] } | null;
  volPRulesData?: { rules: unknown[] } | null;
  /** Notes utilisateur (cross-scénario) overlappant le mois courant. */
  notes?: UserNote[];
  /** Mois "fictifs" (projection admin) — pour banner + coloration cellules. */
  fictiveMonths?: string[];
}) {
  const router = useRouter();
  const [isPending, _startTransition] = useTransition();
  const rowRef = useRef<HTMLDivElement>(null);

  // navigation mois côté client (évite router.push → serveur → page blanche hors ligne)
  const [currentMonth, setCurrentMonth] = useState(month);
  const [monthLoading, setMonthLoading] = useState(false);
  const [noCache, setNoCache]           = useState(false);

  // local state (offline-capable copy of scenarios)
  const [localScenarios, setLocalScenarios] = useState<Scenario[]>(scenarios);
  const [pendingCount, setPendingCount]     = useState(0);
  const [localNotes, setLocalNotes]         = useState<UserNote[]>(notes);

  // Map d'instances horaires du mois courant (depart_at / arrivee_at) pour
  // primes Mai/Noël qui ont besoin du timing intra-rotation. Vide → primes = 0.
  const [instancesById, setInstancesById] = useState<Map<string, RotationInstance>>(new Map());
  // Map signature parente par instance_id — utilisée pour récupérer hcr_crew
  // et tsv_nuit (prime 1er mai). Construite en même temps que instancesById.
  const [signaturesByInstId, setSignaturesByInstId] = useState<Map<string, RotationSignature>>(new Map());

  // Sheet pour ajouter/éditer une note (sépare des items planning pour
  // éviter de mixer 2 logiques différentes — note vit dans table user_note,
  // pas planning_item, et est cross-scénario).
  const [noteSheet, setNoteSheet] = useState<
    | { mode: 'add'; date: string }
    | { mode: 'edit'; note: UserNote }
    | null
  >(null);
  const [noteText, setNoteText] = useState('');
  const [noteEnd, setNoteEnd]   = useState('');

  // Mode chevauchement RPC ↔ congés/TAF. Per-mois, persisté localStorage.
  // OFF (défaut) : le RPC se reporte ENTIÈREMENT après la chaîne contiguë de
  //   congés/TAF qui le coupent. 1 segment, déplacé.
  // ON : le RPC se met en pause pendant les congés/TAF, puis reprend après.
  //   N+1 segments séparés de N pauses.
  const [rpcChevauchement, setRpcChevauchement] = useLocalStorageState<boolean>(
    `cm-rpc-chevauchement:${currentMonth}`, false,
    raw => raw === '1',
    v => v ? '1' : '0',
  );
  function toggleRpcChevauchement() {
    setRpcChevauchement(prev => !prev);
  }

  // IR/MF + A81 cumul : props serveur figées au render initial, on copie en
  // state pour pouvoir les rafraîchir lors d'une navigation client-side
  // (changeMonth) — sinon le mois courant utilise les valeurs du mois initial.
  const [irMfState, setIrMfState] = useState(() => ({
    byScenario: irMfByScenario,
    perFlightByScenario: irMfPerFlightByScenario,
  }));
  const [a81CumulBeforeState, setA81CumulBeforeState] = useState(a81CumulBefore);

  // Resync depuis les props quand le serveur renvoie de nouvelles valeurs
  // (router.refresh après Sync / mount initial sur un autre mois via URL).
  useEffect(() => {
    setIrMfState({ byScenario: irMfByScenario, perFlightByScenario: irMfPerFlightByScenario });
  }, [irMfByScenario, irMfPerFlightByScenario]);
  useEffect(() => { setA81CumulBeforeState(a81CumulBefore); }, [a81CumulBefore]);

  // pendingCount : source de vérité = sync_queue Dexie. Les optimistic
  // `setPendingCount(c => c + 1)` répartis dans le fichier sont corrects pour
  // 99 % des cas, mais le coalescing add+delete (cf sync-service) supprime des
  // ops sans appeler setPendingCount → on s'abonne à l'event pour recoller au
  // vrai count après chaque enqueue.
  useEffect(() => {
    void pendingOpsCount().then(setPendingCount);
    const onChange = () => { void pendingOpsCount().then(setPendingCount); };
    window.addEventListener(PENDING_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(PENDING_CHANGED_EVENT, onChange);
  }, []);

  // Profil individuel applicable au mois courant (versionné). Pioche la row
  // dont valid_from <= 1er du mois, la plus récente. Si aucune version
  // applicable (mois trop ancien) → fallback aux props initiales.
  const effProfile = useMemo<ProfileVersion | null>(() => {
    if (profileVersions.length === 0) return null;
    const cutoff = `${currentMonth}-01`;
    const sorted = [...profileVersions].sort((a, b) => b.valid_from.localeCompare(a.valid_from));
    return sorted.find(v => v.valid_from <= cutoff) ?? null;
  }, [currentMonth, profileVersions]);

  // Valeurs effectives : profil applicable du mois si dispo, sinon prop initiale.
  const effRegime           = effProfile?.regime              ?? userRegime;
  const effCngPv            = effProfile?.cng_pv              ?? cngPv;
  const effCngHs            = effProfile?.cng_hs              ?? cngHs;
  const effTransport        = effProfile?.transport           ?? transport;
  const effNavigoEur        = effProfile?.navigo_eur          ?? navigoEur;
  const effVoitureKmAller   = effProfile?.voiture_km_aller    ?? voitureKmAller;
  const effVoitureIndKm     = effProfile?.voiture_indemnite_km?? voitureIndemniteKm;
  const effValeurJour       = effProfile?.valeur_jour         ?? valeurJour;

  // FinanceProfile reconstruit depuis effProfile si dispo, sinon prop initiale.
  const effFinanceProfile = useMemo(() => {
    if (effProfile && effProfile.fonction && effProfile.classe != null
        && effProfile.echelon != null && effProfile.categorie) {
      return {
        aircraft: effProfile.aircraft_principal ?? 'A335',
        fonction: effProfile.fonction,
        classe: effProfile.classe,
        categorie: effProfile.categorie,
        echelon: effProfile.echelon,
        atpl: effProfile.bonus_atpl,
        primeIncitationType: 'LC' as const,
        primeInstFonction: effProfile.fonction === 'TRI_OPL' ? 'TRI_OPL'
          : effProfile.fonction === 'TRI_CDB' ? 'ICPL'
          : null,
        primeInstAnnee: (effProfile.fonction === 'TRI_OPL' || effProfile.fonction === 'TRI_CDB')
          ? effProfile.tri_niveau : null,
        prime330Count: effProfile.prime_330_count,
      };
    }
    return financeProfile;
  }, [effProfile, financeProfile]);

  // Éléments de paie versionnés (pvei, fixe, primes) — calculés client-side à
  // partir de toutes les rows annexe + le profil applicable, pour le mois
  // courant. Instantané (zéro fetch) et offline-compatible. Fallback aux props
  // initiales si annexeRows/financeProfile absents (ex: legacy / profil incomplet).
  const finBaseState = useMemo(() => {
    // Boost juillet/août pour TAF*_10_12 : `isFullPrimeMonth` indique les mois
    // de vacances pendant lesquels le pilote off touche un fixe + MGA temps
    // plein (nb30e=30). Sans ce boost, SMMG reste figé sur le pro-rata régime
    // entre juin (nb30e=23) et juillet (qui doit passer à 30).
    const moHere   = parseInt(currentMonth.slice(5), 10);
    const fullPrime = isFullPrimeMonth(effRegime, moHere);
    if (effFinanceProfile && annexeRows.length > 0) {
      const annexe = getAnnexeDataFromRows(annexeRows, currentMonth);
      const hasAnnexe = !!(
        annexe.cat_anciennete?.length &&
        annexe.coef_classe?.length &&
        annexe.taux_avion?.length &&
        annexe.traitement_base
      );
      if (hasAnnexe) {
        const nb30eBase = REGIME_NB30E[effRegime] ?? 30;
        const nb30e     = fullPrime ? 30 : nb30eBase;
        const c = computeFullProfile(
          effFinanceProfile.aircraft,
          effFinanceProfile.fonction,
          effFinanceProfile.classe,
          effFinanceProfile.categorie,
          effFinanceProfile.echelon,
          effFinanceProfile.atpl,
          nb30e,
          effFinanceProfile.primeIncitationType,
          effFinanceProfile.primeInstFonction,
          effFinanceProfile.primeInstAnnee,
          effFinanceProfile.prime330Count,
          annexe as AnnexeData,
        );
        return {
          pvei: c.pvei, ksp: c.ksp, fixe: c.fixe, fixeTP: c.fixeTP, smmg: c.smmg,
          primeIncitationUnit: c.primeIncitation,
          primeA330: c.primeA330,
          primeInstruction: c.primeInstruction,
        };
      }
    }
    // Fallback aux props initiales (server-rendered pour le mois initial).
    if (pveiProp != null && kspProp != null && fixeRegimeProp != null && fixeTPProp != null) {
      // SMMG = fixe + MGA (cf. annexe.ts). MGA = 85×PVEI×KSP×(nb30e/30).
      // En full-prime month (juillet/août TAF*_10_12) : fixe TP + MGA TP.
      const nb30eBase = REGIME_NB30E[effRegime] ?? 30;
      const nb30eFb   = fullPrime ? 30 : nb30eBase;
      const fixeFb    = fullPrime ? fixeTPProp : fixeRegimeProp;
      const mgaFb     = 85 * pveiProp * kspProp * (nb30eFb / 30);
      return {
        pvei: pveiProp, ksp: kspProp, fixe: fixeFb, fixeTP: fixeTPProp,
        smmg: fixeFb + mgaFb,
        primeIncitationUnit, primeA330, primeInstruction,
      };
    }
    return null;
  }, [
    currentMonth, annexeRows, effFinanceProfile, effRegime,
    pveiProp, kspProp, fixeRegimeProp, fixeTPProp,
    primeIncitationUnit, primeA330, primeInstruction,
  ]);

  // Recalcul IR/MF local depuis le cache rotations IndexedDB (mois M + M-1
  // spillovers), offline. Le calcul par signature est pré-fait au scrape. Si le
  // cache est vide pour ce mois (premier accès, jamais Sync) → on garde l'état
  // précédent (prop initiale serveur ou valeur post-fetch). `isStale` permet
  // d'annuler une résolution périmée (effet annulé ou changeMonth plus récent).
  const refreshIrMf = useCallback(
    async (scs: Scenario[], m: string, isStale: () => boolean) => {
      try {
        const res = await computeMonthlyIrMfFromLocalCache(scs, m);
        if (isStale()) return;
        // Distingue "pas d'items" (résultat valide à 0) de "items mais cache
        // rotations vide" (où on ne veut pas écraser la valeur courante).
        const flightItems = scs.flatMap(s =>
          s.items.filter(i => i.kind === 'flight' && i.pairing_instance_id),
        ).length;
        const totalSkipped = res.byScenario.A.skipped + res.byScenario.B.skipped + res.byScenario.C.skipped;
        if (flightItems > 0 && totalSkipped === flightItems) return; // tout skipped → cache vide
        setIrMfState({ byScenario: res.byScenario, perFlightByScenario: res.perFlightByScenario });
      } catch { /* erreur Dexie : on garde l'état courant */ }
    },
    [],
  );

  // Recalcul à chaque changement de mois ou d'items (add / delete / edit).
  useEffect(() => {
    let cancelled = false;
    void refreshIrMf(localScenarios, currentMonth, () => cancelled);
    return () => { cancelled = true; };
  }, [localScenarios, currentMonth, refreshIrMf]);

  // Cumul A81 (Jan→M-1) recalculé client-side depuis Dexie. Sans cet effet,
  // l'offline (et la navigation client-side) garde a81CumulBeforeState à 0,
  // ce qui affiche seulement la valeur du mois courant sans la cumul annuelle.
  useEffect(() => {
    let cancelled = false;
    const [yy, mm] = currentMonth.split('-').map(Number);
    void computeA81CumulBeforeLocal(yy, mm)
      .then(a81 => { if (!cancelled) setA81CumulBeforeState(a81.byScenarioBefore); })
      .catch(() => { /* erreur Dexie : on garde l'état courant */ });
    return () => { cancelled = true; };
  }, [localScenarios, currentMonth]);

  // sheet
  const [sheet, setSheet]         = useState<SheetState | null>(null);
  const [addKind, setAddKind]     = useState<ActivityKind>('off');
  const [addEnd, setAddEnd]       = useState('');
  const [nbJours, setNbJours]     = useState('');
  const [overlapErr, setOverlapErr] = useState(false);
  const [editBidCat, setEditBidCat] = useState<BidCategory | null>(null);
  // Day-sheet : true quand l'utilisateur a cliqué "Rotations" et qu'on doit
  // afficher le choix de catégorie (DDA / Vol P / Élabo) inline à la place
  // des boutons d'activité, dans le même cadre.
  const [sheetCategoryMode, setSheetCategoryMode] = useState(false);
  // Top px de la sheet en mode edit-flight (alignée sur le haut de la ligne C).
  const [editSheetTop, setEditSheetTop] = useState<number | null>(null);

  // dnd
  const [dragging, setDragging]   = useState<CalendarItem | null>(null);

  // search / import
  const [searchOpen,     setSearchOpen]     = useState(false);
  const [searchScenario, setSearchScenario] = useState<ScenarioName | null>(null);
  const [searchCategory, setSearchCategory] = useState<BidCategory | null>(null);
  const [searchDate,     setSearchDate]     = useState<string | null>(null);
  const [searchPanelTop, setSearchPanelTop] = useState<number | undefined>(undefined);
  // Pickers en cascade : Rotations → catégorie → scénario → SearchPanel.
  // `prefilledScenario` + `prefilledDate` permettent au flow "clic jour → Rotations"
  // de sauter l'étape scénario (déjà connue) et d'aller direct au SearchPanel.
  const [categoryPicker, setCategoryPicker] = useState<{
    rect: DOMRect;
    prefilledScenario?: ScenarioName;
    prefilledDate?: string;
  } | null>(null);
  const [scenarioPicker, setScenarioPicker] = useState<{ rect: DOMRect; category: BidCategory } | null>(null);
  const scenarioRowsRef = useRef<Map<ScenarioName, HTMLDivElement>>(new Map());

  // ─── DDA / VOL P validation ────────────────────────────────────────────────
  const ddaRules: DdaRule[] = useMemo(
    () => mergeRules(ddaRulesData as DdaRulesData | null, volPRulesData as DdaRulesData | null),
    [ddaRulesData, volPRulesData],
  );

  /** Map scenarioId → list of violations. Inclut le set d'IDs de vols ayant
   *  meta.rpc_reported = true (acquittement utilisateur pour l'option de report
   *  du RPC à la fin des CONGES suivants). */
  const violationsByScenario = useMemo(() => {
    const out = new Map<string, Violation[]>();
    if (ddaRules.length === 0) return out;
    for (const s of localScenarios) {
      const accepted = new Set<string>();
      for (const it of s.items) {
        if (it.meta && typeof it.meta === 'object' && !Array.isArray(it.meta)
            && (it.meta as Record<string, unknown>).rpc_reported === true) {
          accepted.add(it.id);
        }
      }
      out.set(s.id, validateScenario(s.items, ddaRules, s.id, s.name, accepted));
    }
    return out;
  }, [localScenarios, ddaRules]);

  /** Acquitte une violation DDA_VOL → CONGES en marquant le vol
   *  rpc_reported=true (RPC reporté à la fin des congés). */
  function handleAcceptRpcReport(itemId: string) {
    const target = localScenarios.flatMap(s => s.items).find(it => it.id === itemId);
    if (!target) return;
    const prevMeta = (target.meta && typeof target.meta === 'object' && !Array.isArray(target.meta))
      ? target.meta as Record<string, unknown>
      : {};
    const nextMeta = { ...prevMeta, rpc_reported: true } as unknown as import('@/types/supabase').Json;
    setLocalScenarios(prev => prev.map(s => ({
      ...s,
      items: s.items.map(it => it.id === itemId ? { ...it, meta: nextMeta } : it),
    })));
    setPendingCount(c => c + 1);
    void enqueueMetaUpdate(itemId, nextMeta);
  }

  // Quand search ouvert : scénario sélectionné remonté en premier
  const displayScenarios = useMemo(() => {
    if (searchOpen && searchScenario) {
      return [
        ...localScenarios.filter(s => s.name === searchScenario),
        ...localScenarios.filter(s => s.name !== searchScenario),
      ];
    }
    return localScenarios;
  }, [localScenarios, searchOpen, searchScenario]);

  // Recalcule panelTop après re-render (le scénario est maintenant en première ligne)
  useEffect(() => {
    if (!searchOpen || !searchScenario) return;
    requestAnimationFrame(() => {
      const rowEl = scenarioRowsRef.current.get(searchScenario);
      if (rowEl) setSearchPanelTop(rowEl.getBoundingClientRect().bottom);
    });
  }, [searchOpen, searchScenario]);
  const [scrapeOpen, setScrapeOpen] = useState(false);
  const [_isAdmin,   setIsAdmin]    = useState(false);
  const [canScrape,  setCanScrape]  = useState(false);

  // Panneau détail paie (flyout fixe à droite du label)
  type DetailPanel = {
    name: string; rect: DOMRect; viewportH: number;
    // PV : HCr × PVEI × KSP, PVnuit = tsvNuit/2 × PVEI × KSP
    pvEur: number; pvHcrEur: number; pvNuitEur: number;
    /** Décomposition par vol pour le détail PV. */
    flightBreakdown: { destination: string; hcrEur: number; pvNuitEur: number; instanceId: string | null }[];
    /** HCr forfaitaires hors-vol (sol = réserve+méd+autre, sim = simulateur). */
    solDays: number; simDays: number; solHcrEur: number; simHcrEur: number;
    // HS : breakdown
    totalHc: number; seuil75: number; hsH: number; hsEur: number;
    hsFixeRate: number; hsVolRate: number;
    // PV+HS / MGA / DIFF — pveiEff, kspEff & nb30eEff servent à afficher la formule MGA
    fixeForFin: number; totalNew: number; mga: number; diff: number;
    pveiEff: number; kspEff: number; nb30eEff: number;
    // Primes (déjà ventilées) + congés + IR/MF
    totalPrime: number; bitronconEur: number;
    incitation: number; a330: number; instruction: number;
    irgav: number;
    primeMai: number; primeNoel: number; primesTotal: number;
    congeDays: number; cngPv: number; cngHs: number; congeAmount: number;
    irEur: number; mfEur: number;
    /** Détail IR/MF par vol (récupéré du serveur). */
    irMfPerFlight: { destination: string; ir_eur: number; mf_eur: number }[];
    /** Indemnité Transport (IT) + métadonnées pour breakdown. */
    itEur: number;
    itMode: string | null;             // 'Navigo' | 'Voiture' | null
    itNbActivites: number;
    itPerActivite: number;             // (Voiture) 2 × km × ind/km
    // BRUT
    brut: number;
  };
  const [detailPanel, setDetailPanel] = useState<DetailPanel | null>(null);

  // Popover violation DDA (déclenché au clic sur un bandeau rouge ou vert).
  const [violationPopover, setViolationPopover] = useState<{
    key: string;
    rule: string;
    catA: DdaCategory;
    catB: DdaCategory;
    gap: number;
    rpc?: number;
    canReport: boolean;
    itemAId: string;
    /** Vrai si AF flagge mais c'est licite via RPC reporté à travers CONGES.
     *  Le popover affiche en plus la `realRule` qui explique pourquoi c'est OK. */
    afOnly: boolean;
    realRule?: string;
    left: number;  // viewport coords (centre horizontal du bandeau)
    top:  number;  // viewport coords (juste sous le bandeau)
  } | null>(null);

  // Compteur prime d'incitation (0-5), persistance localStorage par mois.
  const [incitCount, setIncitCount] = useLocalStorageState<number>(
    `cm-incit-${currentMonth}`, 0,
    raw => Math.max(0, Math.min(5, parseInt(raw) || 0)),
    String,
  );

  // Compteur prime IrgAv (0-10) — montant = Y × 5 × PVEI. Default 0.
  const [irgavCount, setIrgavCount] = useLocalStorageState<number>(
    `cm-irgav-${currentMonth}`, 0,
    raw => Math.max(0, Math.min(10, parseInt(raw) || 0)),
    String,
  );

  // Popover pour les sélecteurs de primes — désencombre la barre du bas.
  const [primeMenuOpen, setPrimeMenuOpen] = useState<'incit' | 'irgav' | null>(null);

  // Reset menu + confirmation modale
  const [resetMenuOpen, setResetMenuOpen] = useState(false);
  const [resetMenuPos,  setResetMenuPos]  = useState<{ left: number; bottom: number } | null>(null);
  const resetButtonRef                    = useRef<HTMLButtonElement>(null);
  const [resetTarget,   setResetTarget]   = useState<'A' | 'B' | 'C' | 'tout' | null>(null);
  const [resetting,     setResetting]     = useState(false);

  // Token de navigation : invalide les fetches en vol quand on navigue vers un autre mois
  const navTokenRef = useRef(0);
  // Mois en cours de pré-cache (dédup pour éviter 4-6 calls Supabase concurrents)
  const preCacheInFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    void getCurrentUserScrapeRights()
      .then(r => { setIsAdmin(r.is_admin); setCanScrape(r.is_admin || r.is_scraper); })
      .catch(() => { setIsAdmin(false); setCanScrape(false); });
  }, []);

  function changeIncit(n: number) {
    setIncitCount(n);
  }

  function changeIrgav(n: number) {
    setIrgavCount(n);
  }

  async function handleReset() {
    if (!resetTarget) return;
    setResetting(true);
    const targets: ('A' | 'B' | 'C')[] = resetTarget === 'tout' ? ['A', 'B', 'C'] : [resetTarget];

    // Snapshot des items non-spillover à supprimer (avant de vider localScenarios)
    // — sert au fallback offline qui queue un delete par item.
    const itemIdsToDelete = localScenarios
      .filter(s => targets.includes(s.name))
      .flatMap(s => s.items.filter(i => !i._isSpillover).map(i => i.id));

    // Optimistic UI immédiat : vide les scénarios cibles (garde les spillovers).
    setLocalScenarios(prev => prev.map(s =>
      targets.includes(s.name) ? { ...s, items: s.items.filter(i => i._isSpillover) } : s,
    ));
    // Ferme le pop-up tout de suite — il ne doit pas dépendre du succès serveur.
    setResetTarget(null);

    // Purge IndexedDB + ops de queue concernant ces items, en local (offline-safe).
    await purgeScenarios(currentMonth, targets);

    try {
      if (navigator.onLine) {
        await resetPlanningScenarios(currentMonth, targets);
        router.refresh();
      } else {
        // Offline : queue chaque delete pour qu'ils partent au prochain Sync.
        for (const id of itemIdsToDelete) await enqueueDelete(id);
      }
    } catch (e) {
      console.error('[reset] server call failed', e);
      // Fallback : queue les deletes (au cas où le serveur n'aurait rien fait).
      for (const id of itemIdsToDelete) await enqueueDelete(id);
    } finally {
      setPendingCount(await pendingOpsCount());
      setResetting(false);
    }
  }

  // user menu
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const { status: pushStatus, subscribe: pushSubscribe } = usePushSubscription();

  // propagation feedback
  const [propagateMsg, setPropagateMsg] = useState<string | null>(null);
  // popup "X → Y" : null = fermé, sinon { source, target } avec source possiblement === target (validation à l'OK)
  const [copyModal, setCopyModal] = useState<{ source: ScenarioName; target: ScenarioName } | null>(null);

  // ── Init : hydrate IndexedDB ou charge depuis le cache local ────────────────
  useEffect(() => {
    async function init() {
      // Restaure le dernier mois consulté si différent du mois courant
      const stored = localStorage.getItem('cm-selected-month');
      if (stored && stored !== month) {
        void changeMonth(stored);
        return;
      }

      const hasPending = await hasPendingOps();
      if (hasPending) {
        const local = await loadFromDB(scenarios, month);
        setLocalScenarios(local);
        setPendingCount(await pendingOpsCount());
      } else if (scenarios.length === 0) {
        // Coquille client : si la prop `scenarios` est vide (Dexie n'a pas de
        // drafts pour ce mois), on NE PAS écrire dans Dexie (hydrateDB ferait
        // un wipe destructeur). On lit directement Dexie comme source.
        const local = await loadFromDB(scenarios, month);
        setLocalScenarios(local);
      } else {
        await hydrateDB(scenarios, month);
        setLocalScenarios(scenarios);
      }
      // Hydrate notes pour le mois courant — skip si vide (même raison).
      if (notes.length > 0) await hydrateNotes(notes, month);
      setLocalNotes(await loadNotesForMonth(month));
    }
    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  // ── Pre-cache initial M+1..M+3 ───────────────────────────────────────────
  // Sans ça, le 1er next/next/next paie un round-trip réseau (cache-first OK
  // mais Dexie vide pour les mois non encore visités). Ce ric s'aligne sur le
  // sync lite (M..M+3) et complète preCacheMonthBg(±1) déclenché par
  // changeMonth. Fail-silent offline.
  useEffect(() => {
    if (typeof window === 'undefined' || !navigator.onLine) return;
    const run = () => {
      void preCacheMonthBg(shiftMonth(month, 1));
      void preCacheMonthBg(shiftMonth(month, 2));
      void preCacheMonthBg(shiftMonth(month, 3));
    };
    type RIC = (cb: () => void, opts?: { timeout: number }) => number;
    const ric = (window as unknown as { requestIdleCallback?: RIC }).requestIdleCallback;
    if (typeof ric === 'function') ric(run, { timeout: 3000 });
    else setTimeout(run, 1500);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Mise à jour depuis le serveur après le bouton Sync (router.refresh) ────
  // Quand `scenarios` change (nouveau RSC remonté par router.refresh post-Sync),
  // on resync localScenarios — MAIS depuis Dexie, pas depuis les props serveur :
  // après un push, Next.js peut servir un RSC cached (revalidatePath ne purge
  // pas toujours sub-routes ?m=...) ou Supabase peut avoir un lag réplication
  // sur le SELECT, donc `scenarios` props peut encore contenir l'item qu'on
  // vient juste de supprimer. Dexie, elle, a l'optimistic delete appliqué via
  // applyDelete → c'est la source de vérité pour les items du user.
  useEffect(() => {
    if (currentMonth !== month) return;
    async function maybeRefresh() {
      const count = await pendingOpsCount();
      if (count === 0) {
        const fromDb = await loadFromDB(scenarios, month);
        setLocalScenarios(fromDb);
        setPendingCount(0);
      }
    }
    maybeRefresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarios]);

  // ── Charge les maps d'instances horaires + signature parente pour le mois
  //    courant ET le mois précédent (pour les spillovers : vol parti M-1
  //    et atterri M garde sa signature cachée dans target_month=M-1).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const prevMonth = shiftMonth(currentMonth, -1);
      const [sigsCur, sigsPrev] = await Promise.all([
        loadRotationsFromDB(currentMonth),
        loadRotationsFromDB(prevMonth),
      ]);
      if (cancelled) return;
      const byInst = new Map<string, RotationInstance>();
      const sigByInst = new Map<string, RotationSignature>();
      for (const sig of [...sigsCur, ...sigsPrev]) {
        for (const inst of sig.instances) {
          byInst.set(inst.id, inst);
          sigByInst.set(inst.id, sig);
        }
      }
      setInstancesById(byInst);
      setSignaturesByInstId(sigByInst);
    })();
    return () => { cancelled = true; };
  }, [currentMonth]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor,  { activationConstraint: { delay: 200, tolerance: 5 } }),
  );

  const [year, mo] = currentMonth.split('-').map(Number);
  const dim   = daysInMonth(year, mo);
  // Date du jour via useSyncExternalStore : pas de setState-in-effect.
  // SSR snapshot = '' (= comportement avant l'hydration). Client snapshot
  // = date locale. La fonction `subscribe` ne re-subscribe jamais (today
  // ne change pas pendant la session pour l'usage qu'on en fait : highlight
  // de la colonne du jour).
  const today = useSyncExternalStore(
    () => () => {},
    () => localStr(new Date()),
    () => '',
  );
  const tafDur = getTafDuration(effRegime);
  const tafOk  = isTafAvailable(effRegime, currentMonth);
  const days   = Array.from({ length: dim }, (_, i) => i + 1);

  // ── Navigation mois (client-side, pas de router.push) ───────────────────────

  async function preCacheMonthBg(m: string) {
    if (preCacheInFlightRef.current.has(m)) return;
    preCacheInFlightRef.current.add(m);
    try {
      // Timeout 15s : sur 4G captif (firewall qui drop sans répondre), les
      // server actions hangent indéfiniment. Sans cette garde, la promise
      // reste en vol pour toujours et le ref reste pollué → next pre-cache
      // sur le même mois no-op silencieux. 15s = ample marge online, et on
      // skip proprement sur captif.
      const TIMEOUT_MS = 15000;
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('preCacheMonthBg timeout')), TIMEOUT_MS));
      const [scs, rots] = await Promise.race([
        Promise.all([getScenariosWithItems(m), getRotationsForMonth(m)]),
        timeout,
      ]);
      await hydrateDB(scs, m);
      await cacheRotations(rots, m);
    } catch { /* ignore — arrière-plan */ }
    finally {
      preCacheInFlightRef.current.delete(m);
    }
  }

  async function changeMonth(newMonth: string) {
    const myToken = ++navTokenRef.current;
    setNoCache(false);
    setCurrentMonth(newMonth);
    localStorage.setItem('cm-selected-month', newMonth);
    window.history.replaceState(null, '', `/?m=${newMonth}`);

    // A81 cumul : reset (recalculé par l'effet dédié). IR/MF : on NE le remet
    // PAS à blanc ici — sinon le BRUT « flashe » une valeur basse (sans IR/MF)
    // le temps que l'effet le recalcule, d'où l'oscillation de la valeur totale
    // observée au next/previous. On le recalcule directement depuis le cache
    // rotations avec les scénarios cache-first ci-dessous → BRUT stable.
    setA81CumulBeforeState({ A: 0, B: 0, C: 0 });

    // 1. Cache-first : affichage immédiat depuis IndexedDB si dispo
    const cached = await loadScenariosForMonth(newMonth);
    if (myToken !== navTokenRef.current) return;
    if (cached) {
      setLocalScenarios(cached);
      // IR/MF recalculé depuis le cache rotations (offline) dès le 1er render du
      // nouveau mois → le BRUT inclut IR/MF immédiatement, pas de flash.
      void refreshIrMf(cached, newMonth, () => myToken !== navTokenRef.current);
      setMonthLoading(false);
    } else {
      // Pas de cache : là on remet IR/MF à blanc (pas de valeurs à montrer, et
      // on évite de garder celles du mois précédent jusqu'au re-fetch).
      setIrMfState({ byScenario: undefined, perFlightByScenario: undefined });
      setMonthLoading(true);
    }

    // 2. Refresh réseau (background si on avait du cache, bloquant sinon)
    if (!navigator.onLine) {
      if (!cached) { setNoCache(true); setLocalScenarios([]); }
      setMonthLoading(false);
      return;
    }

    try {
      // Scenarios + rotations + notes en parallèle.
      const [scs, rots, srvNotes] = await Promise.all([
        getScenariosWithItems(newMonth),
        getRotationsForMonth(newMonth),
        listNotesForMonth(newMonth),
      ]);
      if (myToken !== navTokenRef.current) return;
      // hydrateDB préserve les items pendants dans db.items ; on relit ensuite
      // depuis db pour merger items serveur + pending. Sinon un vol fraîchement
      // ajouté (encore en queue) disparaîtrait visuellement à chaque retour
      // sur le mois en wifi stable.
      await Promise.all([
        hydrateDB(scs, newMonth),
        cacheRotations(rots, newMonth),
        hydrateNotes(srvNotes, newMonth),
      ]);
      const hasPending = await hasPendingOps();
      const display = hasPending ? await loadFromDB(scs, newMonth) : scs;
      if (myToken !== navTokenRef.current) return;
      setLocalScenarios(display);
      setLocalNotes(await loadNotesForMonth(newMonth));
      setMonthLoading(false);
      // Pré-cache silencieux des mois adjacents
      // Pre-cache la fenêtre lite (M..M+3) + M-1. preCacheMonthBg dédoublonne
      // via preCacheInFlightRef, donc safe si déjà en vol.
      void preCacheMonthBg(shiftMonth(newMonth, -1));
      void preCacheMonthBg(shiftMonth(newMonth, 1));
      void preCacheMonthBg(shiftMonth(newMonth, 2));
      void preCacheMonthBg(shiftMonth(newMonth, 3));
      // FinBase : calculé client-side via useMemo(currentMonth) à partir de
      // annexeRows + financeProfile (passés en props). Aucun fetch ici.
      // IR/MF + A81 cumul : recalculés par les useEffect dédiés sur
      // [localScenarios, currentMonth] — fonctionnent online ET offline.
    } catch {
      if (myToken !== navTokenRef.current) return;
      if (!cached) { setNoCache(true); setLocalScenarios([]); }
      setMonthLoading(false);
    }
  }

  // ── sheet helpers ───────────────────────────────────────────────────────────

  // Seuils prorata : annexe hydratée si dispo, sinon fallback local embarqué
  // (offline 1er boot). Source unique pour le calcul du DDA repos max.
  const ddaThresholds = prorataThresholds.length > 0 ? prorataThresholds : PRORATA_FALLBACK;

  /** DDA repos : JP = TAF + congés du scénario → max (duree_min_opt6) + JI
   *  restants, et bloc DDA repos déjà posé ce mois (un seul autorisé). 100 %
   *  local — recalculé à chaque appel donc se met à jour si TAF/congés changent
   *  dans la session. */
  function computeDdaRepos(scenarioId: string) {
    const scenario = localScenarios.find(s => s.id === scenarioId);
    if (!scenario) return null;
    let congeDays = 0;
    for (const it of scenario.items) {
      if (it.kind !== 'conge') continue;
      const clip = clipItem(it, year, mo);
      if (clip) congeDays += clip.end - clip.start + 1;
    }
    const tafDays = tafOk ? tafDur : 0;
    const jp = congeDays + tafDays;
    const max = lookupDureeMax(jp, ddaThresholds);
    const jiRestants = lookupJI(jp, ddaThresholds);
    // Bloc DDA repos (kind 'off') déjà présent ce mois, hors spillover M-1.
    const existing = scenario.items.find(
      it => it.kind === 'off' && !it._isSpillover && clipItem(it, year, mo) != null,
    ) ?? null;
    return { congeDays, tafDays, jp, max, jiRestants, existing };
  }

  function openAdd(scenarioId: string, scenarioName: ScenarioName, date: string) {
    setOverlapErr(false);
    setAddKind('off');
    // DDA REPOS (kind 'off') se pré-positionne sur le max auto-calculé (borne
    // haute dure). Si max=0 (prorata saturé), '1' par défaut mais sélecteur +
    // submit désactivés en aval.
    const calc = computeDdaRepos(scenarioId);
    setNbJours(calc && calc.max > 0 ? String(calc.max) : '1');
    setAddEnd(date);
    setSheetCategoryMode(false);
    setSheet({ mode: 'add', scenarioId, scenarioName, date });
  }

  function openEdit(item: CalendarItem, scenario: Scenario) {
    setOverlapErr(false);
    setAddKind(item.kind);
    const dur = dayNum(item.end_date) - dayNum(item.start_date) + 1;
    setNbJours(String(dur));
    setAddEnd(item.end_date);
    setEditBidCat(item.kind === 'flight' ? (item.bid_category ?? 'dda_vol') : null);
    // Edit-flight : sheet plus haute, démarrant du haut de la ligne C (sous
    // les 3 lignes Gantt). Recalculée à chaque openEdit (taille viewport
    // variable). Pour les autres modes la sheet reste collée en bas.
    if (item.kind === 'flight') {
      const rowC = scenarioRowsRef.current.get('C');
      setEditSheetTop(rowC?.getBoundingClientRect().top ?? null);
    } else {
      setEditSheetTop(null);
    }
    setSheet({ mode: 'edit', scenarioId: scenario.id, scenarioName: scenario.name, date: item.start_date, item });
  }

  function handleKindChange(k: ActivityKind) {
    if (!sheet) return;
    setAddKind(k);
    setOverlapErr(false);
    if (k === 'taf' && tafDur) {
      const end = addDays(sheet.date, tafDur - 1);
      setAddEnd(end);
      setNbJours(String(tafDur));
    } else if (k === 'off') {
      // DDA REPOS : se repré-positionne sur le max auto-calculé.
      const calc = computeDdaRepos(sheet.scenarioId);
      const days = calc && calc.max > 0 ? calc.max : 1;
      setNbJours(String(days));
      setAddEnd(addDays(sheet.date, days - 1));
    } else if (k === 'conge' || k === 'conge_ss') {
      // Congés / CSS : valeur par défaut 1 jour. On ne reprend pas la valeur de
      // l'état précédent (qui peut être le max DDA repos pré-positionné à
      // l'ouverture), sinon Congés/CSS hériteraient à tort de ce max.
      setNbJours('1');
      setAddEnd(sheet.date);
    } else {
      setAddEnd(sheet.date);
    }
  }

  function handleNbJoursChange(val: string) {
    if (!sheet) return;
    setNbJours(val);
    const n = parseInt(val);
    if (!isNaN(n) && n >= 1) setAddEnd(addDays(sheet.date, n - 1));
  }

  // computed end date for display
  const computedEnd = addKind === 'taf' ? addDays(sheet?.date ?? today, tafDur - 1)
                    : addEnd;

  // DDA repos (kind 'off') : calcul max + JI restants + bloc existant, recalculé
  // à chaque render (donc à jour si TAF/congés changent dans la session).
  const ddaCalc = sheet && sheet.mode === 'add' && addKind === 'off'
    ? computeDdaRepos(sheet.scenarioId)
    : null;

  // ── add / edit submit ───────────────────────────────────────────────────────

  function applyAdd(item: CalendarItem, scenarioId: string) {
    setLocalScenarios(prev => prev.map(s =>
      s.id === scenarioId ? { ...s, items: [...s.items, item] } : s,
    ));
  }

  function applyDelete(itemId: string) {
    setLocalScenarios(prev => prev.map(s => ({
      ...s, items: s.items.filter(i => i.id !== itemId),
    })));
  }

  function applyUpdate(itemId: string, start: string, end: string) {
    setLocalScenarios(prev => prev.map(s => ({
      ...s, items: s.items.map(i => i.id === itemId ? { ...i, start_date: start, end_date: end } : i),
    })));
  }

  function handleSubmit() {
    if (!sheet) return;
    const scenario = localScenarios.find(s => s.id === sheet.scenarioId);
    if (!scenario) return;

    const start = sheet.date;
    const end   = computedEnd;

    const excludeId = sheet.mode === 'edit' ? sheet.item?.id : undefined;
    if (hasOverlap(scenario.items, start, end, excludeId)) {
      setOverlapErr(true);
      return;
    }

    if (sheet.mode === 'edit' && sheet.item) {
      const itemId = sheet.item.id;
      const prevItem = sheet.item;
      applyUpdate(itemId, start, end);
      // Si flight et catégorie modifiée, on enqueue aussi l'update de bid_category
      const bidChanged =
        prevItem.kind === 'flight' && editBidCat !== null && prevItem.bid_category !== editBidCat;
      if (bidChanged) {
        setLocalScenarios(prev => prev.map(s => ({
          ...s, items: s.items.map(i => i.id === itemId ? { ...i, bid_category: editBidCat } : i),
        })));
      }
      setSheet(null);
      setPendingCount(c => c + (bidChanged ? 2 : 1));
      void enqueueUpdate(itemId, start, end);
      if (bidChanged) void enqueueBidCategoryUpdate(itemId, editBidCat);
    } else {
      const id = crypto.randomUUID();
      const newItem: CalendarItem = { id, kind: addKind, start_date: start, end_date: end, bid_category: null, meta: null };
      const scenarioId = sheet.scenarioId;
      // Un seul bloc DDA repos par mois : si un bloc 'off' existe déjà ce mois,
      // l'utilisateur a confirmé via le bouton « Remplacer le DDA repos » →
      // on supprime l'ancien avant de créer le nouveau (max recalculé).
      if (addKind === 'off' && ddaCalc?.existing) {
        const oldId = ddaCalc.existing.id;
        applyDelete(oldId);
        setPendingCount(c => c + 1);
        void enqueueDelete(oldId);
      }
      applyAdd(newItem, scenarioId);
      setSheet(null);
      setPendingCount(c => c + 1);
      void enqueueAdd(newItem, scenarioId);
    }
  }

  function handleDelete() {
    if (!sheet?.item) return;
    // Updates locaux en synchrone — sortir du startTransition pour éviter
    // que l'écran grise (opacity-60 + pointer-events-none déclenchés par
    // isPending) tant que enqueueDelete n'a pas résolu ses promesses Dexie.
    const itemId = sheet.item.id;
    applyDelete(itemId);
    setSheet(null);
    setPendingCount(c => c + 1);
    void enqueueDelete(itemId);
  }

  // ── propagation X → Y ───────────────────────────────────────────────────────
  // Écrase tout le contenu de la ligne cible et le remplace par celui de la source.

  function propagateFlights(source: ScenarioName, target: ScenarioName) {
    if (source === target) return;
    const sourceScenario = localScenarios.find(s => s.name === source);
    const targetScenario = localScenarios.find(s => s.name === target);
    if (!sourceScenario || !targetScenario) return;

    // Spillovers (vols à cheval venus du mois précédent) sont rattachés à un
    // scénario par les vols sources → on les ignore lors de la copie.
    const sourceItems = sourceScenario.items.filter(it => !it._isSpillover);
    const targetExisting = targetScenario.items.filter(it => !it._isSpillover);

    if (sourceItems.length === 0 && targetExisting.length === 0) {
      setPropagateMsg(`${source} est vide — rien à propager`);
      setTimeout(() => setPropagateMsg(null), 3000);
      return;
    }

    const newItems: CalendarItem[] = sourceItems.map(it => ({
      id: crypto.randomUUID(),
      kind: it.kind,
      start_date: it.start_date,
      end_date: it.end_date,
      bid_category: it.bid_category,
      // Propage pairing_instance_id — sinon les vols copiés perdent leur lien
      // vers pairing_instance et disparaissent de EP4 / IR-MF / A81.
      pairing_instance_id: it.pairing_instance_id,
      meta: it.meta,
    }));

    // Optimistic local update : on remplace les items propres, on conserve les spillovers
    const targetSpillovers = targetScenario.items.filter(it => it._isSpillover);
    setLocalScenarios(prev => prev.map(s =>
      s.name === target ? { ...s, items: [...newItems, ...targetSpillovers] } : s,
    ));
    setPendingCount(c => c + targetExisting.length + newItems.length);

    void (async () => {
      for (const it of targetExisting) await enqueueDelete(it.id);
      for (const it of newItems) await enqueueAdd(it, targetScenario.id);
    })();

    setPropagateMsg(`${source} → ${target} : ${newItems.length} activité${newItems.length > 1 ? 's' : ''} copiée${newItems.length > 1 ? 's' : ''}`);
    setTimeout(() => setPropagateMsg(null), 3500);
  }

  // ── drag handlers ───────────────────────────────────────────────────────────

  function handleDragStart(event: DragStartEvent) {
    const item = (event.active.data.current as { item: CalendarItem }).item;
    setDragging(item);
  }

  function handleDragEnd(event: DragEndEvent) {
    setDragging(null);
    const { active, delta } = event;
    if (Math.abs(delta.x) < 4) return; // treat as click

    const { item } = active.data.current as { item: CalendarItem; clip: { start: number; end: number } };
    const scenario = localScenarios.find(s => s.items.some(i => i.id === item.id));
    if (!scenario) return;

    const rowW = rowRef.current?.getBoundingClientRect().width ?? 1000;
    const dayW = (rowW - LABEL_W) / dim;
    const deltaDays = Math.round(delta.x / dayW);
    if (deltaDays === 0) return;

    const origDur = dayNum(item.end_date) - dayNum(item.start_date);
    const origStart = dayNum(item.start_date);
    let newStart = origStart + deltaDays;
    newStart = Math.max(1, Math.min(dim - origDur, newStart));

    const prefix = `${year}-${String(mo).padStart(2,'0')}-`;
    const newStartStr = prefix + String(newStart).padStart(2,'0');
    const newEndStr   = prefix + String(newStart + origDur).padStart(2,'0');

    if (hasOverlap(scenario.items, newStartStr, newEndStr, item.id)) return;

    applyUpdate(item.id, newStartStr, newEndStr);
    setPendingCount(c => c + 1);
    void enqueueUpdate(item.id, newStartStr, newEndStr);
  }

  // ── sorted kinds (exclude flight from manual add) ─────────────────────────

  const addableKinds = (Object.keys(ACTIVITY_META) as ActivityKind[])
    .filter(k => k !== 'flight')
    .sort((a, b) => ACTIVITY_META[a].order - ACTIVITY_META[b].order);

  // ── render ──────────────────────────────────────────────────────────────────

  return (
    <DndContext id="cm-gantt" sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex flex-col h-screen bg-white dark:bg-zinc-950 overflow-hidden select-none">

        <NavBar />
        <EmptyCacheBanner />

        {/* Portrait warning */}
        <div className="portrait:flex landscape:hidden fixed inset-0 z-50 bg-zinc-950 text-white flex-col items-center justify-center gap-3 text-sm font-medium">
          Veuillez tourner votre iPad en mode paysage
        </div>

        {/* Header — layout 3 ancres :
            - Gauche (flex normal) : badge sync + PVEI + SMMG
            - Centre absolu (left-1/2) : sélecteur mois ‹ / ›
            - "Milieu droite" absolu (~80%) : toggle Chevauch.
            - Droite (flex normal) : userName/menu */}
        <header className="relative flex items-center justify-between px-4 h-14 border-b border-zinc-200 dark:border-zinc-800 flex-shrink-0">
          <div className="flex items-center gap-3">
            {pendingCount > 0 && (
              <span className="text-[10px] font-mono bg-amber-100 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 px-1.5 rounded-full">
                {pendingCount} à sync
              </span>
            )}
            {finBaseState && (
              <>
                <span
                  title="PVEI — Point de Valeur de l'Échelle Indiciaire (annexe versionnée du mois courant)"
                  className="text-xs font-mono text-zinc-500 dark:text-zinc-400"
                >
                  PVEI <strong className="text-zinc-700 dark:text-zinc-200">{finBaseState.pvei.toFixed(2)}</strong>
                </span>
                <span
                  title="SMMG — Salaire Minimum Mensuel Garanti = fixe + MGA (régime courant)"
                  className="text-xs font-mono text-zinc-500 dark:text-zinc-400"
                >
                  SMMG <strong className="text-zinc-700 dark:text-zinc-200">{finBaseState.smmg.toFixed(0)} €</strong>
                </span>
              </>
            )}
          </div>
          {/* Sélecteur mois — centré absolu sur l'écran */}
          <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2">
            <button onClick={() => changeMonth(shiftMonth(currentMonth,-1))} disabled={monthLoading}
              className="w-10 h-10 flex items-center justify-center rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-3xl disabled:opacity-40">‹</button>
            <span className={[
              'text-sm font-semibold w-40 text-center inline-flex items-center justify-center gap-1.5 rounded-md py-0.5 px-2',
              fictiveMonths.includes(currentMonth)
                ? 'bg-violet-200 dark:bg-violet-900/60 text-violet-900 dark:text-violet-100'
                : '',
            ].join(' ')}
              title={fictiveMonths.includes(currentMonth) ? 'Projection à titre indicatif — données fictives clonées d\'un mois réel récent' : undefined}
            >
              {MONTH_FR[mo-1]} {year}
              <MonthReleaseIcon month={currentMonth} />
            </span>
            <button onClick={() => changeMonth(shiftMonth(currentMonth,1))} disabled={monthLoading}
              className="w-10 h-10 flex items-center justify-center rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-3xl disabled:opacity-40">›</button>
          </div>
          {/* Toggle Chevauchement RPC / congés — légèrement à droite du milieu
              de la moitié droite (~80%), absolu pour ne pas perturber le centrage du mois. */}
          <div className="absolute left-[80%] -translate-x-1/2">
            <button
              onClick={toggleRpcChevauchement}
              role="switch"
              aria-checked={rpcChevauchement}
              title={
                rpcChevauchement
                  ? 'Chevauchement RPC/congés autorisé — le RPC se met en pause pendant les congés/TAF puis reprend après.'
                  : 'Chevauchement OFF — le RPC se reporte entièrement après les congés/TAF.'
              }
              className="flex items-center gap-2 px-2 h-8 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
            >
              <span className="text-[10px] font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
                Chevauch.
              </span>
              <span className={[
                'relative inline-flex h-4 w-7 items-center rounded-full transition-colors',
                rpcChevauchement ? 'bg-blue-500' : 'bg-zinc-300 dark:bg-zinc-700',
              ].join(' ')}>
                <span className={[
                  'inline-block h-3 w-3 rounded-full bg-white shadow transition-transform',
                  rpcChevauchement ? 'translate-x-3.5' : 'translate-x-0.5',
                ].join(' ')} />
              </span>
            </button>
          </div>
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen(o => !o)}
              className="text-xs text-zinc-400 hover:text-zinc-600 truncate max-w-32 text-right"
            >
              {userName}
            </button>
            {userMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setUserMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 min-w-36">
                  <Link
                    href="/profil"
                    className="block px-4 py-2 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700"
                    onClick={() => setUserMenuOpen(false)}
                  >
                    Mon profil
                  </Link>
                  {pushStatus === 'default' && (
                    <button
                      onClick={() => { void pushSubscribe(); setUserMenuOpen(false); }}
                      className="block w-full text-left px-4 py-2 text-sm text-blue-600 hover:bg-zinc-50 dark:hover:bg-zinc-700"
                    >
                      Activer notifications
                    </button>
                  )}
                  {pushStatus === 'subscribed' && (
                    <div className="px-4 py-2 text-[11px] text-emerald-600 dark:text-emerald-400">
                      ✓ Notifications actives
                    </div>
                  )}
                  {pushStatus === 'ios-not-installed' && (
                    <div className="px-4 py-2 text-[11px] text-zinc-500 max-w-56">
                      Notifs : installe l&apos;app via Safari → Partager → Sur l&apos;écran d&apos;accueil
                    </div>
                  )}
                  <button
                    onClick={async () => {
                      const supabase = createClient();
                      await supabase.auth.signOut();
                      router.push('/login');
                    }}
                    className="block w-full text-left px-4 py-2 text-sm text-red-500 hover:bg-zinc-50 dark:hover:bg-zinc-700"
                  >
                    Déconnexion
                  </button>
                </div>
              </>
            )}
          </div>
        </header>

        {/* Gantt area */}
        <div ref={rowRef} className={`flex-1 flex flex-col overflow-hidden ${isPending || monthLoading ? 'opacity-60 pointer-events-none' : ''}`}>

          {/* Day header */}
          <div className="flex flex-shrink-0 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900" style={{ height: DAY_H }}>
            <div className="flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800" style={{ width: LABEL_W }} />
            <div className="flex-1 grid" style={{ gridTemplateColumns: `repeat(${dim}, 1fr)` }}>
              {days.map(d => {
                const ds = `${year}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
                const dow = new Date(year, mo-1, d).getDay();
                const wknd = dow === 0 || dow === 6;
                const isToday = ds === today;
                return (
                  <div key={d} className={[
                    'flex flex-col items-center justify-center border-r border-zinc-100 dark:border-zinc-800',
                    wknd ? 'bg-zinc-100/60 dark:bg-zinc-800/40' : '',
                    isToday ? 'bg-blue-50 dark:bg-blue-950/40' : '',
                  ].join(' ')}>
                    <span className="text-[9px] font-medium text-zinc-400 uppercase">{DAY_ABBR[dow]}</span>
                    <span className={isToday
                      ? 'bg-blue-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-[9px] font-bold'
                      : `text-[11px] font-semibold ${wknd ? 'text-zinc-400' : 'text-zinc-700 dark:text-zinc-200'}`}>
                      {d}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* No-cache overlay (offline + mois non installé) */}
          {noCache && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-white dark:bg-zinc-950 text-center p-8">
              <span className="text-4xl">📵</span>
              <p className="font-semibold text-zinc-700 dark:text-zinc-200">
                {MONTH_FR[mo-1]} {year} non disponible hors ligne
              </p>
              <p className="text-xs text-zinc-400">
                Connectez-vous pour charger ce mois.
              </p>
              <button
                onClick={() => changeMonth(month)}
                className="mt-2 px-4 py-2 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm font-medium"
              >
                ← Retour à {MONTH_FR[parseInt(month.slice(5))-1]}
              </button>
            </div>
          )}

          {/* Planning rows */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {displayScenarios.map((scenario, idx) => {
              // Prime 1er mai : pMai = 1/30 × fixe + pvMai × PVEI × KSP.
              // pvMai = (hcr_crew + tsv_nuit/2) × ratio_overlap des rotations
              // chevauchant la fenêtre [01/05 00h → 02/05 00h Paris]. Cas VOL
              // uniquement ; mai uniquement.
              const primeMai = computePrimeMai(
                scenario.items, signaturesByInstId, year, mo,
                finBaseState?.fixe ?? FIXE_MENSUEL,
                finBaseState?.pvei ?? PVEI,
                finBaseState?.ksp  ?? KSP,
              );
              // Prime Noël : 0,4 × taNoel × PVEI ; calcul actif en décembre
              // uniquement, sinon 0. taNoel = chevauchement des vols (vol /
              // dda_vol / vol_p) avec la fenêtre [24/12 18h → 26/12 00h Paris].
              const primeNoel = computePrimeNoel(
                scenario.items, instancesById, year, mo, finBaseState?.pvei ?? PVEI,
              );
              // En juillet/août pour TAF*_10_12, A330 + Instruction passent à 100%
              // (× 30/nb30e pour annuler la proration appliquée en amont).
              const nb30eRegime = REGIME_NB30E[effRegime] ?? NB_30E;
              const a330InstrBoost = isFullPrimeMonth(effRegime, mo) && nb30eRegime > 0 ? 30 / nb30eRegime : 1;
              // Éléments de paie versionnés selon le mois courant (rechargés à
              // chaque changeMonth). Fallback aux constantes legacy si null.
              const pIncit  = finBaseState?.primeIncitationUnit ?? primeIncitationUnit;
              const pA330   = finBaseState?.primeA330           ?? primeA330;
              const pInstr  = finBaseState?.primeInstruction    ?? primeInstruction;
              // IrgAv : Y × 5 × PVEI (cf. CCT) — non proratisé régime.
              const pvForIrgav = finBaseState?.pvei ?? PVEI;
              const primeIrgav = irgavCount * 5 * pvForIrgav;
              const monthlyFixedPrimes =
                pIncit * incitCount
                + (pA330 + pInstr) * a330InstrBoost
                + primeIrgav
                + primeMai + primeNoel;
              const cumulBeforeForScenario = a81CumulBeforeState[scenario.name] ?? 0;
              const irMfScn = irMfState.byScenario?.[scenario.name];
              const irMfEur = (irMfScn?.ir_eur ?? 0) + (irMfScn?.mf_eur ?? 0);
              const nbActivites = countItActivities(scenario.items, year, mo);
              const itEur = computeItEur(effTransport, nbActivites, effNavigoEur, effVoitureKmAller, effVoitureIndKm);
              const stats = computeStats(
                scenario.items, year, mo, effCngPv, effCngHs, effRegime, monthlyFixedPrimes,
                article81Data, effValeurJour, cumulBeforeForScenario, irMfEur, itEur,
                finBaseState?.pvei ?? PVEI,
                finBaseState?.ksp  ?? KSP,
                finBaseState?.fixe ?? FIXE_MENSUEL,
                finBaseState?.fixeTP ?? null,
              );
              const isLast = idx === localScenarios.length - 1;
              const tafDays      = tafOk ? tafDur : 0;
              const joursProrata = stats.congeDays + tafDays;
              const jiRestants   = prorataThresholds.length > 0 ? lookupJI(joursProrata, prorataThresholds) : -1;
              const yMax         = jiRestants >= 0 ? dim - jiRestants - joursProrata : -1;
              const isDetailOpen = detailPanel?.name === scenario.name;
              return (
                <div key={scenario.name} data-sr
                  ref={el => { if (el) scenarioRowsRef.current.set(scenario.name, el); else scenarioRowsRef.current.delete(scenario.name); }}
                  className={`flex flex-1 ${!isLast ? 'border-b border-zinc-200 dark:border-zinc-800' : ''}`}
                  style={{ minHeight: ROW_H }}
                >
                  {/* Label */}
                  <div className="flex-shrink-0 flex flex-col border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 pt-1 pb-1 items-center"
                    style={{ width: LABEL_W }}>

                    {/* Nom scénario + flag DDA + ON — toujours visibles en haut */}
                    <div className="flex items-center gap-1">
                      <span className="text-base font-bold text-zinc-700 dark:text-zinc-100">{scenario.name}</span>
                      {(() => {
                        const vs = violationsByScenario.get(scenario.id) ?? [];
                        if (vs.length === 0) return null;
                        return (
                          <span
                            title={`${vs.length} violation${vs.length > 1 ? 's' : ''} DDA — voir le panneau du bas`}
                            className="text-[14px] leading-none text-amber-500 dark:text-amber-400 select-none"
                          >
                            ⚑
                          </span>
                        );
                      })()}
                    </div>
                    <div className="mb-0.5">
                      {yMax >= 0 ? (
                        <span className={`text-[9px] font-semibold font-mono px-1.5 rounded ${stats.onDays > yMax ? 'bg-red-100 dark:bg-red-950/50 text-red-600 dark:text-red-400' : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300'}`}>
                          {stats.onDays}/{yMax}ON
                        </span>
                      ) : stats.onDays > 0 ? (
                        <span className="text-[9px] font-semibold font-mono bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 px-1 rounded">
                          {stats.onDays}ON
                        </span>
                      ) : null}
                    </div>

                    {/* FinRows */}
                    <div className="w-full px-2 flex flex-col gap-[1px]">
                      <FinRow label="FIXE" value={stats.fin.fixe} cls="text-zinc-400" />
                      <div className="border-t border-zinc-300 dark:border-zinc-600 my-0.5" />
                      <FinRow label="PV"   value={stats.fin.pv}   cls="text-blue-500" />
                      {stats.fin.hs > 0 ? (
                        <FinRow label={`HS(${stats.hsH.toFixed(1)}h)`} value={stats.fin.hs} cls="text-green-500" />
                      ) : (
                        <FinRow label={`HS(−${Math.max(0, stats.hsSeuil - stats.totalHc).toFixed(1)}h)`} value={0} cls="text-zinc-400 dark:text-zinc-500" />
                      )}
                      <div className="border-t border-zinc-300 dark:border-zinc-600 my-0.5" />
                      <FinRow label="PV+HS" value={stats.fin.pv + stats.fin.hs} cls="text-zinc-700 dark:text-zinc-100" bold />
                      <FinRow label="MGA"   value={stats.fin.mga}   cls="text-zinc-500" />
                      <FinRow label="DIFF"  value={stats.fin.diff}  cls={stats.fin.diff < 0 ? 'text-red-500' : 'text-emerald-500'} />
                      <div className="border-t border-dashed border-zinc-300 dark:border-zinc-600 my-0.5" />
                      <FinRow label="BRUT" value={stats.brut} cls="text-emerald-600 dark:text-emerald-400" bold />
                      <div className="border-t border-dashed border-emerald-300 dark:border-emerald-700/40 my-0.5" />
                      <FinRow label="A81" value={stats.totalA81} cls="text-zinc-400" />
                      {stats.totalA81 > 0 && (
                        <div className="flex items-baseline justify-between gap-0.5">
                          <span className="text-[7.5px] font-mono leading-none text-emerald-600/70 dark:text-emerald-400/60">
                            {stats.cumulJoursRunning.toFixed(1)}/{stats.plafondJours}j
                          </span>
                          {stats.cumulJoursRunning >= stats.plafondJours && (
                            <span className="text-[7.5px] font-bold leading-none text-amber-500">PLAFOND</span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Bouton détail — toujours épinglé en bas */}
                    <button
                      onClick={e => {
                        if (isDetailOpen) { setDetailPanel(null); return; }
                        // Anchor sur la row (pas sur le bouton, qui est en bas de la
                        // colonne label et donne un rect mid/bottom de viewport →
                        // panneau qui déborde ou disparaît pour B/C).
                        const rowEl = scenarioRowsRef.current.get(scenario.name);
                        const rect  = rowEl?.getBoundingClientRect() ?? e.currentTarget.getBoundingClientRect();
                        const pveiEff   = finBaseState?.pvei ?? PVEI;
                        const kspEff    = finBaseState?.ksp  ?? KSP;
                        const fixeReg   = finBaseState?.fixe ?? FIXE_MENSUEL;
                        const pvHcrEur  = stats.totalHcr * pveiEff * kspEff;
                        const pvNuitEur = (stats.totalTsvNuit / 2) * pveiEff * kspEff;
                        const nb30eReg2 = REGIME_NB30E[effRegime] ?? NB_30E;
                        const fixeTPEff = finBaseState?.fixeTP ?? (nb30eReg2 > 0 ? FIXE_MENSUEL * 30 / nb30eReg2 : FIXE_MENSUEL);
                        const fixeFF    = isFullPrimeMonth(effRegime, mo) ? fixeTPEff : fixeReg;
                        const bitroncon = stats.totalPrime * 2.5 * pveiEff;
                        const boost     = isFullPrimeMonth(effRegime, mo) && nb30eReg2 > 0 ? 30 / nb30eReg2 : 1;
                        setDetailPanel({
                          name: scenario.name, rect,
                          viewportH: window.visualViewport?.height ?? window.innerHeight,
                          pvEur: stats.fin.pv, pvHcrEur, pvNuitEur,
                          flightBreakdown: stats.flightBreakdown,
                          solDays: stats.solDays, simDays: stats.simDays,
                          solHcrEur: stats.solHcrEur, simHcrEur: stats.simHcrEur,
                          totalHc: stats.totalHc, seuil75: stats.hsSeuil,
                          hsH: stats.hsH, hsEur: stats.fin.hs,
                          hsFixeRate: stats.hsFixeRate, hsVolRate: stats.hsVolRate,
                          fixeForFin: fixeFF,
                          totalNew: stats.fin.total, mga: stats.fin.mga, diff: stats.fin.diff,
                          pveiEff, kspEff, nb30eEff: stats.nb30eEff,
                          totalPrime: stats.totalPrime, bitronconEur: bitroncon,
                          incitation: incitCount * (finBaseState?.primeIncitationUnit ?? primeIncitationUnit),
                          a330: (finBaseState?.primeA330 ?? primeA330) * boost,
                          instruction: (finBaseState?.primeInstruction ?? primeInstruction) * boost,
                          irgav: irgavCount * 5 * (finBaseState?.pvei ?? PVEI),
                          primeMai, primeNoel,
                          primesTotal: stats.fin.primes,
                          congeDays: stats.congeDays, cngPv: effCngPv, cngHs: effCngHs, congeAmount: stats.congeAmount,
                          irEur: irMfScn?.ir_eur ?? 0,
                          mfEur: irMfScn?.mf_eur ?? 0,
                          irMfPerFlight: irMfState.perFlightByScenario?.[scenario.name] ?? [],
                          itEur,
                          itMode: effTransport,
                          itNbActivites: nbActivites,
                          itPerActivite: 2 * effVoitureKmAller * effVoitureIndKm,
                          brut: stats.brut,
                        });
                      }}
                      className={`mt-1 flex-shrink-0 text-[9px] font-mono select-none px-2 py-0.5 rounded transition-colors ${isDetailOpen ? 'bg-zinc-700 text-white' : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-300 hover:bg-zinc-300 dark:hover:bg-zinc-600'}`}
                    >
                      {isDetailOpen ? '◀ fermer' : '▶ détail'}
                    </button>
                  </div>

                  {/* Day grid + bars */}
                  <div className="flex-1 relative overflow-hidden">
                    {/* Background columns */}
                    <div className="absolute inset-0 grid pointer-events-none"
                      style={{ gridTemplateColumns: `repeat(${dim}, 1fr)` }}>
                      {days.map(d => {
                        const ds = `${year}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
                        const wknd = isWeekend(year, mo, d);
                        const isToday = ds === today;
                        return (
                          <div key={d} className={[
                            'h-full border-r border-zinc-100 dark:border-zinc-800/50',
                            wknd ? 'bg-zinc-50/80 dark:bg-zinc-800/20' : '',
                            isToday ? 'bg-blue-50/50 dark:bg-blue-950/20' : '',
                          ].join(' ')} />
                        );
                      })}
                    </div>

                    {/* Clickable day cells */}
                    <div className="absolute inset-0 grid"
                      style={{ gridTemplateColumns: `repeat(${dim}, 1fr)` }}>
                      {days.map(d => {
                        const ds = `${year}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
                        return (
                          <button key={d} className="h-full hover:bg-blue-50/30 dark:hover:bg-blue-900/10 transition-colors"
                            onClick={() => openAdd(scenario.id, scenario.name, ds)} />
                        );
                      })}
                    </div>

                    {/* Today line */}
                    {today.startsWith(`${year}-${String(mo).padStart(2,'0')}-`) && (() => {
                      const td = dayNum(today);
                      const leftPct = ((td - 0.5) / dim) * 100;
                      return <div className="absolute top-0 bottom-0 w-px bg-blue-400 dark:bg-blue-500 pointer-events-none z-20"
                        style={{ left: `${leftPct}%` }} />;
                    })()}

                    {/* Activity bars */}
                    {scenario.items.map(item => {
                      const clip = clipItem(item, year, mo);
                      if (!clip) return null;
                      const hasMep = item.pairing_instance_id
                        ? signaturesByInstId.get(item.pairing_instance_id)?.dead_head === true
                        : false;
                      return (
                        <DraggableBar
                          key={item.id}
                          item={item}
                          clip={clip}
                          dim={dim}
                          year={year}
                          mo={mo}
                          onEdit={(it) => openEdit(it, scenario)}
                          isDragSource={dragging?.id === item.id}
                          scenarioItems={scenario.items}
                          rpcChevauchement={rpcChevauchement}
                          isFictive={fictiveMonths.includes(item.start_date.slice(0, 7))}
                          pvei={finBaseState?.pvei ?? PVEI}
                          ksp={finBaseState?.ksp ?? KSP}
                          hasMep={hasMep}
                        />
                      );
                    })}

                    {/* Overlay violations DDA — bandeau fin transparent positionné
                        juste sous la ligne RPC. ROUGE pour les violations
                        réelles, VERT pour les cas "af_only" (AF flagge à tort,
                        en vrai c'est licite via RPC reporté à travers CONGES).
                        Cliquable → popover avec la règle + l'action "Reporter
                        RPC" si applicable. */}
                    {(violationsByScenario.get(scenario.id) ?? []).map(v => {
                      const clip = clipViolationGap(v.pivot_date, v.b_start_date, year, mo);
                      if (!clip) return null;
                      const isOpen = violationPopover?.key === `${v.item_a_id}-${v.item_b_id}`;
                      const afOnly = v.af_only === true;
                      const colorCls = afOnly
                        ? (isOpen
                            ? 'bg-emerald-500/60 dark:bg-emerald-500/70 border-x border-emerald-700'
                            : 'bg-emerald-500/35 dark:bg-emerald-500/45 border-x border-emerald-500/70 hover:bg-emerald-500/55')
                        : (isOpen
                            ? 'bg-red-500/60 dark:bg-red-500/70 border-x border-red-700'
                            : 'bg-red-500/35 dark:bg-red-500/45 border-x border-red-500/70 hover:bg-red-500/55');
                      return (
                        <button
                          key={`viol-${v.item_a_id}-${v.item_b_id}`}
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            setViolationPopover({
                              key: `${v.item_a_id}-${v.item_b_id}`,
                              rule: v.rule_label,
                              catA: v.cat_a, catB: v.cat_b,
                              gap: v.gap_days, rpc: v.rpc_days,
                              canReport: v.can_accept_rpc_report ?? false,
                              itemAId: v.item_a_id,
                              afOnly,
                              realRule: v.real_rule_label,
                              left: rect.left + rect.width / 2,
                              top:  rect.bottom + 6,
                            });
                          }}
                          title={afOnly
                            ? 'AF flagge mais licite (RPC reporté) — cliquer pour le détail'
                            : 'Cliquer pour voir la règle violée'}
                          className={['absolute z-[11] rounded-sm transition-colors cursor-pointer', colorCls].join(' ')}
                          style={{
                            left:   `${clip.left}%`,
                            width:  `${clip.width}%`,
                            top:    `calc(50% + ${REST_H / 2 + 4}px)`,
                            height: 15,
                          }}
                        />
                      );
                    })}

                    {/* Notes utilisateur (cross-scénario) — bar fine en bas
                        de chaque ligne A/B/C. Click = édit. Empilées si
                        plusieurs notes le même jour. */}
                    {(() => {
                      const noteRows: typeof localNotes[] = [];
                      for (const n of localNotes) {
                        // start_date / end_date sont calendaires. On clip au mois courant.
                        const ns = n.start_date.slice(0, 7) > `${year}-${String(mo).padStart(2,'0')}`
                          ? null : n.start_date;
                        const ne = n.end_date.slice(0, 7) < `${year}-${String(mo).padStart(2,'0')}`
                          ? null : n.end_date;
                        if (!ns || !ne) continue;
                        // Stack : place dans la 1ère row sans chevauchement.
                        let placed = false;
                        for (const row of noteRows) {
                          if (!row.some(r => r.start_date <= n.end_date && r.end_date >= n.start_date)) {
                            row.push(n); placed = true; break;
                          }
                        }
                        if (!placed) noteRows.push([n]);
                      }
                      const NOTE_H = 10;
                      return noteRows.map((row, rowIdx) => row.map(n => {
                        const start = n.start_date.slice(0,7) < `${year}-${String(mo).padStart(2,'0')}`
                          ? 1 : dayNum(n.start_date);
                        const end = n.end_date.slice(0,7) > `${year}-${String(mo).padStart(2,'0')}`
                          ? dim : dayNum(n.end_date);
                        const left = ((start - 1) / dim) * 100;
                        const width = ((end - start + 1) / dim) * 100;
                        const top = ROW_H - 14 - rowIdx * (NOTE_H + 2);
                        return (
                          <button
                            key={n.id + '-r' + rowIdx}
                            onClick={() => {
                              setNoteText(n.text);
                              setNoteEnd(n.end_date);
                              setNoteSheet({ mode: 'edit', note: n });
                            }}
                            title={n.text}
                            className="absolute z-[9] rounded-sm bg-amber-200 hover:bg-amber-300 dark:bg-amber-900/60 dark:hover:bg-amber-800/80 text-amber-900 dark:text-amber-200 text-[9px] font-medium px-1 truncate text-left overflow-hidden whitespace-nowrap"
                            style={{ left: `${left}%`, width: `${width}%`, top, height: NOTE_H, lineHeight: `${NOTE_H}px` }}
                          >
                            {n.text}
                          </button>
                        );
                      }));
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* (Violations DDA : visualisées en overlay rouge transparent dans
             chaque ligne Gantt — voir le rendu plus haut.) */}

        {/* Action bar */}
        <div className="flex-shrink-0 flex items-center gap-2 h-14 border-t border-zinc-200 dark:border-zinc-800 px-4 bg-zinc-50 dark:bg-zinc-900 overflow-x-auto">

          {/* Sélecteurs primes — popovers déclenchés par boutons compacts */}
          <PrimePicker
            label="Incit."
            title="Prime d'incitation"
            value={incitCount}
            range={[0, 1, 2, 3, 4, 5]}
            onChange={changeIncit}
            open={primeMenuOpen === 'incit'}
            onToggle={() => setPrimeMenuOpen(s => s === 'incit' ? null : 'incit')}
            onClose={() => setPrimeMenuOpen(null)}
          />
          <PrimePicker
            label="IrgAv"
            title="Prime IrgAv (Y × 5 × PVEI)"
            value={irgavCount}
            range={[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]}
            onChange={changeIrgav}
            open={primeMenuOpen === 'irgav'}
            onToggle={() => setPrimeMenuOpen(s => s === 'irgav' ? null : 'irgav')}
            onClose={() => setPrimeMenuOpen(null)}
          />

          {/* Propagation X → Y */}
          <div className="flex-shrink-0 flex items-center gap-1.5 ml-2 pl-2 border-l border-zinc-200 dark:border-zinc-700">
            <button
              onClick={() => setCopyModal({ source: 'A', target: 'B' })}
              className="px-2.5 py-1 rounded-full bg-zinc-200 hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-200 text-xs font-semibold transition-colors"
              title="Copier le contenu d'un scénario vers un autre"
            >
              X → Y
            </button>
            {propagateMsg && (
              <span className="text-[10px] text-zinc-500 dark:text-zinc-400 ml-1 whitespace-nowrap">
                {propagateMsg}
              </span>
            )}
          </div>

          {/* Reset */}
          <div className="flex-shrink-0 ml-2 pl-2 border-l border-zinc-200 dark:border-zinc-700">
            <button
              ref={resetButtonRef}
              onClick={() => {
                if (resetMenuOpen) { setResetMenuOpen(false); return; }
                const rect = resetButtonRef.current?.getBoundingClientRect();
                if (rect) {
                  setResetMenuPos({
                    left: rect.left,
                    bottom: window.innerHeight - rect.top + 4,
                  });
                }
                setResetMenuOpen(true);
              }}
              className="px-2.5 py-1 rounded-full bg-zinc-200 hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-200 text-xs font-semibold transition-colors"
              title="Réinitialiser un scénario"
            >
              Reset
            </button>
          </div>

          <button
            onClick={e => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setCategoryPicker({ rect });
            }}
            className="ml-auto flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            Rotations
          </button>
          {/* Import button — admins + scrapers */}
          {canScrape && (
            <button
              onClick={() => setScrapeOpen(true)}
              className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-700 hover:bg-zinc-600 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-white text-xs font-semibold transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              Importer
            </button>
          )}
        </div>

        {/* Reset dropdown — rendu en fixed pour échapper au clipping de l'action bar (overflow-x-auto) */}
        {resetMenuOpen && resetMenuPos && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setResetMenuOpen(false)} />
            <div
              className="fixed z-50 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 min-w-28"
              style={{ left: resetMenuPos.left, bottom: resetMenuPos.bottom }}
            >
              {(['A', 'B', 'C', 'tout'] as const).map(t => (
                <button key={t}
                  onClick={() => { setResetTarget(t); setResetMenuOpen(false); }}
                  className="block w-full text-left px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700">
                  {t === 'tout' ? 'Tout (A + B + C)' : `Scénario ${t}`}
                </button>
              ))}
            </div>
          </>
        )}

        {/* Modale de confirmation reset */}
        {resetTarget && (
          <>
            <div className="fixed inset-0 z-50 bg-black/40" onClick={() => !resetting && setResetTarget(null)} />
            <div className="fixed inset-x-4 top-1/2 -translate-y-1/2 z-50 max-w-sm mx-auto bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl p-5 space-y-4">
              <h2 className="font-semibold text-sm">Réinitialiser le planning</h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-300">
                Toutes les activités (vols, off, congés, ...) du{' '}
                {resetTarget === 'tout'
                  ? <strong>mois entier (A + B + C)</strong>
                  : <>scénario <strong>{resetTarget}</strong></>}{' '}
                vont être supprimées. Cette action est irréversible.
              </p>
              <div className="flex gap-2">
                <button onClick={() => setResetTarget(null)} disabled={resetting}
                  className="flex-1 py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 text-sm font-semibold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50">
                  Annuler
                </button>
                <button onClick={handleReset} disabled={resetting}
                  className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-semibold disabled:opacity-50">
                  {resetting ? 'Suppression…' : 'Confirmer'}
                </button>
              </div>
            </div>
          </>
        )}

        {/* Modale copie X → Y */}
        {copyModal && (() => {
          const { source, target } = copyModal;
          const sameSel = source === target;
          const sourceItems = localScenarios.find(s => s.name === source)?.items.filter(it => !it._isSpillover) ?? [];
          const targetItems = localScenarios.find(s => s.name === target)?.items.filter(it => !it._isSpillover) ?? [];
          const nothingToDo = !sameSel && sourceItems.length === 0 && targetItems.length === 0;
          return (
            <>
              <div className="fixed inset-0 z-50 bg-black/40" onClick={() => setCopyModal(null)} />
              <div className="fixed inset-x-4 top-1/2 -translate-y-1/2 z-50 max-w-sm mx-auto bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl p-5 space-y-4">
                <h2 className="font-semibold text-sm">Copier un scénario</h2>
                <div className="flex items-center justify-center gap-3">
                  <select
                    value={source}
                    onChange={e => setCopyModal(c => c ? { ...c, source: e.target.value as ScenarioName } : c)}
                    className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm font-semibold"
                  >
                    {(['A', 'B', 'C'] as ScenarioName[]).map(n => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                  <span className="text-zinc-400">→</span>
                  <select
                    value={target}
                    onChange={e => setCopyModal(c => c ? { ...c, target: e.target.value as ScenarioName } : c)}
                    className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm font-semibold"
                  >
                    {(['A', 'B', 'C'] as ScenarioName[]).map(n => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>
                {sameSel ? (
                  <p className="text-xs text-red-500">Source et cible doivent être différentes.</p>
                ) : nothingToDo ? (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {source} est vide — rien à propager.
                  </p>
                ) : (
                  <p className="text-sm text-zinc-600 dark:text-zinc-300">
                    {targetItems.length > 0
                      ? <>Écraser la ligne <strong>{target}</strong> ({targetItems.length} activité{targetItems.length > 1 ? 's' : ''}) et la remplacer par le contenu de <strong>{source}</strong> ({sourceItems.length}) ?</>
                      : <>Copier le contenu de <strong>{source}</strong> ({sourceItems.length} activité{sourceItems.length > 1 ? 's' : ''}) vers la ligne <strong>{target}</strong> ?</>}
                  </p>
                )}
                <div className="flex gap-2">
                  <button onClick={() => setCopyModal(null)}
                    className="flex-1 py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 text-sm font-semibold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800">
                    Annuler
                  </button>
                  <button
                    onClick={() => { propagateFlights(source, target); setCopyModal(null); }}
                    disabled={sameSel || nothingToDo}
                    className="flex-1 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-700 dark:bg-zinc-100 dark:hover:bg-zinc-300 text-white dark:text-zinc-900 text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed">
                    OK
                  </button>
                </div>
              </div>
            </>
          );
        })()}

        {/* Sheet */}
        {sheet && (
          <>
            <div className="fixed inset-0 z-20 bg-black/20" onClick={() => setSheet(null)} />
            <div
              className="fixed bottom-0 left-0 right-0 z-30 bg-white dark:bg-zinc-900 rounded-t-2xl shadow-xl overflow-y-auto"
              style={editSheetTop != null ? { top: editSheetTop } : undefined}
            >
              {/* Edit-flight : X positionné en absolu en haut-droite pour
                  libérer le flux et coller le contenu en haut de la zone. */}
              {sheet.mode === 'edit' && sheet.item?.kind === 'flight' && (
                <button
                  onClick={() => setSheet(null)}
                  className="absolute top-2 right-3 z-10 text-zinc-400 hover:text-zinc-600 text-2xl leading-none"
                  aria-label="Fermer"
                >×</button>
              )}
              <div className="p-5 space-y-4 h-full flex flex-col">

                {/* Sheet header — masqué en edit-flight (X est en absolu et
                    scn+date sont dans la colonne gauche du layout 2 cols). */}
                {!(sheet.mode === 'edit' && sheet.item?.kind === 'flight') && (
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
                        Scénario {sheet.scenarioName}
                      </span>
                      <h2 className="font-semibold capitalize">
                        {new Date(sheet.date + 'T00:00:00').toLocaleDateString('fr-FR', {
                          weekday: 'long', day: 'numeric', month: 'long',
                        })}
                      </h2>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setSheet(null)} className="text-zinc-400 hover:text-zinc-600 text-2xl leading-none">×</button>
                    </div>
                  </div>
                )}

                {/* Kind selector (hide in edit mode).
                    Deux modes mutuellement exclusifs dans le même cadre :
                    - défaut : Rotations + activités (off/congés/CSS/...) + Note
                    - sheetCategoryMode : ← retour + DDA / Vol P / Élabo/Suivi
                      (déclenché par clic sur Rotations) */}
                {sheet.mode === 'add' && !sheetCategoryMode && (
                  <div className="flex flex-wrap gap-2 items-center">
                    {/* Bouton "Rotations" (tout à gauche) — bascule l'intérieur du
                        sheet en mode "choix de catégorie" (DDA/Vol P/Élabo) dans
                        le MÊME cadre, sans ouvrir de popup séparé. */}
                    <button
                      onClick={() => setSheetCategoryMode(true)}
                      className="px-4 py-2 rounded-lg text-sm font-medium border-2 border-transparent bg-blue-600 hover:bg-blue-500 text-white transition-all flex items-center gap-1.5"
                      title="Rechercher une rotation partant ce jour"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                      </svg>
                      Rotations
                    </button>
                    {addableKinds.map(k => {
                      const meta = ACTIVITY_META[k];
                      const disabled = k === 'taf' && !tafOk;
                      return (
                        <button key={k} onClick={() => !disabled && handleKindChange(k)}
                          disabled={disabled}
                          title={disabled ? 'Non disponible en juillet/août (régime 10 mois)' : undefined}
                          className={[
                            'px-4 py-2 rounded-lg text-sm font-medium border-2 transition-all',
                            addKind === k ? 'border-zinc-800 dark:border-zinc-200 scale-105' : 'border-transparent',
                            disabled ? 'opacity-30 cursor-not-allowed' : '',
                          ].join(' ')}
                          style={{ backgroundColor: meta.color, color: meta.textColor }}>
                          {meta.label}
                          {k === 'taf' && tafDur ? ` (${tafDur}j)` : ''}
                        </button>
                      );
                    })}
                    {/* Bouton "Note" — bascule vers le note sheet (cross-scénario). */}
                    <button
                      onClick={() => {
                        const d = sheet.date;
                        setSheet(null);
                        setNoteText('');
                        setNoteEnd(d);
                        setNoteSheet({ mode: 'add', date: d });
                      }}
                      className="px-4 py-2 rounded-lg text-sm font-medium border-2 border-dashed border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:border-amber-400 hover:text-amber-600 transition-all"
                      title="Note libre (cross-scénario, indépendante d'un vol)"
                    >
                      📝 Note
                    </button>
                  </div>
                )}

                {/* Mode "choix de catégorie" — inline dans le sheet, déclenché
                    par le bouton Rotations. Le clic sur une catégorie ouvre
                    direct le SearchPanel (scénario + date déjà connus). */}
                {sheet.mode === 'add' && sheetCategoryMode && (
                  <div className="flex flex-wrap gap-2 items-center">
                    <button
                      onClick={() => setSheetCategoryMode(false)}
                      className="px-3 py-2 rounded-lg text-sm font-medium border-2 border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:border-zinc-400 transition-all"
                      title="Retour"
                    >
                      ←
                    </button>
                    {([
                      { value: 'dda_vol',     label: 'DDA' },
                      { value: 'vol_p',       label: 'Vol P' },
                      { value: 'elabo_suivi', label: 'Élabo/Suivi' },
                    ] as { value: BidCategory; label: string }[]).map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => {
                          const d = sheet.date;
                          const scName = sheet.scenarioName;
                          const rowEl = scenarioRowsRef.current.get(scName);
                          setSearchCategory(opt.value);
                          setSearchScenario(scName);
                          setSearchDate(d);
                          setSearchPanelTop(rowEl?.getBoundingClientRect().bottom);
                          setSheet(null);
                          setSheetCategoryMode(false);
                          setSearchOpen(true);
                        }}
                        className="px-4 py-2 rounded-lg text-sm font-bold border-2 border-transparent bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-zinc-700 dark:hover:bg-zinc-300 transition-all"
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}

                {/* Inputs durée + Submit : masqués en mode catégorie (le cadre
                    ne montre alors que les boutons DDA/Vol P/Élabo). */}
                {!sheetCategoryMode && <>
                {/* Congés / CSS / DDA REPOS : nb de jours via <select> natif —
                    sur iPad PWA standalone, ouvre le wheel picker iOS au lieu
                    du keyboard numérique (cf. demande UX 2026-06-17 PM). */}
                {(addKind === 'conge' || addKind === 'conge_ss' || addKind === 'off') && (() => {
                  // DDA repos : borne haute dure = max auto-calculé. Sélecteur
                  // limité 1..max et désactivé si prorata saturé (max=0).
                  const isOff   = addKind === 'off';
                  const offMax  = ddaCalc?.max ?? 0;
                  const optCount = isOff ? offMax : 31;
                  const selDisabled = isOff && offMax === 0;
                  return (
                  <div className="flex items-center gap-3">
                    <label className="text-sm text-zinc-600 dark:text-zinc-300 font-medium">Nb. de jours</label>
                    <select
                      value={nbJours || '1'}
                      onChange={e => handleNbJoursChange(e.target.value)}
                      disabled={selDisabled}
                      className="w-20 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-center font-semibold disabled:opacity-40"
                    >
                      {Array.from({ length: optCount }, (_, i) => i + 1).map(n => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                    {!selDisabled && nbJours && parseInt(nbJours) >= 1 && (
                      <span className="text-sm text-zinc-500">
                        → {new Date(computedEnd + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}
                      </span>
                    )}
                  </div>
                  );
                })()}

                {/* DDA repos : mention informative (gris) + cas saturé +
                    avertissement bloc existant (un seul DDA repos par mois). */}
                {addKind === 'off' && ddaCalc && (
                  <div className="space-y-2">
                    {ddaCalc.max > 0 ? (
                      <p className="text-xs leading-relaxed text-zinc-400 dark:text-zinc-500 whitespace-pre-line">
                        {`Max : ${ddaCalc.max} jours\n`}
                        {`Jours de prorata = ${ddaCalc.tafDays} + ${ddaCalc.congeDays} = ${ddaCalc.jp}\n`}
                        {`JI mensuel restant = ${ddaCalc.jiRestants}`}
                      </p>
                    ) : (
                      <p className="text-xs leading-relaxed text-amber-600 dark:text-amber-400">
                        Aucun DDA repos possible : le quota mensuel est saturé
                        (jours de prorata = {ddaCalc.tafDays} + {ddaCalc.congeDays} = {ddaCalc.jp} &gt; 27,
                        JI mensuel restant = {ddaCalc.jiRestants}).
                      </p>
                    )}
                    {ddaCalc.max > 0 && ddaCalc.existing && (
                      <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
                        ⚠ Le nouveau DDA repos supprimera le DDA repos existant.
                      </p>
                    )}
                  </div>
                )}

                {/* TAF: info durée */}
                {addKind === 'taf' && (
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-zinc-600 dark:text-zinc-300 font-medium">
                      Durée : <strong>{tafDur} jours</strong>
                    </span>
                    <span className="text-sm text-zinc-500">
                      → {new Date(computedEnd + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}
                    </span>
                  </div>
                )}

                {/* Sol/medical/autre/sim/instr: date fin libre — non applicable
                    au vol (dates fixées par la rotation) en mode edit-flight.
                    'off' (DDA REPOS) utilise désormais le sélecteur Nb. de jours
                    ci-dessus, donc exclu d'ici. */}
                {addKind !== 'conge' && addKind !== 'conge_ss' && addKind !== 'taf' && addKind !== 'off' &&
                  !(sheet.mode === 'edit' && sheet.item?.kind === 'flight') && (
                  <div className="flex items-center gap-3">
                    <label className="text-xs text-zinc-500">Jusqu&apos;au</label>
                    <input type="date" value={addEnd} min={sheet.date}
                      onChange={e => { setAddEnd(e.target.value); setOverlapErr(false); }}
                      className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm" />
                  </div>
                )}

                {/* Edit: show current dates */}
                {sheet.mode === 'edit' && sheet.item && (addKind === 'conge' || addKind === 'conge_ss' || addKind === 'off') && (
                  <p className="text-xs text-zinc-400">
                    Modifiez le nombre de jours pour réduire ou agrandir le bloc (le premier jour reste fixe).
                  </p>
                )}

                {/* Edit-flight : layout 2 colonnes (1/3 gauche, 2/3 droite).
                    Gauche : Scénario + Date + Catégorie (DDA / Vol P / Élabo).
                    Droite : valeurs (HC, HCr, PVnuit, HCr+nuit, PV €, prime
                    bi-tronçon, A81/jour, A81 total + MEP si applicable).
                    100% offline : meta du vol + signaturesByInstId (cache IDB)
                    + finBaseState/article81Data (annexe cachée). Aucun fetch. */}
                {sheet.mode === 'edit' && sheet.item && sheet.item.kind === 'flight' && (() => {
                  const m = sheet.item.meta && typeof sheet.item.meta === 'object' && !Array.isArray(sheet.item.meta)
                    ? sheet.item.meta as Record<string, unknown> : null;
                  if (!m) return null;
                  const hcM       = typeof m.hc          === 'number' ? m.hc          : null;
                  const hcrCrewM  = typeof m.hcr_crew    === 'number' ? m.hcr_crew    : null;
                  const tsvNuitM  = typeof m.tsv_nuit    === 'number' ? m.tsv_nuit    : 0;
                  const primeM    = typeof m.prime       === 'number' ? m.prime       : 0;
                  const tempsSejM = typeof m.temps_sej   === 'number' ? m.temps_sej   : null;
                  const zoneM     = typeof m.zone        === 'string' ? m.zone        : null;
                  const departAtM = typeof m.depart_at   === 'string' ? m.depart_at   : null;
                  const arriveeAtM = typeof m.arrivee_at === 'string' ? m.arrivee_at  : null;
                  const fmtDateTime = (iso: string): string => {
                    const d = new Date(iso);
                    if (Number.isNaN(d.getTime())) return iso;
                    // Format UTC : "Lun 15/06 10:30" — canonique aviation.
                    const days = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
                    const dd = String(d.getUTCDate()).padStart(2, '0');
                    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
                    const hh = String(d.getUTCHours()).padStart(2, '0');
                    const mi = String(d.getUTCMinutes()).padStart(2, '0');
                    return `${days[d.getUTCDay()]} ${dd}/${mm} ${hh}:${mi}`;
                  };
                  const instId    = sheet.item.pairing_instance_id;
                  const sig       = instId ? signaturesByInstId.get(instId) : null;
                  const isMep     = sig?.dead_head === true;
                  const mepFlight = sig?.mep_flight ?? '';

                  const pveiUse = finBaseState?.pvei ?? PVEI;
                  const kspUse  = finBaseState?.ksp  ?? KSP;

                  const pvNuitH = tsvNuitM / 2;
                  const pvH     = (hcrCrewM ?? 0) + pvNuitH;
                  const pvEur   = pvH * pveiUse * kspUse;
                  const primeEur = primeM * 2.5 * pveiUse;

                  const a81 = tempsSejM != null && zoneM
                    ? computeArticle81({
                        tSej: tempsSejM + TAXI_TSEJ_ADJUST_H,
                        zone: zoneM,
                        valeurJour: effValeurJour,
                        data: article81Data,
                      })
                    : null;

                  const Info = ({ label, value }: { label: string; value: string }) => (
                    <div className="flex flex-col">
                      <span className="text-[9px] text-zinc-400 uppercase tracking-wide leading-tight">{label}</span>
                      <span className="font-mono text-xs text-zinc-700 dark:text-zinc-200">{value}</span>
                    </div>
                  );

                  return (
                    <div className="grid grid-cols-3 gap-4 flex-1 min-h-0">
                      {/* Colonne gauche 1/3 : scénario + date + catégorie */}
                      <div className="col-span-1 space-y-3">
                        <div>
                          <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
                            Scénario {sheet.scenarioName}
                          </span>
                          <h2 className="font-semibold capitalize text-sm leading-tight">
                            {new Date(sheet.date + 'T00:00:00').toLocaleDateString('fr-FR', {
                              weekday: 'long', day: 'numeric', month: 'long',
                            })}
                          </h2>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide">Catégorie</span>
                          <div className="flex gap-1.5">
                            {([
                              { value: 'dda_vol',     label: 'DDA' },
                              { value: 'vol_p',       label: 'Vol P' },
                              { value: 'elabo_suivi', label: 'Élabo/Suivi' },
                            ] as { value: BidCategory; label: string }[]).map(opt => (
                              <button
                                key={opt.value}
                                onClick={() => setEditBidCat(opt.value)}
                                className={[
                                  'flex-1 px-2 py-1.5 rounded-lg text-xs font-semibold border transition-all min-h-[36px] text-center whitespace-nowrap',
                                  editBidCat === opt.value
                                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300'
                                    : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:border-zinc-400',
                                ].join(' ')}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      {/* Colonne droite 2/3 : valeurs */}
                      <div className="col-span-2 space-y-3 border-l border-zinc-100 dark:border-zinc-800 pl-4">
                        {isMep && (
                          <p className="text-xs text-orange-500 font-semibold">
                            MEP{mepFlight ? ` · ${mepFlight}` : ''}
                          </p>
                        )}
                        {(departAtM || arriveeAtM) && (
                          <div className="grid grid-cols-2 gap-3">
                            {departAtM  && <Info label="Premier départ"  value={fmtDateTime(departAtM)} />}
                            {arriveeAtM && <Info label="Dernier arrivée" value={fmtDateTime(arriveeAtM)} />}
                          </div>
                        )}
                        <div className="grid grid-cols-3 gap-3">
                          {hcM !== null      && <Info label="HC"           value={`${hcM.toFixed(2)} h`} />}
                          {hcrCrewM !== null && <Info label="HCr"          value={`${hcrCrewM.toFixed(2)} h`} />}
                          <Info                       label="PV nuit"      value={`${pvNuitH.toFixed(2)} h`} />
                          <Info                       label="HCr + nuit"   value={`${pvH.toFixed(2)} h`} />
                          <Info                       label="PV"           value={`${Math.round(pvEur)} €`} />
                          {primeM > 0 && <Info        label="Prime bi-tr." value={`×${primeM} · ${Math.round(primeEur)} €`} />}
                          {a81 && a81.montantPrimeSej > 0 && (
                            <Info label="A81 / jour" value={`${Math.round(a81.montantPrimeSejJour)} €`} />
                          )}
                          {a81 && a81.montantPrimeSej > 0 && (
                            <Info label="A81 total"  value={`${Math.round(a81.montantPrimeSej)} €`} />
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Overlap error */}
                {overlapErr && (
                  <p className="text-sm text-red-500 font-medium">
                    ⚠ Cette période chevauche une activité existante.
                  </p>
                )}

                {/* Submit (+ Supprimer en mode edit) — full-width en add,
                    splittés 50/50 en edit avec Supprimer rouge à droite.
                    mt-auto pousse les boutons en bas quand la sheet est tall
                    (edit-flight depuis le haut de la ligne C). */}
                {sheet.mode === 'edit' ? (
                  <div className="flex gap-2 mt-auto">
                    <button onClick={handleSubmit} disabled={isPending}
                      className="flex-1 rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">
                      Mettre à jour
                    </button>
                    <button onClick={handleDelete} disabled={isPending}
                      className="flex-1 rounded-lg bg-red-600 hover:bg-red-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40">
                      Supprimer
                    </button>
                  </div>
                ) : (
                  <button onClick={handleSubmit}
                    disabled={isPending
                      || ((addKind === 'conge' || addKind === 'conge_ss' || addKind === 'off') && !nbJours)
                      || (addKind === 'off' && (ddaCalc?.max ?? 0) === 0)}
                    className="w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">
                    {addKind === 'off' && ddaCalc?.existing ? 'Remplacer le DDA repos' : 'Placer'}
                  </button>
                )}
                </>}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Picker catégorie — étape 1 (apparait au clic sur "Rotations") */}
      {categoryPicker && (() => {
        // Ancrage : on tente d'aligner le bord gauche du picker sur celui du
        // bouton, en clampant pour ne jamais sortir du viewport (déborderait
        // à gauche quand le bouton est à gauche du day-sheet, à droite quand
        // il s'agit du bouton de la barre du bas). Largeur estimée ~320px.
        const PICKER_W = 320;
        const left = Math.max(8, Math.min(
          categoryPicker.rect.left,
          window.innerWidth - PICKER_W - 8,
        ));
        return (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setCategoryPicker(null)} />
          <div
            className="fixed z-50 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-2xl shadow-2xl p-3 flex flex-col gap-2"
            style={{
              bottom: window.innerHeight - categoryPicker.rect.top + 8,
              left,
            }}
          >
            <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide">Catégorie</span>
            <div className="flex gap-2">
              {([
                { value: 'dda_vol',     label: 'DDA' },
                { value: 'vol_p',       label: 'Vol P' },
                { value: 'elabo_suivi', label: 'Élabo/Suivi' },
              ] as { value: BidCategory; label: string }[]).map(opt => (
                <button
                  key={opt.value}
                  onClick={() => {
                    const pre = categoryPicker.prefilledScenario;
                    if (pre) {
                      // Day-sheet flow : scénario déjà connu → skip scenarioPicker
                      const rowEl = scenarioRowsRef.current.get(pre);
                      setSearchCategory(opt.value);
                      setSearchScenario(pre);
                      setSearchDate(categoryPicker.prefilledDate ?? null);
                      setSearchPanelTop(rowEl?.getBoundingClientRect().bottom);
                      setCategoryPicker(null);
                      setSearchOpen(true);
                    } else {
                      setScenarioPicker({ rect: categoryPicker.rect, category: opt.value });
                      setCategoryPicker(null);
                    }
                  }}
                  className="px-4 h-12 text-sm font-bold rounded-xl bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-zinc-700 dark:hover:bg-zinc-300 active:scale-95 transition-all whitespace-nowrap"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </>
        );
      })()}

      {/* Picker scénario — étape 2 (après choix de la catégorie) */}
      {scenarioPicker && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setScenarioPicker(null)} />
          <div
            className="fixed z-50 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-2xl shadow-2xl p-3 flex flex-col gap-2"
            style={{
              bottom: window.innerHeight - scenarioPicker.rect.top + 8,
              right: Math.max(8, window.innerWidth - scenarioPicker.rect.right),
            }}
          >
            <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide">
              {scenarioPicker.category === 'dda_vol' ? 'DDA'
                : scenarioPicker.category === 'vol_p' ? 'Vol P'
                : 'Élabo/Suivi'} → Ligne
            </span>
            <div className="flex gap-2">
              {(localScenarios.map(s => s.name) as ScenarioName[]).map(name => (
                <button
                  key={name}
                  onClick={() => {
                    const rowEl = scenarioRowsRef.current.get(name);
                    const rowBottom = rowEl?.getBoundingClientRect().bottom;
                    setSearchCategory(scenarioPicker.category);
                    setSearchScenario(name);
                    setSearchPanelTop(rowBottom);
                    setScenarioPicker(null);
                    setSearchOpen(true);
                  }}
                  className="w-12 h-12 text-xl font-bold rounded-xl bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-zinc-700 dark:hover:bg-zinc-300 active:scale-95 transition-all"
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Note sheet (add/edit) */}
      {noteSheet && (
        <>
          <div className="fixed inset-0 z-30 bg-black/20" onClick={() => setNoteSheet(null)} />
          <div className="fixed left-0 right-0 bottom-0 z-40 bg-white dark:bg-zinc-950 rounded-t-2xl shadow-2xl"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
            <div className="p-4 space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <span className="text-xs font-medium text-amber-500 uppercase tracking-wide">📝 Note</span>
                  <h2 className="font-semibold capitalize">
                    {noteSheet.mode === 'edit'
                      ? new Date(noteSheet.note.start_date + 'T00:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
                      : new Date(noteSheet.date + 'T00:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}
                  </h2>
                </div>
                <div className="flex items-center gap-2">
                  {noteSheet.mode === 'edit' && (
                    <button
                      onClick={() => {
                        const id = noteSheet.note.id;
                        setLocalNotes(prev => prev.filter(n => n.id !== id));
                        setPendingCount(c => c + 1);
                        void enqueueDeleteNote(id);
                        setNoteSheet(null);
                      }}
                      className="px-3 py-1.5 rounded-lg border border-red-200 text-red-500 text-sm hover:bg-red-50"
                    >
                      Supprimer
                    </button>
                  )}
                  <button onClick={() => setNoteSheet(null)} className="text-zinc-400 hover:text-zinc-600 text-2xl leading-none">×</button>
                </div>
              </div>

              <textarea
                value={noteText || (noteSheet.mode === 'edit' ? noteSheet.note.text : '')}
                onChange={e => setNoteText(e.target.value)}
                placeholder="Texte de la note (ex : RDV médecin 9h, Anniversaire Sophie…)"
                rows={3}
                autoFocus
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
              />

              <div className="flex items-center gap-3">
                <label className="text-xs text-zinc-500">Jusqu&apos;au</label>
                <input
                  type="date"
                  value={noteEnd || (noteSheet.mode === 'edit' ? noteSheet.note.end_date : noteSheet.date)}
                  min={noteSheet.mode === 'edit' ? noteSheet.note.start_date : noteSheet.date}
                  onChange={e => setNoteEnd(e.target.value)}
                  className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setNoteSheet(null)}
                  className="px-4 py-2 rounded-lg text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                >
                  Annuler
                </button>
                <button
                  onClick={() => {
                    const text = (noteText || (noteSheet.mode === 'edit' ? noteSheet.note.text : '')).trim();
                    if (!text) { setNoteSheet(null); return; }
                    const start = noteSheet.mode === 'edit' ? noteSheet.note.start_date : noteSheet.date;
                    const end   = (noteEnd || (noteSheet.mode === 'edit' ? noteSheet.note.end_date : noteSheet.date));
                    const safeEnd = end >= start ? end : start;
                    if (noteSheet.mode === 'edit') {
                      const id = noteSheet.note.id;
                      const patch = { start_date: start, end_date: safeEnd, text };
                      setLocalNotes(prev => prev.map(n => n.id === id ? { ...n, ...patch } : n));
                      setPendingCount(c => c + 1);
                      void enqueueUpdateNote(id, patch);
                    } else {
                      const id = crypto.randomUUID();
                      const note: UserNote = { id, start_date: start, end_date: safeEnd, text, color: null };
                      setLocalNotes(prev => [...prev, note].sort((a, b) => a.start_date.localeCompare(b.start_date)));
                      setPendingCount(c => c + 1);
                      void enqueueAddNote(note);
                    }
                    setNoteSheet(null);
                    setNoteText('');
                    setNoteEnd('');
                  }}
                  className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold"
                >
                  {noteSheet.mode === 'edit' ? 'Enregistrer' : 'Ajouter'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Search panel */}
      {searchOpen && (
        <SearchPanel
          month={currentMonth}
          scenarios={localScenarios}
          preselectedScenario={searchScenario ?? undefined}
          preselectedCategory={searchCategory ?? undefined}
          preselectedDate={searchDate ?? undefined}
          panelTop={searchPanelTop}
          onClose={() => {
            setSearchOpen(false);
            setSearchScenario(null);
            setSearchCategory(null);
            setSearchDate(null);
            setSearchPanelTop(undefined);
          }}
          onItemAdded={(item, draftId) => {
            applyAdd(item, draftId);
            setPendingCount(c => c + 1);
          }}
          onItemsRemoved={(ids) => {
            for (const id of ids) applyDelete(id);
            setPendingCount(c => c + ids.length);
          }}
        />
      )}

      {/* Import dialog */}
      {scrapeOpen && (
        <ScrapeDialog
          currentMonth={currentMonth}
          onClose={() => setScrapeOpen(false)}
          onDone={() => { setScrapeOpen(false); router.refresh(); }}
        />
      )}

      {/* Popover violation DDA — affiché au clic sur un bandeau rouge.
          Position centrée horizontalement sous le bandeau. */}
      {violationPopover && (() => {
        const CAT_SHORT: Record<DdaCategory, string> = {
          DDA_REPOS:   'DDA REPOS',
          DDA_VOL:     'DDA VOL',
          VOL_P:       'VOL P',
          CONGES:      'CONGES',
          ELABO_SUIVI: 'Élabo/Suivi',
        };
        const W = 240;
        const vw = window.innerWidth;
        const rawLeft = violationPopover.left - W / 2;
        const left = Math.max(8, Math.min(rawLeft, vw - W - 8));
        return (
          <>
            <div className="fixed inset-0 z-[45]" onClick={() => setViolationPopover(null)} />
            <div
              role="dialog"
              className={`fixed z-[50] bg-white dark:bg-zinc-900 border rounded-xl shadow-2xl p-3 space-y-2 ${
                violationPopover.afOnly
                  ? 'border-emerald-300 dark:border-emerald-800/60'
                  : 'border-red-300 dark:border-red-800/60'
              }`}
              style={{ left, top: violationPopover.top, width: W }}
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-start gap-2">
                <span className={`text-base leading-none flex-shrink-0 ${
                  violationPopover.afOnly
                    ? 'text-emerald-500 dark:text-emerald-400'
                    : 'text-red-500 dark:text-red-400'
                }`}>⚑</span>
                <div className="flex-1 min-w-0">
                  <div className={`text-[10px] font-bold uppercase tracking-wide ${
                    violationPopover.afOnly
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-red-600 dark:text-red-400'
                  }`}>
                    {violationPopover.afOnly ? 'Faux positif AF' : 'Violation DDA'}
                  </div>
                  <div className="text-xs font-semibold text-zinc-800 dark:text-zinc-100 mt-0.5">
                    {CAT_SHORT[violationPopover.catA]} → {CAT_SHORT[violationPopover.catB]}
                    {violationPopover.rpc != null && (
                      <span className="text-zinc-400 font-normal ml-1">· RPC {violationPopover.rpc}j</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setViolationPopover(null)}
                  className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-lg leading-none flex-shrink-0"
                >×</button>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <span className="text-[10px] text-zinc-500 dark:text-zinc-400">Gap mesuré</span>
                <span className={`px-1.5 py-0.5 rounded font-mono font-semibold text-xs ${
                  violationPopover.afOnly
                    ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300'
                    : 'bg-red-100 dark:bg-red-950/50 text-red-600 dark:text-red-400'
                }`}>
                  {violationPopover.gap}j
                </span>
              </div>
              {violationPopover.afOnly ? (
                <>
                  <div className="text-[10px] font-semibold text-red-600 dark:text-red-400 uppercase pt-1">AF voit</div>
                  <p className="text-[11px] text-red-700 dark:text-red-300 leading-snug">
                    {violationPopover.rule}
                  </p>
                  <div className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 uppercase pt-1">Réalité</div>
                  <p className="text-[11px] text-emerald-700 dark:text-emerald-300 leading-snug">
                    {violationPopover.realRule}
                  </p>
                </>
              ) : (
                <p className="text-[11px] text-zinc-600 dark:text-zinc-300 leading-snug">
                  {violationPopover.rule}
                </p>
              )}
              {violationPopover.canReport && (
                <button
                  onClick={() => {
                    handleAcceptRpcReport(violationPopover.itemAId);
                    setViolationPopover(null);
                  }}
                  className="w-full px-2 py-1.5 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 text-xs font-semibold hover:bg-amber-100 dark:hover:bg-amber-900/40"
                >
                  ↩ Reporter RPC à la fin des CONGES
                </button>
              )}
            </div>
          </>
        );
      })()}

      {/* Panneau détail paie (fixed, à droite du label) */}
      {detailPanel && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setDetailPanel(null)} />
          <div
            className="fixed z-50 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-2xl p-3 w-64 overflow-y-auto max-h-[calc(100vh-16px)]"
            style={{
              left: detailPanel.rect.left + LABEL_W + 6,
              ...(detailPanel.rect.top > detailPanel.viewportH / 2
                ? { bottom: detailPanel.viewportH - detailPanel.rect.top + 4 }
                : { top: Math.max(8, detailPanel.rect.top + 4) }),
            }}
          >
            <div className="text-[9px] font-bold text-zinc-400 uppercase tracking-wide mb-2">
              Détail — Scénario {detailPanel.name} <span className="text-zinc-400 normal-case font-normal">(PVEI = {detailPanel.pveiEff.toFixed(2)})</span>
            </div>

            {/* FIXE / PV / HS */}
            <div className="space-y-1.5 mb-2 font-mono text-[9px]">
              <div className="flex items-baseline justify-between">
                <span className="text-zinc-500">FIXE</span>
                <span className="text-zinc-700 dark:text-zinc-200 font-semibold">{Math.round(detailPanel.fixeForFin)}</span>
              </div>

              <div>
                <div className="flex items-baseline justify-between">
                  <span className="text-blue-500">PV = HCr + PVnuit</span>
                  <span className="text-blue-600 dark:text-blue-400 font-semibold">{Math.round(detailPanel.pvEur)}</span>
                </div>
                {(detailPanel.flightBreakdown.length > 0 || detailPanel.solDays > 0 || detailPanel.simDays > 0) ? (
                  <div className="text-[8px] text-zinc-400 pl-2 space-y-px">
                    {detailPanel.flightBreakdown.map((f, i) => (
                      <div key={i} className="flex justify-between gap-2">
                        <span className="truncate">{f.destination}</span>
                        <span className="font-mono">
                          {Math.round(f.hcrEur)} + {Math.round(f.pvNuitEur)} = {Math.round(f.hcrEur + f.pvNuitEur)}
                        </span>
                      </div>
                    ))}
                    {detailPanel.solDays > 0 && (
                      <div className="flex justify-between gap-2">
                        <span className="truncate">Sol ({detailPanel.solDays}j × 4 HCr)</span>
                        <span className="font-mono">{Math.round(detailPanel.solHcrEur)}</span>
                      </div>
                    )}
                    {detailPanel.simDays > 0 && (
                      <div className="flex justify-between gap-2">
                        <span className="truncate">Sim ({detailPanel.simDays}j × 5 HCr)</span>
                        <span className="font-mono">{Math.round(detailPanel.simHcrEur)}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-[8px] text-zinc-400 pl-2">
                    {Math.round(detailPanel.pvHcrEur)} + {Math.round(detailPanel.pvNuitEur)}
                  </div>
                )}
              </div>

              <div>
                <div className="flex items-baseline justify-between">
                  <span className="text-green-500">
                    HS = HS.FIXE + HS.VOL
                    {detailPanel.hsH > 0
                      ? <span className="text-zinc-400"> ({detailPanel.hsH.toFixed(1)}h)</span>
                      : <span className="text-zinc-400"> (−{Math.max(0, detailPanel.seuil75 - detailPanel.totalHc).toFixed(1)}h)</span>}
                  </span>
                  <span className="text-green-600 dark:text-green-400 font-semibold">{Math.round(detailPanel.hsEur)}</span>
                </div>
                {detailPanel.hsH > 0 && (
                  <div className="text-[8px] text-zinc-400 pl-2">
                    {Math.round(detailPanel.hsH * detailPanel.hsFixeRate)} + {Math.round(detailPanel.hsH * detailPanel.hsVolRate)}
                  </div>
                )}
              </div>
            </div>

            <div className="border-t border-zinc-200 dark:border-zinc-700 my-1.5" />

            {/* PV+HS / MGA / DIFF */}
            <div className="space-y-1 mb-2 font-mono text-[9px]">
              <div className="flex items-baseline justify-between">
                <span className="text-zinc-700 dark:text-zinc-200">PV + HS</span>
                <span className="text-zinc-900 dark:text-zinc-100 font-bold">{Math.round(detailPanel.pvEur + detailPanel.hsEur)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-1">
                <span className="text-zinc-500">
                  MGA <span className="text-[8px] text-zinc-400 dark:text-zinc-500">(85 × {detailPanel.pveiEff.toFixed(2)} × {detailPanel.kspEff}) × ({detailPanel.nb30eEff}/30)</span>
                </span>
                <span className="text-zinc-600 dark:text-zinc-300">{Math.round(detailPanel.mga)}</span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className={detailPanel.diff < 0 ? 'text-red-500' : 'text-emerald-500'}>
                  DIFF = (PV + HS) − MGA
                </span>
                <span className={`font-semibold ${detailPanel.diff < 0 ? 'text-red-500' : 'text-emerald-500'}`}>
                  {Math.round(detailPanel.diff)}
                </span>
              </div>
            </div>

            <div className="border-t border-zinc-200 dark:border-zinc-700 my-1.5" />

            {/* PRIMES */}
            <div className="space-y-0.5 mb-2 font-mono text-[9px]">
              <div className="flex items-baseline justify-between">
                <span className="text-amber-600 dark:text-amber-400 font-semibold">PRIMES</span>
                <span className="text-amber-600 dark:text-amber-400 font-bold">{Math.round(detailPanel.primesTotal)}</span>
              </div>
              <div className="text-[8px] text-zinc-400 pl-2 space-y-px">
                <div className="flex justify-between"><span>Incitation</span><span>{Math.round(detailPanel.incitation)}</span></div>
                <div className="flex justify-between"><span>A330</span><span>{Math.round(detailPanel.a330)}</span></div>
                <div className="flex justify-between"><span>Mai/Noël</span><span>{Math.round(detailPanel.primeMai + detailPanel.primeNoel)}</span></div>
                <div className="flex justify-between">
                  <span>Bi-tronçon{detailPanel.totalPrime > 0 ? ` ×${detailPanel.totalPrime}` : ''}</span>
                  <span>{Math.round(detailPanel.bitronconEur)}</span>
                </div>
                <div className="flex justify-between"><span>Instruction</span><span>{Math.round(detailPanel.instruction)}</span></div>
                {detailPanel.irgav > 0 && (
                  <div className="flex justify-between"><span>IrgAv</span><span>{Math.round(detailPanel.irgav)}</span></div>
                )}
              </div>
            </div>

            {/* CONGÉS */}
            <div className="space-y-0.5 mb-2 font-mono text-[9px]">
              <div className="flex items-baseline justify-between">
                <span className="text-pink-500 font-semibold">
                  CONGÉS{detailPanel.congeDays > 0 ? ` = ${detailPanel.congeDays} × (${Math.round(detailPanel.cngPv)} + ${Math.round(detailPanel.cngHs)})` : ''}
                </span>
                <span className="text-pink-600 dark:text-pink-400 font-bold">{Math.round(detailPanel.congeAmount)}</span>
              </div>
            </div>

            {/* IR / MF */}
            <div className="space-y-0.5 mb-2 font-mono text-[9px]">
              <div className="flex items-baseline justify-between">
                <span className="text-orange-500 font-semibold">IR / MF = IR + MF</span>
                <span className="text-orange-600 dark:text-orange-400 font-bold">{Math.round(detailPanel.irEur + detailPanel.mfEur)}</span>
              </div>
              {detailPanel.irMfPerFlight.length > 0 ? (
                <div className="text-[8px] text-zinc-400 pl-2 space-y-px">
                  {detailPanel.irMfPerFlight.map((f, i) => (
                    <div key={i} className="flex justify-between gap-2">
                      <span className="truncate">{f.destination}</span>
                      <span className="font-mono">
                        {Math.round(f.ir_eur)} + {Math.round(f.mf_eur)} = {Math.round(f.ir_eur + f.mf_eur)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (detailPanel.irEur > 0 || detailPanel.mfEur > 0) ? (
                <div className="text-[8px] text-zinc-400 pl-2">
                  {Math.round(detailPanel.irEur)} + {Math.round(detailPanel.mfEur)}
                </div>
              ) : null}
            </div>

            {/* IT — Indemnité Transport */}
            {detailPanel.itMode && (
              <div className="space-y-0.5 mb-2 font-mono text-[9px]">
                <div className="flex items-baseline justify-between">
                  <span className="text-cyan-600 dark:text-cyan-400 font-semibold">
                    IT {detailPanel.itMode === 'Navigo'
                      ? `(Navigo${detailPanel.itEur === 0 ? ' — 0 activité' : ''})`
                      : `= ${detailPanel.itNbActivites} × ${detailPanel.itPerActivite.toFixed(2)}`}
                  </span>
                  <span className="text-cyan-700 dark:text-cyan-300 font-bold">{detailPanel.itEur.toFixed(2)}</span>
                </div>
              </div>
            )}

            <div className="border-t border-zinc-200 dark:border-zinc-700 my-1.5" />

            {/* BRUT — branche selon DIFF (PV+HS vs MGA) ; FIXE + congés présents dans les 2 cas */}
            {(() => {
              const diffPos      = detailPanel.diff >= 0;
              const irMfEur      = detailPanel.irEur + detailPanel.mfEur;
              const itEur        = detailPanel.itEur;
              const itSuffix     = detailPanel.itMode ? ' + IT' : '';
              const itValSuffix  = detailPanel.itMode ? ` + ${Math.round(itEur)}` : '';
              const formulaLabel = diffPos
                ? `BRUT = FIXE + PV + HS + cg + P + IR/MF${itSuffix}`
                : `BRUT = FIXE + MGA + cg + P + IR/MF${itSuffix}`;
              const pvHs         = detailPanel.pvEur + detailPanel.hsEur;
              const breakdown    = diffPos
                ? `${Math.round(detailPanel.fixeForFin)} + ${Math.round(pvHs)} + ${Math.round(detailPanel.congeAmount)} + ${Math.round(detailPanel.primesTotal)} + ${Math.round(irMfEur)}${itValSuffix}`
                : `${Math.round(detailPanel.fixeForFin)} + ${Math.round(detailPanel.mga)} + ${Math.round(detailPanel.congeAmount)} + ${Math.round(detailPanel.primesTotal)} + ${Math.round(irMfEur)}${itValSuffix}`;
              return (
                <div className="font-mono text-[9px]">
                  <div className="flex items-baseline justify-between">
                    <span className="text-emerald-600 dark:text-emerald-400 font-bold">{formulaLabel}</span>
                  </div>
                  <div className="flex items-baseline justify-between mt-0.5">
                    <span className="text-[8px] text-zinc-400 pl-2">{breakdown}</span>
                    <span className="text-emerald-700 dark:text-emerald-300 font-bold text-[10px]">{Math.round(detailPanel.brut)}</span>
                  </div>
                </div>
              );
            })()}
          </div>
        </>
      )}

      {/* DragOverlay */}
      <DragOverlay dropAnimation={null}>
        {dragging ? (
          <BarPreview
            item={dragging}
            span={dayNum(dragging.end_date) - dayNum(dragging.start_date) + 1}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
