'use client';

import { useState, useEffect, useTransition, useMemo } from 'react';
import { type RotationSignature, type RotationInstance } from '@/app/actions/search';
import type { Scenario, CalendarItem } from '@/app/page';
import type { ScenarioName } from '@/app/actions/planning';
import { loadRotationsFromDB } from '@/lib/local-db';
import { enqueueAdd, enqueueDelete } from '@/lib/sync-service';
import { rotationValue } from '@/lib/finance';
import { ACTIVITY_META, type BidCategory } from '@/lib/activity-meta';
import { hardBlockerWindow } from '@/lib/rpc';

const BID_LABEL: Record<BidCategory, string> = {
  dda_vol:     'DDA',
  vol_p:       'Vol P',
  dda_off:     'DDA OFF',
  elabo_suivi: 'Élabo/Suivi',
};

// ─── helpers ──────────────────────────────────────────────────────────────────

const AIRCRAFT_FAMILIES: { label: string; codes: string[] }[] = [
  { label: 'A330', codes: ['332', '335'] },
  { label: 'A350', codes: ['359'] },
  { label: 'B777', codes: ['77W', '772', '77X'] },
  { label: 'B787', codes: ['788', '789'] },
];

const ON_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

type SortBy = 'h2hc' | 'on' | 'hc_on';
const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: 'h2hc',  label: 'H2/HC' },
  { value: 'on',    label: 'Nb. ON' },
  { value: 'hc_on', label: 'HC/ON' },
];

type DateOp = '>=' | '=' | '<=';
const DATE_OPS: DateOp[] = ['>=', '=', '<='];

function fmtDate(dateStr: string) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function fmtLocalTime(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
}

function endDateFromArrivee(arrivee_at: string): string {
  return arrivee_at.slice(0, 10);
}

/** Plage corps d'un item (sans RPC) en ms.
 *  - Vol         : [depart_at, arrivee_at].
 *  - Hard blocker: fenêtre d'occupation (8h-18h Paris pour sol/medical/autre,
 *    jour entier pour sim/instr) via hardBlockerWindow.
 *  - Autre       : [start_date 00:00 UTC, end_date+1 00:00 UTC). */
function rawRangeMs(item: CalendarItem): [number, number] {
  if (item.kind === 'flight') {
    const meta = (item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta))
      ? item.meta as Record<string, unknown>
      : null;
    const depart  = typeof meta?.depart_at  === 'string' ? new Date(meta.depart_at).getTime()  : NaN;
    const arrivee = typeof meta?.arrivee_at === 'string' ? new Date(meta.arrivee_at).getTime() : NaN;
    if (Number.isFinite(depart) && Number.isFinite(arrivee)) {
      return [depart, arrivee];
    }
  }
  const w = hardBlockerWindow(item);
  if (w) return [w.startMs, w.endMs];
  const startMs = new Date(item.start_date + 'T00:00:00Z').getTime();
  const endMs   = new Date(item.end_date   + 'T00:00:00Z').getTime() + 86_400_000;
  return [startMs, endMs];
}

/** Items en conflit avec le candidat (vol) :
 *    1. Vol↔vol : overlap calendaire OU overlap RPC ↔ corps de l'autre vol.
 *    2. Vol↔autre activité (sol/sim/medical/instr/autre/conge/conge_ss/off/taf) :
 *       overlap corps↔fenêtre de l'item. Fenêtre = 8h-18h Paris pour
 *       sol/medical/autre, jour entier pour sim/instr, jours pleins UTC pour
 *       conge/conge_ss/off/taf. Le chevauchement RPC seul ne bloque pas —
 *       il sera juste rendu en rouge dans le gantt. */
function getConflictingItems(
  items: CalendarItem[],
  candDepartAt: string,
  candArriveeAt: string,
  candRestAfterH: number | null | undefined,
): CalendarItem[] {
  const candStart = candDepartAt.slice(0, 10);
  const candEnd   = candArriveeAt.slice(0, 10);
  const candDepartMs  = new Date(candDepartAt).getTime();
  const candArriveeMs = new Date(candArriveeAt).getTime();
  const candRpcEndMs  = candArriveeMs + Math.max(0, candRestAfterH ?? 0) * 3_600_000;
  return items.filter(i => {
    // Spillovers (vols à cheval issus du mois précédent) : non supprimables ici.
    if (i._isSpillover) return false;
    if (i.kind === 'flight') {
      // Vol↔vol : date overlap OU corps vs RPC d'autrui.
      if (i.start_date <= candEnd && i.end_date >= candStart) return true;
      const [iStart, iEnd] = rawRangeMs(i);
      return iStart < candRpcEndMs && candDepartMs < iEnd;
    }
    // Toute autre activité : overlap corps du vol ↔ fenêtre de l'item.
    const [iStart, iEnd] = rawRangeMs(i);
    return iStart < candArriveeMs && candDepartMs < iEnd;
  });
}

function hasOverlapWithRpc(
  items: CalendarItem[],
  candDepartAt: string,
  candArriveeAt: string,
  candRestAfterH: number | null | undefined,
): boolean {
  return getConflictingItems(items, candDepartAt, candArriveeAt, candRestAfterH).length > 0;
}

/** Libellé court d'un item pour affichage dans le confirm de remplacement. */
function describeItem(item: CalendarItem): string {
  const meta = ACTIVITY_META[item.kind];
  const m = (item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta))
    ? item.meta as Record<string, unknown> : null;
  const label = item.kind === 'flight' && typeof m?.destination === 'string'
    ? String(m.destination)
    : meta.label;
  const startD = new Date(item.start_date + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  const endD   = new Date(item.end_date   + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return item.start_date === item.end_date ? `${label} (${startD})` : `${label} (${startD} → ${endD})`;
}

function matchesFamily(aircraftCode: string, families: string[]): boolean {
  if (families.length === 0) return true;
  return families.some(fam => {
    const family = AIRCRAFT_FAMILIES.find(f => f.label === fam);
    return family?.codes.some(c => aircraftCode.includes(c));
  });
}

// ─── RotationCard ──────────────────────────────────────────────────────────────

function RotationCard({
  sig,
  scenarios,
  preselectedScenario,
  preselectedCategory,
  onPlaced,
  onItemAdded,
  onItemsRemoved,
}: {
  sig: RotationSignature;
  scenarios: Scenario[];
  preselectedScenario?: ScenarioName;
  preselectedCategory?: BidCategory;
  onPlaced: () => void;
  onItemAdded?: (item: CalendarItem, draftId: string) => void;
  /** Notifie le parent qu'on a supprimé des items (cas remplacement). */
  onItemsRemoved?: (ids: string[]) => void;
}) {
  const [selectedInst, setSelectedInst] = useState<RotationInstance | null>(null);
  const [overlapErr, setOverlapErr]     = useState<string | null>(null);
  const [isPending, startTransition]    = useTransition();
  // Demande de remplacement : chip conflit cliquée en mode 1-clic. On affiche
  // un confirm inline listant les items à remplacer avant d'agir.
  const [pendingReplace, setPendingReplace] = useState<{
    inst: RotationInstance;
    scenario: Scenario;
    conflicts: CalendarItem[];
  } | null>(null);
  // Fallback si pas de category présélectionnée (mode legacy : panneau ouvert
  // depuis un endroit qui ne l'a pas spécifiée — actuellement aucun, mais on
  // garde la prop optionnelle pour ne pas casser d'éventuels futurs callers).
  const [bidCatFallback, setBidCatFallback] = useState<BidCategory>('dda_vol');
  const bidCat = preselectedCategory ?? bidCatFallback;

  const pvPrimeEur = Math.round(rotationValue(sig.hcr_crew, sig.prime, sig.tsv_nuit));

  /** Construit l'item planning_item à partir de l'instance + signature. */
  function buildNewItem(inst: RotationInstance): CalendarItem {
    const endDate = endDateFromArrivee(inst.arrivee_at);
    const meta = {
      destination:   sig.rotation_code,
      zone:          sig.zone,
      hc:            sig.hc,
      hcr_crew:      sig.hcr_crew,
      nb_on_days:    sig.nb_on_days,
      a81:           sig.a81,
      prime:         sig.prime,
      // Per-instance RPC (fallback sur signature pour les instances anciennes
      // dont rest_*_h n'ont pas encore été backfilled).
      rest_before_h: inst.rest_before_h ?? sig.rest_before_h,
      rest_after_h:  inst.rest_after_h  ?? sig.rest_after_h,
      tsv_nuit:      sig.tsv_nuit,
      temps_sej:     sig.temps_sej,
      depart_at:     inst.depart_at,
      arrivee_at:    inst.arrivee_at,
      // Timestamps activity pour les barres pré/post du Gantt (source de vérité
      // pour le RPC). Peut être null si l'instance n'a pas encore été backfilled.
      scheduled_begin_activity_at: inst.scheduled_begin_activity_at,
      scheduled_end_activity_at:   inst.scheduled_end_activity_at,
    };
    return {
      id: crypto.randomUUID(),
      kind: 'flight',
      start_date: inst.depart_date, end_date: endDate,
      bid_category: bidCat,
      pairing_instance_id: inst.id,
      meta,
    };
  }

  function place(inst: RotationInstance, scenario: Scenario) {
    const restH = inst.rest_after_h ?? sig.rest_after_h;
    if (hasOverlapWithRpc(scenario.items, inst.depart_at, inst.arrivee_at, restH)) {
      setOverlapErr(`Chevauchement (vol ou RPC) dans le scénario ${scenario.name}`);
      return;
    }
    const newItem = buildNewItem(inst);
    onItemAdded?.(newItem, scenario.id);
    startTransition(async () => {
      await enqueueAdd(newItem, scenario.id);
      setSelectedInst(null);
      onPlaced();
    });
  }

  /** Supprime les conflits puis pose le nouveau vol. Compatible offline
   *  (passe par enqueueDelete/enqueueAdd → rejoués au prochain Sync). */
  function placeWithReplacement(inst: RotationInstance, scenario: Scenario, conflicts: CalendarItem[]) {
    const newItem = buildNewItem(inst);
    const removedIds = conflicts.map(c => c.id);
    // Optimistic UI : on retire les conflits + ajoute le nouveau d'un coup.
    onItemsRemoved?.(removedIds);
    onItemAdded?.(newItem, scenario.id);
    startTransition(async () => {
      for (const id of removedIds) await enqueueDelete(id);
      await enqueueAdd(newItem, scenario.id);
      setSelectedInst(null);
      setPendingReplace(null);
      onPlaced();
    });
  }

  function selectInst(inst: RotationInstance) {
    // Nouveau flow : si catégorie + scénario présélectionnés, on place
    // directement au 1er clic sur la date (4 clics total : Rotations → cat →
    // scénario → date). Sinon, on retombe sur l'ancien flow (sélection puis
    // bouton "Placer en X").
    if (preselectedScenario && preselectedCategory) {
      const sc = scenarios.find(s => s.name === preselectedScenario);
      if (sc) {
        place(inst, sc);
        return;
      }
    }
    if (preselectedScenario) {
      const sc = scenarios.find(s => s.name === preselectedScenario);
      if (sc) {
        const restH = inst.rest_after_h ?? sig.rest_after_h;
        if (hasOverlapWithRpc(sc.items, inst.depart_at, inst.arrivee_at, restH)) {
          setOverlapErr(`Chevauchement (vol ou RPC) dans le scénario ${sc.name}`);
        } else {
          setOverlapErr(null);
        }
      }
    } else {
      setOverlapErr(null);
    }
    setSelectedInst(prev => prev?.id === inst.id ? null : inst);
  }

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3 space-y-2">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-bold text-zinc-800 dark:text-zinc-100">{sig.rotation_code}</span>
          <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 font-mono">{sig.nb_on_days}ON</span>
          {sig.zone && <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500">{sig.zone}</span>}
          <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 font-mono">{sig.aircraft_code}</span>
          {sig.dead_head && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-orange-100 dark:bg-orange-950/50 text-orange-600 dark:text-orange-400">
              MEP {sig.mep_flight ?? ''}
            </span>
          )}
          {sig.peq != null && sig.peq > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-purple-100 dark:bg-purple-950/50 text-purple-600 dark:text-purple-400">
              PEQ{sig.peq}
            </span>
          )}
          {sig.instances[0] && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 font-mono">
              {fmtLocalTime(sig.instances[0].depart_at)} → {fmtLocalTime(sig.instances[0].arrivee_at)}
            </span>
          )}
          <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 font-mono">
            PV+P {pvPrimeEur}€
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <span>HC <span className="font-semibold text-zinc-700 dark:text-zinc-200">{sig.hc.toFixed(2)}</span>
            {sig.a81 && <span className="text-amber-600 dark:text-amber-400"> →{sig.hcr_crew.toFixed(2)}</span>}
          </span>
          <span>HDV <span className="font-semibold text-zinc-700 dark:text-zinc-200">{sig.hdv.toFixed(2)}</span></span>
          <span>Séj <span className="font-semibold text-zinc-700 dark:text-zinc-200">{sig.temps_sej.toFixed(0)}h</span></span>
          <span>{sig.legs_number} tronç.</span>
        </div>
      </div>

      {/* Date chips */}
      <div className="flex flex-wrap gap-2">
        {sig.instances.map(inst => {
          const isSelected = selectedInst?.id === inst.id;
          const endDate = endDateFromArrivee(inst.arrivee_at);
          // En mode 1-clic (cat + scn présélectionnés) : un chip en conflit reste
          // cliquable ; le clic ouvre un confirm de remplacement. Hors 1-clic,
          // on garde la sélection normale (l'utilisateur choisira ensuite le
          // scénario via les boutons en bas).
          const sc = preselectedScenario ? scenarios.find(s => s.name === preselectedScenario) : null;
          const restH = inst.rest_after_h ?? sig.rest_after_h;
          const conflictItems = (preselectedScenario && preselectedCategory && sc)
            ? getConflictingItems(sc.items, inst.depart_at, inst.arrivee_at, restH)
            : [];
          const conflictsHere = conflictItems.length > 0;
          return (
            <button
              key={inst.id}
              onClick={() => {
                if (conflictsHere && sc && preselectedCategory) {
                  setPendingReplace({ inst, scenario: sc, conflicts: conflictItems });
                  setOverlapErr(null);
                  return;
                }
                selectInst(inst);
              }}
              disabled={isPending}
              title={conflictsHere ? `Cliquer pour remplacer dans le scénario ${preselectedScenario}` : undefined}
              className={[
                'text-xs px-3 py-2 rounded-xl border transition-all min-h-[44px] flex items-center',
                conflictsHere
                  ? 'border-red-300 dark:border-red-800/50 text-red-500 dark:text-red-400 bg-red-50/60 dark:bg-red-950/30 hover:bg-red-100 dark:hover:bg-red-950/50'
                  : isSelected
                  ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 font-semibold'
                  : 'border-zinc-200 dark:border-zinc-700 hover:border-zinc-400 active:bg-zinc-100 dark:active:bg-zinc-800 text-zinc-600 dark:text-zinc-300',
              ].join(' ')}
            >
              {fmtDate(inst.depart_date)} → {fmtDate(endDate)}
            </button>
          );
        })}
      </div>

      {/* Confirm de remplacement (chip rouge cliquée en 1-clic) */}
      {pendingReplace && (
        <div className="rounded-xl border border-red-300 dark:border-red-800/50 bg-red-50/50 dark:bg-red-950/20 p-3 space-y-2">
          <p className="text-xs font-semibold text-red-700 dark:text-red-300">
            Remplacer dans {pendingReplace.scenario.name} ?
          </p>
          <ul className="text-xs text-zinc-600 dark:text-zinc-300 space-y-0.5">
            {pendingReplace.conflicts.map(c => (
              <li key={c.id} className="font-mono">− {describeItem(c)}</li>
            ))}
            <li className="font-mono text-emerald-700 dark:text-emerald-400">
              + {sig.rotation_code} ({fmtDate(pendingReplace.inst.depart_date)} → {fmtDate(endDateFromArrivee(pendingReplace.inst.arrivee_at))})
            </li>
          </ul>
          <div className="flex gap-2">
            <button
              onClick={() => placeWithReplacement(pendingReplace.inst, pendingReplace.scenario, pendingReplace.conflicts)}
              disabled={isPending}
              className="flex-1 px-3 py-2 rounded-lg bg-red-600 text-white text-xs font-bold hover:bg-red-700 disabled:opacity-40 min-h-[40px]"
            >
              Remplacer
            </button>
            <button
              onClick={() => setPendingReplace(null)}
              disabled={isPending}
              className="px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 min-h-[40px]"
            >
              Annuler
            </button>
          </div>
        </div>
      )}

      {/* Erreur overlap éventuelle (cas marginal du mode 1-clic) */}
      {preselectedScenario && preselectedCategory && overlapErr && (
        <div className="text-xs text-red-500">{overlapErr}</div>
      )}

      {/* Fallback (mode legacy sans présélection complète) : radio catégorie +
          bouton "Placer en X". Reste visible si preselectedCategory absent. */}
      {selectedInst && !(preselectedScenario && preselectedCategory) && (
        <>
          {!preselectedCategory && (
            <div className="flex items-center gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800 flex-wrap">
              <span className="text-xs text-zinc-400 flex-shrink-0">Catégorie :</span>
              {(['dda_vol', 'vol_p', 'elabo_suivi'] as BidCategory[]).map(value => (
                <button
                  key={value}
                  onClick={() => setBidCatFallback(value)}
                  className={[
                    'px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all min-h-[36px]',
                    bidCatFallback === value
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300'
                      : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:border-zinc-400',
                  ].join(' ')}
                >
                  {BID_LABEL[value]}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 pt-2 flex-wrap">
            {preselectedScenario && !overlapErr ? (
              <>
                <span className="text-xs text-zinc-400 flex-shrink-0">Placer dans :</span>
                {(() => {
                  const sc = scenarios.find(s => s.name === preselectedScenario);
                  return sc ? (
                    <button
                      onClick={() => place(selectedInst, sc)}
                      disabled={isPending}
                      className="px-4 py-2 rounded-xl bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm font-bold hover:bg-zinc-700 dark:hover:bg-zinc-300 active:scale-95 disabled:opacity-40 transition-all min-h-[44px]"
                    >
                      Placer en {sc.name}
                    </button>
                  ) : null;
                })()}
              </>
            ) : (
              <>
                <span className="text-xs text-zinc-400 flex-shrink-0">
                  {overlapErr ? 'Autre scénario :' : 'Scénario :'}
                </span>
                {scenarios.map(sc => (
                  <button
                    key={sc.name}
                    onClick={() => place(selectedInst, sc)}
                    disabled={isPending}
                    className="px-4 py-2 rounded-xl bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm font-bold hover:bg-zinc-700 dark:hover:bg-zinc-300 active:scale-95 disabled:opacity-40 transition-all min-h-[44px]"
                  >
                    {sc.name}
                  </button>
                ))}
                {overlapErr && <span className="text-xs text-red-500">{overlapErr}</span>}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── SearchPanel ───────────────────────────────────────────────────────────────

export function SearchPanel({
  month,
  scenarios,
  preselectedScenario,
  preselectedCategory,
  preselectedDate,
  panelTop,
  onClose,
  onItemAdded,
  onItemsRemoved,
}: {
  month: string;
  scenarios: Scenario[];
  preselectedScenario?: ScenarioName;
  preselectedCategory?: BidCategory;
  /** Pré-remplit le filtre départ avec op '=' sur cette date (YYYY-MM-DD). */
  preselectedDate?: string;
  panelTop?: number;
  onClose: () => void;
  onItemAdded?: (item: CalendarItem, draftId: string) => void;
  onItemsRemoved?: (ids: string[]) => void;
}) {
  const [data, setData]               = useState<RotationSignature[] | null>(null);
  const [loading, setLoading]         = useState(true);
  const [fromCache, _setFromCache]    = useState(false);
  const [placedCount, setPlacedCount] = useState(0);

  // Filtres
  const [query,    setQuery]    = useState('');
  const [families, setFamilies] = useState<string[]>([]);
  const [onExact,  setOnExact]  = useState<number | null>(null);
  const [sortBy,   setSortBy]   = useState<SortBy>('h2hc');
  const [dateFilter, setDateFilter] = useState<string | null>(preselectedDate ?? null);
  const [dateOp,     setDateOp]     = useState<DateOp>('=');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadRotationsFromDB(month).then(cached => {
      if (cancelled) return;
      setData(cached);
      setLoading(false);
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [month]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const list: RotationSignature[] = [];
    for (const s of data) {
      // Sigs rescued = hors snapshot courant (spillover M-1, vol d'un ancien
      // snapshot). Présentes en cache pour le calendrier/EP4, mais pas des
      // rotations proposables ici — et elles faussent le compteur de dates.
      if (s.rescued) continue;
      if (query && !s.rotation_code.toLowerCase().includes(query.toLowerCase())) continue;
      if (!matchesFamily(s.aircraft_code, families)) continue;
      if (onExact !== null && s.nb_on_days !== onExact) continue;
      // Filtre date départ : restreint la liste d'instances de chaque signature.
      // Si toutes les instances sont éliminées, la signature disparaît.
      if (dateFilter) {
        const insts = s.instances.filter(inst => {
          if (dateOp === '=')  return inst.depart_date === dateFilter;
          if (dateOp === '>=') return inst.depart_date >= dateFilter;
          if (dateOp === '<=') return inst.depart_date <= dateFilter;
          return true;
        });
        if (insts.length === 0) continue;
        list.push({ ...s, instances: insts });
      } else {
        list.push(s);
      }
    }
    return list.sort((a, b) => {
      if (sortBy === 'h2hc')  return b.hcr_crew - a.hcr_crew;
      if (sortBy === 'on')    return b.nb_on_days - a.nb_on_days;
      if (sortBy === 'hc_on') return (b.hcr_crew / b.nb_on_days) - (a.hcr_crew / a.nb_on_days);
      return 0;
    });
  }, [data, query, families, onExact, sortBy, dateFilter, dateOp]);

  const totalInstances = filtered.reduce((a, s) => a + s.instances.length, 0);

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-30 bg-black/20" onClick={onClose} />

      {/* Panel */}
      <div
        className="fixed left-0 right-0 z-40 bg-white dark:bg-zinc-950 rounded-t-2xl shadow-2xl flex flex-col"
        style={panelTop !== undefined
          ? { top: panelTop, bottom: 0 }
          : { bottom: 0, height: '70vh' }}
      >
        {/* ── Filtres compacts ── */}
        <div className="flex-shrink-0 px-3 pt-3 pb-2 border-b border-zinc-200 dark:border-zinc-800 space-y-2">

          {/* Ligne 1 : contexte + tri + recherche compacte + fermer */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-zinc-500 flex-shrink-0">Rotations</span>
            <span className="text-xs text-zinc-400 flex-shrink-0">{month}</span>
            {preselectedCategory && (
              <span className="px-1.5 py-0.5 rounded-full bg-blue-600 text-white text-[10px] font-bold flex-shrink-0">
                {BID_LABEL[preselectedCategory]}
              </span>
            )}
            {preselectedScenario && (
              <span className="px-1.5 py-0.5 rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-xs font-bold flex-shrink-0">
                → {preselectedScenario}
              </span>
            )}
            <div className="flex gap-1 flex-shrink-0">
              {SORT_OPTIONS.map(o => (
                <button
                  key={o.value}
                  onClick={() => setSortBy(o.value)}
                  className={[
                    'px-2 py-1 rounded-lg border text-[11px] font-medium transition-all',
                    sortBy === o.value
                      ? 'bg-zinc-800 dark:bg-zinc-200 border-zinc-800 dark:border-zinc-200 text-white dark:text-zinc-900'
                      : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400',
                  ].join(' ')}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <input
              type="search"
              placeholder="Dest."
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="ml-auto w-32 sm:w-44 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-1.5 text-sm placeholder-zinc-400 outline-none focus:border-blue-400"
            />
            <button
              onClick={onClose}
              className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 w-8 h-8 flex items-center justify-center text-2xl leading-none flex-shrink-0"
            >
              ×
            </button>
          </div>

          {/* Ligne 2 : avions + ON + départ + compteur (scroll horizontal mobile) */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5" style={{ WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>
            {AIRCRAFT_FAMILIES.map(f => (
              <button
                key={f.label}
                onClick={() => setFamilies(prev => prev.includes(f.label) ? prev.filter(x => x !== f.label) : [...prev, f.label])}
                className={[
                  'flex-shrink-0 px-3 py-1.5 rounded-full border text-xs font-medium transition-all',
                  families.includes(f.label)
                    ? 'bg-blue-500 border-blue-500 text-white'
                    : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400',
                ].join(' ')}
              >
                {f.label}
              </button>
            ))}
            <div className="w-px h-4 bg-zinc-300 dark:bg-zinc-600 flex-shrink-0 mx-0.5" />
            {ON_VALUES.map(n => (
              <button
                key={n}
                onClick={() => setOnExact(v => v === n ? null : n)}
                className={[
                  'flex-shrink-0 px-2 py-1.5 rounded-full border text-xs font-mono transition-all',
                  onExact === n
                    ? 'bg-zinc-800 dark:bg-zinc-200 border-zinc-800 dark:border-zinc-200 text-white dark:text-zinc-900 font-semibold'
                    : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400',
                ].join(' ')}
              >
                {n}ON
              </button>
            ))}
            <div className="w-px h-4 bg-zinc-300 dark:bg-zinc-600 flex-shrink-0 mx-0.5" />
            <span className="text-xs text-zinc-400 flex-shrink-0">Départ</span>
            {DATE_OPS.map(op => (
              <button
                key={op}
                onClick={() => setDateOp(op)}
                className={[
                  'flex-shrink-0 w-9 py-1.5 rounded-full border text-xs font-mono font-semibold transition-all',
                  dateOp === op
                    ? 'bg-zinc-800 dark:bg-zinc-200 border-zinc-800 dark:border-zinc-200 text-white dark:text-zinc-900'
                    : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400',
                ].join(' ')}
              >
                {op}
              </button>
            ))}
            <input
              type="date"
              value={dateFilter ?? ''}
              min={`${month}-01`}
              onChange={e => setDateFilter(e.target.value || null)}
              className="flex-shrink-0 w-36 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-2 py-1 text-xs outline-none focus:border-blue-400"
            />
            {dateFilter && (
              <button
                onClick={() => setDateFilter(null)}
                className="flex-shrink-0 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 w-6 h-6 flex items-center justify-center text-lg leading-none"
                title="Effacer le filtre date"
              >
                ×
              </button>
            )}
            {data && (
              <span className="flex-shrink-0 ml-auto pl-2 text-xs text-zinc-400">
                {filtered.length} rot. · {totalInstances} dates
                {placedCount > 0 && ` · ${placedCount} placé`}
                {fromCache && <span className="text-amber-500"> · cache</span>}
              </span>
            )}
          </div>
        </div>

        {/* Résultats */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3" style={{ WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>
          {loading ? (
            <div className="flex items-center justify-center h-32 text-sm text-zinc-400">Chargement…</div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-sm text-zinc-400">Aucune rotation correspondante.</div>
          ) : (
            filtered.map(sig => (
              <RotationCard
                key={sig.id}
                sig={sig}
                scenarios={scenarios}
                preselectedScenario={preselectedScenario}
                preselectedCategory={preselectedCategory}
                onPlaced={() => setPlacedCount(c => c + 1)}
                onItemAdded={onItemAdded}
                onItemsRemoved={onItemsRemoved}
              />
            ))
          )}
        </div>
      </div>
    </>
  );
}
