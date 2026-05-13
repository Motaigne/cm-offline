'use client';

import { useState, useEffect, useTransition, useMemo } from 'react';
import { getRotationsForMonth, type RotationSignature, type RotationInstance } from '@/app/actions/search';
import type { Scenario, CalendarItem } from '@/app/page';
import type { ScenarioName } from '@/app/actions/planning';
import { cacheRotations, loadRotationsFromDB } from '@/lib/local-db';
import { enqueueAdd } from '@/lib/sync-service';
import { PVEI, KSP } from '@/lib/finance';

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

function fmtDate(dateStr: string) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function fmtLocalTime(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
}

function endDateFromArrivee(arrivee_at: string): string {
  return arrivee_at.slice(0, 10);
}

function hasOverlap(items: CalendarItem[], start: string, end: string) {
  return items.some(i => i.start_date <= end && i.end_date >= start);
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
  onPlaced,
  onItemAdded,
}: {
  sig: RotationSignature;
  scenarios: Scenario[];
  preselectedScenario?: ScenarioName;
  onPlaced: () => void;
  onItemAdded?: (item: CalendarItem, draftId: string) => void;
}) {
  const [selectedInst, setSelectedInst] = useState<RotationInstance | null>(null);
  const [overlapErr, setOverlapErr]     = useState<string | null>(null);
  const [isPending, startTransition]    = useTransition();

  const pvPrimeEur = Math.round(sig.hcr_crew * PVEI * KSP + sig.prime * 2.5 * PVEI);

  function place(inst: RotationInstance, scenario: Scenario) {
    const endDate = endDateFromArrivee(inst.arrivee_at);
    if (hasOverlap(scenario.items, inst.depart_date, endDate)) {
      setOverlapErr(`Chevauchement dans le scénario ${scenario.name}`);
      return;
    }
    const id = crypto.randomUUID();
    const meta = {
      destination:   sig.rotation_code,
      zone:          sig.zone,
      hc:            sig.hc,
      hcr_crew:      sig.hcr_crew,
      nb_on_days:    sig.nb_on_days,
      a81:           sig.a81,
      prime:         sig.prime,
      rest_before_h: sig.rest_before_h,
      rest_after_h:  sig.rest_after_h,
      tsv_nuit:      sig.tsv_nuit,
      temps_sej:     sig.temps_sej,
      depart_at:     inst.depart_at,
      arrivee_at:    inst.arrivee_at,
    };
    const newItem: CalendarItem = { id, kind: 'flight', start_date: inst.depart_date, end_date: endDate, bid_category: null, meta };
    onItemAdded?.(newItem, scenario.id);
    startTransition(async () => {
      await enqueueAdd(newItem, scenario.id);
      setSelectedInst(null);
      onPlaced();
    });
  }

  function selectInst(inst: RotationInstance) {
    if (preselectedScenario) {
      const sc = scenarios.find(s => s.name === preselectedScenario);
      if (sc) {
        const endDate = endDateFromArrivee(inst.arrivee_at);
        if (hasOverlap(sc.items, inst.depart_date, endDate)) {
          setOverlapErr(`Chevauchement dans le scénario ${sc.name}`);
          setSelectedInst(inst);
          return;
        }
        place(inst, sc);
        return;
      }
    }
    setSelectedInst(prev => prev?.id === inst.id ? null : inst);
    setOverlapErr(null);
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
          return (
            <button
              key={inst.id}
              onClick={() => selectInst(inst)}
              className={[
                'text-xs px-3 py-2 rounded-xl border transition-all min-h-[44px] flex items-center',
                isSelected
                  ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 font-semibold'
                  : 'border-zinc-200 dark:border-zinc-700 hover:border-zinc-400 active:bg-zinc-100 dark:active:bg-zinc-800 text-zinc-600 dark:text-zinc-300',
              ].join(' ')}
            >
              {fmtDate(inst.depart_date)} → {fmtDate(endDate)}
            </button>
          );
        })}
      </div>

      {/* Scenario selector — seulement si pas de présélection, ou en fallback sur chevauchement */}
      {selectedInst && (!preselectedScenario || overlapErr) && (
        <div className="flex items-center gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800 flex-wrap">
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
        </div>
      )}
    </div>
  );
}

// ─── SearchPanel ───────────────────────────────────────────────────────────────

export function SearchPanel({
  month,
  scenarios,
  preselectedScenario,
  panelTop,
  onClose,
  onItemAdded,
}: {
  month: string;
  scenarios: Scenario[];
  preselectedScenario?: ScenarioName;
  panelTop?: number;
  onClose: () => void;
  onItemAdded?: (item: CalendarItem, draftId: string) => void;
}) {
  const [data, setData]               = useState<RotationSignature[] | null>(null);
  const [loading, setLoading]         = useState(true);
  const [fromCache, setFromCache]     = useState(false);
  const [placedCount, setPlacedCount] = useState(0);

  // Filtres
  const [query,    setQuery]    = useState('');
  const [families, setFamilies] = useState<string[]>([]);
  const [onExact,  setOnExact]  = useState<number | null>(null);
  const [sortBy,   setSortBy]   = useState<SortBy>('h2hc');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFromCache(false);

    // 1. IndexedDB en premier — instantané
    loadRotationsFromDB(month).then(cached => {
      if (cancelled || cached.length === 0) return;
      setData(cached);
      setFromCache(true);
      setLoading(false);
    }).catch(() => {});

    // 2. Réseau en arrière-plan — remplace le cache quand disponible
    getRotationsForMonth(month)
      .then(d => {
        if (cancelled) return;
        setData(d);
        setFromCache(false);
        setLoading(false);
        cacheRotations(d, month).catch(() => {});
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [month]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const list = data.filter(s => {
      if (query && !s.rotation_code.toLowerCase().includes(query.toLowerCase())) return false;
      if (!matchesFamily(s.aircraft_code, families)) return false;
      if (onExact !== null && s.nb_on_days !== onExact) return false;
      return true;
    });
    return [...list].sort((a, b) => {
      if (sortBy === 'h2hc')  return b.hcr_crew - a.hcr_crew;
      if (sortBy === 'on')    return b.nb_on_days - a.nb_on_days;
      if (sortBy === 'hc_on') return (b.hcr_crew / b.nb_on_days) - (a.hcr_crew / a.nb_on_days);
      return 0;
    });
  }, [data, query, families, onExact, sortBy]);

  const totalInstances = data?.reduce((a, s) => a + s.instances.length, 0) ?? 0;

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

          {/* Ligne 1 : contexte + recherche destination + fermer */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-zinc-500 flex-shrink-0">Rotations</span>
            <span className="text-xs text-zinc-400 flex-shrink-0">{month}</span>
            {preselectedScenario && (
              <span className="px-1.5 py-0.5 rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-xs font-bold flex-shrink-0">
                → {preselectedScenario}
              </span>
            )}
            <input
              type="search"
              placeholder="Rech. Dest. (ex : LAX, HND, SCL…)"
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="flex-1 min-w-0 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-sm placeholder-zinc-400 outline-none focus:border-blue-400"
            />
            <button
              onClick={onClose}
              className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 w-8 h-8 flex items-center justify-center text-2xl leading-none flex-shrink-0"
            >
              ×
            </button>
          </div>

          {/* Ligne 2 : avions + ON (même rangée, scroll horizontal) */}
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
          </div>

          {/* Ligne 3 : tri + compteur */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-400 flex-shrink-0">Trier</span>
            <div className="flex gap-1">
              {SORT_OPTIONS.map(o => (
                <button
                  key={o.value}
                  onClick={() => setSortBy(o.value)}
                  className={[
                    'px-2.5 py-1 rounded-lg border text-xs font-medium transition-all',
                    sortBy === o.value
                      ? 'bg-zinc-800 dark:bg-zinc-200 border-zinc-800 dark:border-zinc-200 text-white dark:text-zinc-900'
                      : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400',
                  ].join(' ')}
                >
                  {o.label}
                </button>
              ))}
            </div>
            {data && (
              <span className="ml-auto text-xs text-zinc-400">
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
                onPlaced={() => setPlacedCount(c => c + 1)}
                onItemAdded={onItemAdded}
              />
            ))
          )}
        </div>
      </div>
    </>
  );
}
