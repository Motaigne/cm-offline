'use client';

import { useState, useEffect, useTransition, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  DndContext, DragOverlay, MouseSensor, TouchSensor,
  useSensor, useSensors, useDraggable,
  type DragStartEvent, type DragEndEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import {
  addPlanningItem, deletePlanningItem, updatePlanningItem, getScenariosWithItems,
  resetPlanningScenarios,
} from '@/app/actions/planning';
import { ACTIVITY_META, type ActivityKind } from '@/lib/activity-meta';
import type { Scenario, CalendarItem } from '@/app/page';
import type { ScenarioName } from '@/app/actions/planning';
import type { Database } from '@/types/supabase';
import { SearchPanel } from './search-panel';
import { ScrapeDialog } from './scrape-dialog';
import { rotationValue, monthlyFinancialsP, PRIME_BITRONCON, PVEI, KSP, FIXE_MENSUEL, NB_30E, REGIME_NB30E } from '@/lib/finance';
import { computeArticle81 } from '@/lib/article81';
import type { Article81Data } from '@/lib/article81';
import { createClient } from '@/lib/supabase/client';
import { useOnlineStatus } from '@/hooks/use-online';
import { db, hydrateDB, loadFromDB, hasPendingOps, loadScenariosForMonth, cacheRotations } from '@/lib/local-db';
import { enqueueAdd, enqueueDelete, enqueueUpdate, syncNow, pendingOpsCount } from '@/lib/sync-service';
import { getRotationsForMonth } from '@/app/actions/search';
import { getCurrentUserIsAdmin } from '@/app/actions/auth';
import { NavBar } from '@/app/components/nav';

type RegimeEnum = Database['public']['Enums']['regime_enum'];

// ─── layout constants ────────────────────────────────────────────────────────

const LABEL_W = 96;
const DAY_H   = 44;
const ROW_H   = 180;
const BAR_H   = 52;
const BAR_TOP = (ROW_H - BAR_H) / 2;

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
  if (item.end_date.slice(0,7) < prefix || item.start_date.slice(0,7) > prefix) return null;
  const dim = daysInMonth(y, mo);
  const start = item.start_date.slice(0,7) < prefix ? 1 : dayNum(item.start_date);
  const end   = item.end_date.slice(0,7)   > prefix ? dim : dayNum(item.end_date);
  return { start, end };
}

// ─── prorata mois (rotations à cheval) ───────────────────────────────────────

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
) {
  let onDays = 0, congeDays = 0;
  const flights = items.filter(i => i.kind === 'flight').length;
  let totalHcr = 0, totalPrime = 0, totalTsvNuit = 0, totalA81 = 0;
  for (const item of items) {
    const clip = clipItem(item, year, mo);
    if (clip) {
      if (item.kind === 'flight') onDays   += clip.end - clip.start + 1;
      if (item.kind === 'conge')  congeDays += clip.end - clip.start + 1;
    }
    if (item.kind !== 'flight') continue;
    const m = item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta)
      ? item.meta as Record<string, unknown> : null;
    if (!m) continue;
    const departAt  = typeof m.depart_at  === 'string' ? m.depart_at  as string : null;
    const arriveeAt = typeof m.arrivee_at === 'string' ? m.arrivee_at as string : null;
    let hcr     = typeof m.hcr_crew === 'number' ? m.hcr_crew  as number : 0;
    let tsvNuit = typeof m.tsv_nuit === 'number' ? m.tsv_nuit  as number : 0;
    if (departAt && arriveeAt) {
      hcr     = prorateForMonth(hcr,     departAt, arriveeAt, year, mo);
      tsvNuit = prorateForMonth(tsvNuit, departAt, arriveeAt, year, mo);
    }
    totalHcr     += hcr;
    totalPrime   += typeof m.prime === 'number' ? (m.prime as number) : 0;
    totalTsvNuit += tsvNuit;

    // Article 81 : prorata mois pour les vols à cheval
    const tempsSej = typeof m.temps_sej === 'number' ? m.temps_sej as number : null;
    const zone     = typeof m.zone      === 'string' ? m.zone      as string : null;
    if (tempsSej != null && zone) {
      const a81 = computeArticle81({ tSej: tempsSej, zone, valeurJour, data: article81Data });
      const montant = (departAt && arriveeAt)
        ? prorateForMonth(a81.montantPrimeSej, departAt, arriveeAt, year, mo)
        : a81.montantPrimeSej;
      totalA81 += montant;
    }
  }
  // HS seuil proratisé : 75 × (nb30e_regime - congeDays) / 30
  const nb30eRegime = REGIME_NB30E[regime] ?? NB_30E;
  const nb30eEff    = Math.max(0, nb30eRegime - congeDays);
  const finBase = monthlyFinancialsP(totalHcr, totalPrime, totalTsvNuit, { pvei: PVEI, ksp: KSP, fixe: FIXE_MENSUEL, nb30e: nb30eEff });
  // PRIME = bi-tronçon (sommée par vol via finBase.primes) + primes mensuelles
  // fixes (incit + A330 + instruction + Mai + Noël). monthlyFixedPrimes est calculé
  // en amont avec proration régime + boost 100% en juillet/août pour TAF*_10_12.
  const primesTotal = finBase.primes + monthlyFixedPrimes;
  const fin = {
    ...finBase,
    primes: primesTotal,
    total:  finBase.total - finBase.primes + primesTotal,
  };
  const congeAmount = congeDays * (cngPv + cngHs);
  const brut = fin.total + congeAmount;
  return { flights, onDays, congeDays, totalHcr, totalPrime, totalTsvNuit, fin, congeAmount, brut, totalA81 };
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
}: {
  item: CalendarItem;
  clip: { start: number; end: number };
  dim: number;
  year: number;
  mo: number;
  onEdit: (item: CalendarItem) => void;
  isDragSource: boolean;
}) {
  const readOnly = !!item._isSpillover;
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
  const restAfterH   = typeof metaObj?.rest_after_h  === 'number' ? metaObj.rest_after_h  as number : 0;
  const departAt     = typeof metaObj?.depart_at     === 'string' ? metaObj.depart_at     as string : null;
  const arriveeAt    = typeof metaObj?.arrivee_at    === 'string' ? metaObj.arrivee_at    as string : null;
  const tsvNuit      = typeof metaObj?.tsv_nuit === 'number' ? metaObj.tsv_nuit as number : 0;

  const hcrDisplay = hcrCrew !== null && departAt && arriveeAt
    ? prorateForMonth(hcrCrew, departAt, arriveeAt, year, mo)
    : hcrCrew;
  const tsvDisplay = departAt && arriveeAt
    ? prorateForMonth(tsvNuit, departAt, arriveeAt, year, mo)
    : tsvNuit;
  const isProrated = hcrDisplay !== null && hcrCrew !== null && hcrDisplay < hcrCrew - 0.01;
  const euroVal    = item.kind === 'flight' && hcrDisplay !== null
    ? rotationValue(hcrDisplay, prime, tsvDisplay) : null;

  // Sub-day precision for flights with timestamps, integer days for others
  let leftPct: number, wPct: number;
  let restBeforeBar: { left: number; width: number } | null = null;
  let restAfterBar:  { left: number; width: number } | null = null;

  if (item.kind === 'flight' && departAt && arriveeAt) {
    const startFrac = dayFrac(departAt,  year, mo, dim);
    const endFrac   = dayFrac(arriveeAt, year, mo, dim);
    leftPct = Math.max(0, (startFrac - 1) / dim * 100);
    wPct    = Math.max(0.3, (Math.min(endFrac, dim + 1) - Math.max(startFrac, 1)) / dim * 100);

    if (restBeforeH > 0) {
      const rFrac = dayFrac(
        new Date(new Date(departAt).getTime() - restBeforeH * 3_600_000).toISOString(),
        year, mo, dim,
      );
      const rLeft = Math.max(0, (rFrac - 1) / dim * 100);
      const rW    = leftPct - rLeft;
      if (rW > 0.05) restBeforeBar = { left: rLeft, width: rW };
    }
    if (restAfterH > 0) {
      const rFrac = dayFrac(
        new Date(new Date(arriveeAt).getTime() + restAfterH * 3_600_000).toISOString(),
        year, mo, dim,
      );
      const rLeft = leftPct + wPct;
      const rW    = Math.max(0, (Math.min(rFrac, dim + 1) - 1) / dim * 100 - rLeft);
      if (rW > 0.05) restAfterBar = { left: rLeft, width: rW };
    }
  } else {
    const span = clip.end - clip.start + 1;
    leftPct = ((clip.start - 1) / dim) * 100;
    wPct    = (span / dim) * 100;
  }

  const restTop = BAR_TOP + (BAR_H - REST_H) / 2;

  return (
    <>
      {/* Pre-repos bar */}
      {restBeforeBar && (
        <div
          className="absolute pointer-events-none rounded-l-sm z-[9]"
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

      {/* Post-repos bar */}
      {restAfterBar && (
        <div
          className="absolute pointer-events-none rounded-r-sm z-[9]"
          style={{
            left: `${restAfterBar.left}%`,
            width: `${restAfterBar.width}%`,
            top: restTop,
            height: REST_H,
            backgroundColor: '#93C5FD',
            opacity: isDragSource ? 0.2 : 0.65,
          }}
        />
      )}

      {/* Main bar */}
      <div
        ref={setNodeRef}
        style={{
          position: 'absolute',
          left: `${leftPct}%`,
          width: `${wPct}%`,
          top: BAR_TOP,
          height: BAR_H,
          backgroundColor: actMeta.color,
          color: actMeta.textColor,
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
  article81Data = null, valeurJour = 600,
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
  /** Matrice Article 81 (taux de séjour par zone × durée). */
  article81Data?: Article81Data | null;
  /** Valeur jour (€) pour Article 81 — depuis profil. */
  valeurJour?: number;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const rowRef = useRef<HTMLDivElement>(null);
  const isOnline = useOnlineStatus();

  // navigation mois côté client (évite router.push → serveur → page blanche hors ligne)
  const [currentMonth, setCurrentMonth] = useState(month);
  const [monthLoading, setMonthLoading] = useState(false);
  const [noCache, setNoCache]           = useState(false);

  // local state (offline-capable copy of scenarios)
  const [localScenarios, setLocalScenarios] = useState<Scenario[]>(scenarios);
  const [pendingCount, setPendingCount]     = useState(0);
  const [isSyncing, setIsSyncing]           = useState(false);

  // sheet
  const [sheet, setSheet]         = useState<SheetState | null>(null);
  const [addKind, setAddKind]     = useState<ActivityKind>('off');
  const [addEnd, setAddEnd]       = useState('');
  const [nbJours, setNbJours]     = useState('');
  const [overlapErr, setOverlapErr] = useState(false);

  // dnd
  const [dragging, setDragging]   = useState<CalendarItem | null>(null);

  // search / import
  const [searchOpen, setSearchOpen] = useState(false);
  const [scrapeOpen, setScrapeOpen] = useState(false);
  const [isAdmin,    setIsAdmin]    = useState(false);

  // Compteur prime d'incitation (0-5), persistance localStorage par mois.
  const [incitCount, setIncitCount] = useState(0);

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
    void getCurrentUserIsAdmin().then(setIsAdmin).catch(() => setIsAdmin(false));
  }, []);

  // Charge le compteur incitation pour le mois courant
  useEffect(() => {
    const stored = localStorage.getItem(`cm-incit-${month}`);
    setIncitCount(stored ? Math.max(0, Math.min(5, parseInt(stored) || 0)) : 0);
  }, [month]);

  function changeIncit(n: number) {
    setIncitCount(n);
    localStorage.setItem(`cm-incit-${month}`, String(n));
  }

  async function handleReset() {
    if (!resetTarget) return;
    setResetting(true);
    const targets: ('A' | 'B' | 'C')[] = resetTarget === 'tout' ? ['A', 'B', 'C'] : [resetTarget];
    // Optimistic UI : vide les scénarios concernés localement avant l'await DB.
    // (router.refresh ne re-render pas toujours visiblement sur iPad PWA, cf bug
    // search-panel — l'user croit que reset a échoué et retry.)
    setLocalScenarios(prev => prev.map(s =>
      targets.includes(s.name) ? { ...s, items: s.items.filter(i => i._isSpillover) } : s,
    ));
    try {
      await resetPlanningScenarios(currentMonth, targets);
      router.refresh();
      setResetTarget(null);
    } finally {
      setResetting(false);
    }
  }

  // user menu
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  // propagation feedback
  const [propagateMsg, setPropagateMsg] = useState<string | null>(null);

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
        const local = await loadFromDB(scenarios);
        setLocalScenarios(local);
        setPendingCount(await pendingOpsCount());
      } else {
        await hydrateDB(scenarios, month);
        setLocalScenarios(scenarios);
      }
    }
    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  // ── Sync automatique quand on repasse online ─────────────────────────────────
  useEffect(() => {
    if (!isOnline) return;
    async function doSync() {
      const count = await pendingOpsCount();
      if (count === 0) return;
      setIsSyncing(true);
      try {
        await syncNow();
        // Re-fetch les scénarios du mois affiché (pas via router.refresh qui se
        // base sur la prop `month` SSR — peut différer de currentMonth si l'user
        // a navigué localement hors ligne).
        const fresh = await getScenariosWithItems(currentMonth);
        setLocalScenarios(fresh);
        await hydrateDB(fresh, currentMonth);
        setPendingCount(0);
      } catch { /* ignore — le fallback IndexedDB suit */ }
      finally {
        // setIsSyncing(false) APRÈS setLocalScenarios pour empêcher l'effet
        // maybeRefresh ci-dessous de tirer pendant la fenêtre où la prop
        // `scenarios` SSR est mise à jour par les revalidatePath en cascade
        // (sinon il écrase localScenarios avec une RSC payload intermédiaire).
        setIsSyncing(false);
      }
    }
    doSync();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  // ── Mise à jour depuis le serveur après refresh ──────────────────────────────
  useEffect(() => {
    // Ignore si l'user a navigué vers un autre mois localement : les `scenarios`
    // (prop SSR) correspondent au mois `month`, pas à `currentMonth`.
    if (currentMonth !== month) return;
    // Ignore pendant un sync en cours : doSync va setLocalScenarios avec les
    // données fresh, et la prop `scenarios` SSR peut arriver intermédiaire
    // (entre 2 revalidatePath). On laisse doSync être autoritatif.
    if (isSyncing) return;
    async function maybeRefresh() {
      const count = await pendingOpsCount();
      if (count === 0) {
        setLocalScenarios(scenarios);
        await hydrateDB(scenarios, month);
      }
    }
    maybeRefresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarios, isSyncing]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor,  { activationConstraint: { delay: 200, tolerance: 5 } }),
  );

  const [year, mo] = currentMonth.split('-').map(Number);
  const dim   = daysInMonth(year, mo);
  const [today, setToday] = useState('');
  useEffect(() => { setToday(localStr(new Date())); }, []);
  const tafDur = getTafDuration(userRegime);
  const tafOk  = isTafAvailable(userRegime, month);
  const days   = Array.from({ length: dim }, (_, i) => i + 1);

  // ── Navigation mois (client-side, pas de router.push) ───────────────────────

  async function preCacheMonthBg(m: string) {
    if (preCacheInFlightRef.current.has(m)) return;
    preCacheInFlightRef.current.add(m);
    try {
      const [scs, rots] = await Promise.all([getScenariosWithItems(m), getRotationsForMonth(m)]);
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

    // 1. Cache-first : affichage immédiat depuis IndexedDB si dispo
    const cached = await loadScenariosForMonth(newMonth);
    if (myToken !== navTokenRef.current) return;
    if (cached) {
      setLocalScenarios(cached);
      setMonthLoading(false);
    } else {
      setMonthLoading(true);
    }

    // 2. Refresh réseau (background si on avait du cache, bloquant sinon)
    if (!navigator.onLine) {
      if (!cached) { setNoCache(true); setLocalScenarios([]); }
      setMonthLoading(false);
      return;
    }

    try {
      const scs = await getScenariosWithItems(newMonth);
      if (myToken !== navTokenRef.current) return;
      setLocalScenarios(scs);
      await hydrateDB(scs, newMonth);
      setMonthLoading(false);
      // Pré-cache silencieux des mois adjacents
      void preCacheMonthBg(shiftMonth(newMonth, 1));
      void preCacheMonthBg(shiftMonth(newMonth, -1));
    } catch {
      if (myToken !== navTokenRef.current) return;
      if (!cached) { setNoCache(true); setLocalScenarios([]); }
      setMonthLoading(false);
    }
  }

  // ── sheet helpers ───────────────────────────────────────────────────────────

  function openAdd(scenarioId: string, scenarioName: ScenarioName, date: string) {
    setOverlapErr(false);
    setAddKind('off');
    setNbJours('');
    setAddEnd(date);
    setSheet({ mode: 'add', scenarioId, scenarioName, date });
  }

  function openEdit(item: CalendarItem, scenario: Scenario) {
    setOverlapErr(false);
    setAddKind(item.kind);
    const dur = dayNum(item.end_date) - dayNum(item.start_date) + 1;
    setNbJours(String(dur));
    setAddEnd(item.end_date);
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
    } else if (k === 'conge') {
      const days = nbJours ? parseInt(nbJours) : 1;
      setAddEnd(addDays(sheet.date, days - 1));
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
  const computedEnd = addKind === 'taf'   ? addDays(sheet?.date ?? today, tafDur - 1)
                    : addKind === 'conge' ? addEnd
                    : addEnd;

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

    startTransition(async () => {
      if (sheet.mode === 'edit' && sheet.item) {
        applyUpdate(sheet.item.id, start, end);
        if (isOnline) {
          await updatePlanningItem(sheet.item.id, start, end);
        } else {
          await enqueueUpdate(sheet.item.id, start, end);
          setPendingCount(c => c + 1);
        }
      } else {
        const id = crypto.randomUUID();
        const newItem: CalendarItem = { id, kind: addKind, start_date: start, end_date: end, bid_category: null, meta: null };
        applyAdd(newItem, sheet.scenarioId);
        if (isOnline) {
          await addPlanningItem({ id, draft_id: sheet.scenarioId, kind: addKind, start_date: start, end_date: end });
        } else {
          await enqueueAdd(newItem, sheet.scenarioId);
          setPendingCount(c => c + 1);
        }
      }
      setSheet(null);
    });
  }

  function handleDelete() {
    if (!sheet?.item) return;
    startTransition(async () => {
      applyDelete(sheet.item!.id);
      if (isOnline) {
        await deletePlanningItem(sheet.item!.id);
      } else {
        await enqueueDelete(sheet.item!.id);
        setPendingCount(c => c + 1);
      }
      setSheet(null);
    });
  }

  // ── propagation A → B / A → C ───────────────────────────────────────────────
  // Écrase tout le contenu de la ligne cible et le remplace par celui de A.

  function propagateFlights(target: 'B' | 'C') {
    const sourceA = localScenarios.find(s => s.name === 'A');
    const targetScenario = localScenarios.find(s => s.name === target);
    if (!sourceA || !targetScenario) return;

    // Spillovers (vols à cheval venus du mois précédent) ne sont pas propre à A → on les ignore
    const sourceItems = sourceA.items.filter(it => !it._isSpillover);
    const targetExisting = targetScenario.items.filter(it => !it._isSpillover);

    if (sourceItems.length === 0 && targetExisting.length === 0) {
      setPropagateMsg(`A est vide — rien à propager`);
      setTimeout(() => setPropagateMsg(null), 3000);
      return;
    }

    const confirmMsg = targetExisting.length > 0
      ? `Écraser la ligne ${target} (${targetExisting.length} activité${targetExisting.length > 1 ? 's' : ''}) et la remplacer par le contenu de A (${sourceItems.length}) ?`
      : `Copier le contenu de A (${sourceItems.length} activité${sourceItems.length > 1 ? 's' : ''}) vers la ligne ${target} ?`;

    if (!window.confirm(confirmMsg)) return;

    const newItems: CalendarItem[] = sourceItems.map(it => ({
      id: crypto.randomUUID(),
      kind: it.kind,
      start_date: it.start_date,
      end_date: it.end_date,
      bid_category: it.bid_category,
      meta: it.meta,
    }));

    // Optimistic local update : on remplace les items propres, on conserve les spillovers
    const targetSpillovers = targetScenario.items.filter(it => it._isSpillover);
    setLocalScenarios(prev => prev.map(s =>
      s.name === target ? { ...s, items: [...newItems, ...targetSpillovers] } : s,
    ));

    startTransition(async () => {
      // 1. Supprime l'existant
      for (const it of targetExisting) {
        if (isOnline) {
          await deletePlanningItem(it.id);
        } else {
          await enqueueDelete(it.id);
          setPendingCount(c => c + 1);
        }
      }
      // 2. Insère les copies
      for (const it of newItems) {
        if (isOnline) {
          await addPlanningItem({
            id: it.id, draft_id: targetScenario.id, kind: it.kind,
            start_date: it.start_date, end_date: it.end_date,
            bid_category: it.bid_category, meta: it.meta,
          });
        } else {
          await enqueueAdd(it, targetScenario.id);
          setPendingCount(c => c + 1);
        }
      }
    });

    setPropagateMsg(`A → ${target} : ${newItems.length} activité${newItems.length > 1 ? 's' : ''} copiée${newItems.length > 1 ? 's' : ''}`);
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
    startTransition(async () => {
      if (isOnline) {
        await updatePlanningItem(item.id, newStartStr, newEndStr);
      } else {
        await enqueueUpdate(item.id, newStartStr, newEndStr);
        setPendingCount(c => c + 1);
      }
    });
  }

  // ── sorted kinds (exclude flight from manual add) ─────────────────────────

  const addableKinds = (Object.keys(ACTIVITY_META) as ActivityKind[])
    .filter(k => k !== 'flight')
    .sort((a, b) => ACTIVITY_META[a].order - ACTIVITY_META[b].order);

  // ── render ──────────────────────────────────────────────────────────────────

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex flex-col h-screen bg-white dark:bg-zinc-950 overflow-hidden select-none">

        <NavBar />

        {/* Portrait warning */}
        <div className="portrait:flex landscape:hidden fixed inset-0 z-50 bg-zinc-950 text-white flex-col items-center justify-center gap-3 text-sm font-medium">
          Veuillez tourner votre iPad en mode paysage
        </div>

        {/* Header */}
        <header className="flex items-center justify-between px-4 h-14 border-b border-zinc-200 dark:border-zinc-800 flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm tracking-tight">CM-offline</span>
            {isSyncing && (
              <span className="text-[10px] text-blue-400 animate-pulse">sync…</span>
            )}
            {!isOnline && pendingCount > 0 && (
              <span className="text-[10px] font-mono bg-amber-100 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 px-1.5 rounded-full">
                {pendingCount} hors ligne
              </span>
            )}
            {!isOnline && pendingCount === 0 && (
              <span className="text-[10px] text-zinc-400">hors ligne</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => changeMonth(shiftMonth(currentMonth,-1))} disabled={monthLoading}
              className="w-10 h-10 flex items-center justify-center rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-3xl disabled:opacity-40">‹</button>
            <span className="text-sm font-semibold w-40 text-center">{MONTH_FR[mo-1]} {year}</span>
            <button onClick={() => changeMonth(shiftMonth(currentMonth,1))} disabled={monthLoading}
              className="w-10 h-10 flex items-center justify-center rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-3xl disabled:opacity-40">›</button>
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
            {localScenarios.map((scenario, idx) => {
              // Mai et Noël : placeholders à 0 — port Python à venir (instructions.md AUTRE MODIFICATION).
              const primeMai = 0;
              const primeNoel = 0;
              // En juillet/août pour TAF*_10_12, A330 + Instruction passent à 100%
              // (× 30/nb30e pour annuler la proration appliquée en amont).
              const nb30eRegime = REGIME_NB30E[userRegime] ?? NB_30E;
              const a330InstrBoost = isFullPrimeMonth(userRegime, mo) && nb30eRegime > 0 ? 30 / nb30eRegime : 1;
              const monthlyFixedPrimes =
                primeIncitationUnit * incitCount
                + (primeA330 + primeInstruction) * a330InstrBoost
                + primeMai + primeNoel;
              const stats = computeStats(scenario.items, year, mo, cngPv, cngHs, userRegime, monthlyFixedPrimes, article81Data, valeurJour);
              const isLast = idx === localScenarios.length - 1;
              return (
                <div key={scenario.name}
                  className={`flex flex-shrink-0 ${!isLast ? 'border-b border-zinc-200 dark:border-zinc-800' : ''}`}
                  style={{ height: ROW_H }}
                >
                  {/* Label */}
                  <div className="flex-shrink-0 flex flex-col border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 py-2 items-center"
                    style={{ width: LABEL_W }}>
                    <span className="text-2xl font-bold text-zinc-700 dark:text-zinc-100 mb-1">{scenario.name}</span>

                    {/* ON / Congés */}
                    <div className="w-full px-2 flex items-center justify-center gap-1.5 mb-1">
                      {stats.onDays > 0 && (
                        <span className="text-[9px] font-semibold font-mono bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 px-1 rounded">
                          {stats.onDays}ON
                        </span>
                      )}
                      {stats.congeDays > 0 && (
                        <span className="text-[9px] font-semibold font-mono bg-pink-100 dark:bg-pink-950/50 text-pink-600 dark:text-pink-400 px-1 rounded">
                          {stats.congeDays}cg
                        </span>
                      )}
                    </div>

                    <div className="w-full px-2 flex flex-col gap-[2px]">
                      <FinRow label="FIXE" value={stats.fin.fixe}   cls="text-zinc-400" />
                      <FinRow label="PV"   value={stats.fin.pv}     cls="text-blue-500" />
                      {stats.fin.hs > 0 && (
                        <FinRow label="HS" value={stats.fin.hs}     cls="text-green-500" />
                      )}
                      {stats.fin.dif > 0 && (
                        <FinRow label="DIF" value={stats.fin.dif}   cls="text-violet-500" />
                      )}
                      {stats.fin.primes > 0 && (
                        <FinRow label="+P" value={stats.fin.primes} cls="text-amber-500" />
                      )}
                      <div className="border-t border-zinc-300 dark:border-zinc-600 my-0.5" />
                      <FinRow label="=" value={stats.fin.total} cls="text-zinc-700 dark:text-zinc-100" bold />
                      {stats.congeDays > 0 && (
                        <>
                          <FinRow label="+cg" value={stats.congeAmount} cls="text-pink-500" />
                          <div className="border-t border-dashed border-zinc-300 dark:border-zinc-600 my-0.5" />
                          <FinRow label="BRUT" value={stats.brut} cls="text-emerald-600 dark:text-emerald-400" bold />
                        </>
                      )}
                      {stats.totalA81 > 0 && (
                        <>
                          <div className="border-t border-dashed border-emerald-300 dark:border-emerald-700/40 my-0.5" />
                          <FinRow label="A81" value={stats.totalA81} cls="text-emerald-600 dark:text-emerald-400" bold />
                        </>
                      )}
                    </div>
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
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Action bar */}
        <div className="flex-shrink-0 flex items-center gap-2 h-14 border-t border-zinc-200 dark:border-zinc-800 px-4 bg-zinc-50 dark:bg-zinc-900 overflow-x-auto">

          {/* Compteur prime d'incitation 0–5 */}
          <span className="text-xs text-zinc-400 flex-shrink-0">Prime d'incitation</span>
          <div className="flex-shrink-0 flex items-center gap-1">
            {[0, 1, 2, 3, 4, 5].map(n => (
              <button key={n} onClick={() => changeIncit(n)}
                className={[
                  'w-7 h-7 rounded-full text-xs font-semibold border-2 transition-all',
                  incitCount === n
                    ? 'border-zinc-800 dark:border-zinc-100 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
                    : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:border-zinc-400',
                ].join(' ')}>
                {n}
              </button>
            ))}
          </div>

          {/* Propagation A → B / A → C */}
          <div className="flex-shrink-0 flex items-center gap-1.5 ml-2 pl-2 border-l border-zinc-200 dark:border-zinc-700">
            <button
              onClick={() => propagateFlights('B')}
              className="px-2.5 py-1 rounded-full bg-zinc-200 hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-200 text-xs font-semibold transition-colors"
              title="Propage les vols de A vers B"
            >
              A → B
            </button>
            <button
              onClick={() => propagateFlights('C')}
              className="px-2.5 py-1 rounded-full bg-zinc-200 hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-200 text-xs font-semibold transition-colors"
              title="Propage les vols de A vers C"
            >
              A → C
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
            onClick={() => setSearchOpen(true)}
            className="ml-auto flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            Rotations
          </button>
          {/* Import button — admins only */}
          {isAdmin && (
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

        {/* Sheet */}
        {sheet && (
          <>
            <div className="fixed inset-0 z-20 bg-black/20" onClick={() => setSheet(null)} />
            <div className="fixed bottom-0 left-0 right-0 z-30 bg-white dark:bg-zinc-900 rounded-t-2xl shadow-xl">
              <div className="p-5 space-y-4">

                {/* Sheet header */}
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
                    {sheet.mode === 'edit' && (
                      <button onClick={handleDelete}
                        className="px-3 py-1.5 rounded-lg border border-red-200 text-red-500 text-sm hover:bg-red-50">
                        Supprimer
                      </button>
                    )}
                    <button onClick={() => setSheet(null)} className="text-zinc-400 hover:text-zinc-600 text-2xl leading-none">×</button>
                  </div>
                </div>

                {/* Kind selector (hide in edit mode) */}
                {sheet.mode === 'add' && (
                  <div className="flex flex-wrap gap-2">
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
                  </div>
                )}

                {/* Congés: nb de jours */}
                {addKind === 'conge' && (
                  <div className="flex items-center gap-3">
                    <label className="text-sm text-zinc-600 dark:text-zinc-300 font-medium">Nb. de jours</label>
                    <input
                      type="number" min={1} max={31}
                      value={nbJours}
                      onChange={e => handleNbJoursChange(e.target.value)}
                      className="w-20 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-center font-semibold"
                      autoFocus
                    />
                    {nbJours && parseInt(nbJours) >= 1 && (
                      <span className="text-sm text-zinc-500">
                        → {new Date(computedEnd + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}
                      </span>
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

                {/* OFF/Sol/etc: date fin libre */}
                {addKind !== 'conge' && addKind !== 'taf' && (
                  <div className="flex items-center gap-3">
                    <label className="text-xs text-zinc-500">Jusqu'au</label>
                    <input type="date" value={addEnd} min={sheet.date}
                      onChange={e => { setAddEnd(e.target.value); setOverlapErr(false); }}
                      className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm" />
                  </div>
                )}

                {/* Edit: show current dates */}
                {sheet.mode === 'edit' && sheet.item && addKind === 'conge' && (
                  <p className="text-xs text-zinc-400">
                    Modifiez le nombre de jours pour réduire ou agrandir le bloc (le premier jour reste fixe).
                  </p>
                )}

                {/* Overlap error */}
                {overlapErr && (
                  <p className="text-sm text-red-500 font-medium">
                    ⚠ Cette période chevauche une activité existante.
                  </p>
                )}

                {/* Submit */}
                <button onClick={handleSubmit} disabled={isPending || (addKind === 'conge' && !nbJours)}
                  className="w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">
                  {sheet.mode === 'edit' ? 'Mettre à jour' : 'Placer'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Search panel */}
      {searchOpen && (
        <SearchPanel
          month={currentMonth}
          scenarios={localScenarios}
          onClose={() => setSearchOpen(false)}
          onItemAdded={(item, draftId) => {
            applyAdd(item, draftId);
            // Bump pending uniquement si offline — online n'a pas d'op en attente
            if (!isOnline) setPendingCount(c => c + 1);
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
