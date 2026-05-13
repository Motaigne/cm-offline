'use client';

import { useState, useEffect, useTransition, useMemo } from 'react';
import { getRotationsForMonth, type RotationSignature, type RotationInstance } from '@/app/actions/search';
import type { Scenario, CalendarItem } from '@/app/page';
import type { ScenarioName } from '@/app/actions/planning';
import { cacheRotations, loadRotationsFromDB } from '@/lib/local-db';
import { enqueueAdd } from '@/lib/sync-service';

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

    // Optimistic UI dans les 2 cas — sinon l'user ne voit pas le vol apparaître
    // (sur iPad PWA, le revalidatePath cascade ne re-render pas toujours) et
    // retry plusieurs fois → inserts en double.
    onItemAdded?.(newItem, scenario.id);

    startTransition(async () => {
      await enqueueAdd(newItem, scenario.id);
      setSelectedInst(null);
      onPlaced();
    });
  }

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3 space-y-2.5">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
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

      {/* Scenario selector — affiché seulement si pas de présélection ou si chevauchement */}
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

// ─── ResultList ────────────────────────────────────────────────────────────────

function ResultList({
  loading,
  sigs,
  scenarios,
  preselectedScenario,
  onPlaced,
  onItemAdded,
}: {
  loading: boolean;
  sigs: RotationSignature[];
  scenarios: Scenario[];
  preselectedScenario?: ScenarioName;
  onPlaced: () => void;
  onItemAdded?: (item: CalendarItem, draftId: string) => void;
}) {
  if (loading) return (
    <div className="flex items-center justify-center h-32 text-sm text-zinc-400">Chargement…</div>
  );
  if (sigs.length === 0) return (
    <div className="flex items-center justify-center h-32 text-sm text-zinc-400">Aucune rotation correspondante.</div>
  );
  return (
    <>
      {sigs.map(sig => (
        <RotationCard key={sig.id} sig={sig} scenarios={scenarios} preselectedScenario={preselectedScenario} onPlaced={onPlaced} onItemAdded={onItemAdded} />
      ))}
    </>
  );
}

// ─── SimpleTab ─────────────────────────────────────────────────────────────────

function SimpleTab({
  data,
  loading,
  scenarios,
  preselectedScenario,
  onPlaced,
  onItemAdded,
}: {
  data: RotationSignature[] | null;
  loading: boolean;
  scenarios: Scenario[];
  preselectedScenario?: ScenarioName;
  onPlaced: () => void;
  onItemAdded?: (item: CalendarItem, draftId: string) => void;
}) {
  const [query, setQuery]       = useState('');
  const [families, setFamilies] = useState<string[]>([]);
  const [onExact, setOnExact]   = useState<number | null>(null);
  const [sortBy, setSortBy]     = useState<SortBy>('h2hc');

  function toggleFamily(label: string) {
    setFamilies(prev => prev.includes(label) ? prev.filter(f => f !== label) : [...prev, label]);
  }

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

  return (
    <>
      {/* Filters */}
      <div className="flex-shrink-0 px-4 pb-3 space-y-2.5 border-b border-zinc-200 dark:border-zinc-800">
        <input
          type="search"
          placeholder="Destination (ex : LAX, HND, SCL…)"
          value={query}
          onChange={e => setQuery(e.target.value)}
          className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-4 py-3 text-base placeholder-zinc-400 outline-none focus:border-blue-400"
        />

        {/* Aircraft families */}
        <div className="flex flex-wrap gap-2">
          {AIRCRAFT_FAMILIES.map(f => (
            <button
              key={f.label}
              onClick={() => toggleFamily(f.label)}
              className={[
                'px-3.5 py-2 rounded-full border text-sm transition-all min-h-[44px]',
                families.includes(f.label)
                  ? 'bg-blue-500 border-blue-500 text-white font-medium'
                  : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400',
              ].join(' ')}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* ON exact */}
        <div className="flex flex-wrap gap-1.5">
          {ON_VALUES.map(n => (
            <button
              key={n}
              onClick={() => setOnExact(v => v === n ? null : n)}
              className={[
                'px-2.5 py-1.5 rounded-full border text-xs font-mono transition-all min-h-[36px]',
                onExact === n
                  ? 'bg-zinc-800 dark:bg-zinc-200 border-zinc-800 dark:border-zinc-200 text-white dark:text-zinc-900 font-semibold'
                  : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400',
              ].join(' ')}
            >
              {n}ON
            </button>
          ))}
        </div>

        {/* Sort */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-400 flex-shrink-0">Trier par</span>
          <div className="flex gap-1.5">
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
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>
        <ResultList loading={loading} sigs={filtered} scenarios={scenarios} preselectedScenario={preselectedScenario} onPlaced={onPlaced} onItemAdded={onItemAdded} />
      </div>
    </>
  );
}

// ─── ValTab ────────────────────────────────────────────────────────────────────

type Range = { min: string; max: string };
const emptyRange = (): Range => ({ min: '', max: '' });

function RangeField({
  label,
  unit,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  value: Range;
  onChange: (r: Range) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300 w-20 flex-shrink-0">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        placeholder="min"
        value={value.min}
        onChange={e => onChange({ ...value, min: e.target.value })}
        className="w-20 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-2 py-2.5 text-sm text-center"
      />
      <span className="text-xs text-zinc-400">–</span>
      <input
        type="number"
        inputMode="decimal"
        placeholder="max"
        value={value.max}
        onChange={e => onChange({ ...value, max: e.target.value })}
        className="w-20 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-2 py-2.5 text-sm text-center"
      />
      <span className="text-xs text-zinc-400 w-8">{unit}</span>
      {(value.min || value.max) && (
        <button
          onClick={() => onChange(emptyRange())}
          className="text-xs text-zinc-400 hover:text-zinc-600 px-2 py-1"
        >
          ✕
        </button>
      )}
    </div>
  );
}

function ValTab({
  data,
  loading,
  scenarios,
  preselectedScenario,
  onPlaced,
  onItemAdded,
}: {
  data: RotationSignature[] | null;
  loading: boolean;
  scenarios: Scenario[];
  preselectedScenario?: ScenarioName;
  onPlaced: () => void;
  onItemAdded?: (item: CalendarItem, draftId: string) => void;
}) {
  const [hcRange,  setHcRange]  = useState<Range>(emptyRange());
  const [hdvRange, setHdvRange] = useState<Range>(emptyRange());
  const [onRange,  setOnRange]  = useState<Range>(emptyRange());
  const [legRange, setLegRange] = useState<Range>(emptyRange());

  function inRange(val: number, r: Range): boolean {
    const lo = r.min !== '' ? parseFloat(r.min) : -Infinity;
    const hi = r.max !== '' ? parseFloat(r.max) : Infinity;
    return val >= lo && val <= hi;
  }

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.filter(s =>
      inRange(s.hc, hcRange) &&
      inRange(s.hdv, hdvRange) &&
      inRange(s.nb_on_days, onRange) &&
      inRange(s.legs_number, legRange)
    );
  }, [data, hcRange, hdvRange, onRange, legRange]);

  function resetAll() {
    setHcRange(emptyRange());
    setHdvRange(emptyRange());
    setOnRange(emptyRange());
    setLegRange(emptyRange());
  }

  const hasFilters = [hcRange, hdvRange, onRange, legRange].some(r => r.min || r.max);

  return (
    <>
      {/* Filters */}
      <div className="flex-shrink-0 px-4 pb-3 space-y-3 border-b border-zinc-200 dark:border-zinc-800">
        <RangeField label="HC"        unit="h"  value={hcRange}  onChange={setHcRange} />
        <RangeField label="HDV"       unit="h"  value={hdvRange} onChange={setHdvRange} />
        <RangeField label="ON"        unit="j"  value={onRange}  onChange={setOnRange} />
        <RangeField label="Tronçons"  unit=""   value={legRange} onChange={setLegRange} />
        {hasFilters && (
          <button
            onClick={resetAll}
            className="text-xs text-zinc-400 hover:text-zinc-600 underline"
          >
            Tout réinitialiser
          </button>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>
        <ResultList loading={loading} sigs={filtered} scenarios={scenarios} preselectedScenario={preselectedScenario} onPlaced={onPlaced} onItemAdded={onItemAdded} />
      </div>
    </>
  );
}

// ─── SearchPanel ───────────────────────────────────────────────────────────────

type Tab = 'simple' | 'val';

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
  const [data, setData]             = useState<RotationSignature[] | null>(null);
  const [loading, setLoading]       = useState(true);
  const [fromCache, setFromCache]   = useState(false);
  const [tab, setTab]               = useState<Tab>('simple');
  const [placedCount, setPlacedCount] = useState(0);

  useEffect(() => {
    setLoading(true);
    setFromCache(false);
    getRotationsForMonth(month)
      .then(d => {
        setData(d);
        setLoading(false);
        cacheRotations(d, month); // cache en arrière-plan
      })
      .catch(async () => {
        // Offline : charger depuis IndexedDB
        const cached = await loadRotationsFromDB(month);
        setData(cached);
        setFromCache(true);
        setLoading(false);
      });
  }, [month]);

  function handlePlaced() {
    setPlacedCount(c => c + 1);
  }

  const totalInstances = data?.reduce((a, s) => a + s.instances.length, 0) ?? 0;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-30 bg-black/20" onClick={onClose} />

      {/* Panel — si panelTop défini : s'étend de la ligne choisie jusqu'en bas */}
      <div
        className="fixed left-0 right-0 z-40 bg-white dark:bg-zinc-950 rounded-t-2xl shadow-2xl flex flex-col"
        style={panelTop !== undefined
          ? { top: panelTop, bottom: 0 }
          : { bottom: 0, height: '70vh' }}
      >
        {/* Header */}
        <div className="flex-shrink-0 px-5 pt-4 pb-0">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="font-semibold text-sm">
                Rotations · <span className="text-zinc-400 font-normal">{month}</span>
                {preselectedScenario && (
                  <span className="ml-2 px-2 py-0.5 rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-xs font-bold">→ {preselectedScenario}</span>
                )}
              </h2>
              {data && (
                <p className="text-xs text-zinc-400 mt-0.5">
                  {data.length} type{data.length !== 1 ? 's' : ''} · {totalInstances} date{totalInstances !== 1 ? 's' : ''}
                  {placedCount > 0 && ` · ${placedCount} placé${placedCount !== 1 ? 's' : ''}`}
                  {fromCache && <span className="ml-1 text-amber-500">· cache local</span>}
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              className="text-zinc-400 hover:text-zinc-600 w-10 h-10 flex items-center justify-center text-2xl leading-none"
            >
              ×
            </button>
          </div>

          {/* Tabs */}
          <div className="flex gap-0 border-b border-zinc-200 dark:border-zinc-800">
            {([['simple', 'Rech. simple'], ['val', 'Valorisations']] as [Tab, string][]).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={[
                  'px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
                  tab === id
                    ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Tab content */}
        <div className="flex-1 flex flex-col overflow-hidden pt-3">
          {tab === 'simple' ? (
            <SimpleTab data={data} loading={loading} scenarios={scenarios} preselectedScenario={preselectedScenario} onPlaced={handlePlaced} onItemAdded={onItemAdded} />
          ) : (
            <ValTab data={data} loading={loading} scenarios={scenarios} preselectedScenario={preselectedScenario} onPlaced={handlePlaced} onItemAdded={onItemAdded} />
          )}
        </div>
      </div>
    </>
  );
}
