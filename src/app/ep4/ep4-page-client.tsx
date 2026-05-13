'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { NavBar } from '@/app/components/nav';
import { Ep4HoraireConsolidee, Ep4DecompteConsolidee, Ep4FraisDeplacementConsolidee } from '@/app/components/ep4-tables';
import { getEp4ForMonth, type Ep4MonthResponse } from '@/app/actions/ep4';

type ScenarioName = 'A' | 'B' | 'C';
type ViewName = 'horaire' | 'decompte' | 'frais';

const SCENARIOS: ScenarioName[] = ['A', 'B', 'C'];
const VIEWS: { id: ViewName; label: string }[] = [
  { id: 'horaire',  label: 'Feuille Horaire'   },
  { id: 'decompte', label: 'Feuille Décompte'  },
  { id: 'frais',    label: 'Frais Déplacement' },
];

const MONTH_FR = ['Janvier','Février','Mars','Avril','Mai','Juin',
                  'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

function shiftMonth(m: string, delta: number): string {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function Ep4PageClient({ month: initialMonth }: { month: string }) {
  const [month, setMonth]       = useState(initialMonth);
  const [data, setData]         = useState<Ep4MonthResponse | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [scenario, setScenario] = useState<ScenarioName>('A');
  const [view, setView]         = useState<ViewName>('horaire');
  const cancelRef = useRef<(() => void) | null>(null);

  const loadMonth = useCallback((m: string) => {
    cancelRef.current?.();
    let cancelled = false;
    cancelRef.current = () => { cancelled = true; };

    if (!navigator.onLine) {
      setError('offline'); setLoading(false); setData(null);
      return;
    }
    setLoading(true); setError(null); setData(null);
    window.history.replaceState(null, '', `/ep4?m=${m}`);
    localStorage.setItem('cm-selected-month', m);

    getEp4ForMonth(m)
      .then(res => {
        if (cancelled) return;
        if ('error' in res) { setError(res.error); return; }
        setData(res);
        const first = res.scenarios.find(s => s.flights.length > 0);
        if (first) setScenario(first.name);
      })
      .catch(e => {
        if (cancelled) return;
        if (e instanceof TypeError) setError('offline');
        else setError(String(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
  }, []);

  // Lecture localStorage au premier mount, puis déclenche le chargement
  useEffect(() => {
    const stored = localStorage.getItem('cm-selected-month');
    const m = stored && /^\d{4}-\d{2}$/.test(stored) ? stored : initialMonth;
    if (m !== month) setMonth(m); // [month] effect prendra le relais
    else loadMonth(m);            // sinon charger directement
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Chargement à chaque changement de mois (navigation ‹/›)
  useEffect(() => {
    loadMonth(month);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  const [y, mo] = month.split('-').map(Number);

  const scenarioFlights = data?.scenarios.find(s => s.name === scenario)?.flights ?? [];
  const flightCountByScenario = (name: ScenarioName) =>
    data?.scenarios.find(s => s.name === name)?.flights.length ?? 0;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <NavBar />

      <header className="flex flex-wrap items-center gap-3 px-4 h-14 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex-shrink-0">
        {/* Mois */}
        <div className="flex items-center gap-1">
          <button onClick={() => setMonth(shiftMonth(month, -1))}
            className="w-8 h-8 flex items-center justify-center rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-2xl">‹</button>
          <span className="text-sm font-semibold w-36 text-center">{MONTH_FR[mo - 1]} {y}</span>
          <button onClick={() => setMonth(shiftMonth(month, 1))}
            className="w-8 h-8 flex items-center justify-center rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-2xl">›</button>
        </div>

        {/* Scénario A / B / C */}
        <div className="flex items-center gap-1 border-l border-zinc-200 dark:border-zinc-700 pl-3">
          {SCENARIOS.map(s => {
            const count = flightCountByScenario(s);
            const active = scenario === s;
            return (
              <button
                key={s}
                onClick={() => setScenario(s)}
                disabled={data !== null && count === 0}
                className={`px-3 h-7 rounded text-sm font-bold transition-colors disabled:opacity-30 ${
                  active
                    ? 'bg-zinc-800 dark:bg-zinc-100 text-white dark:text-zinc-900'
                    : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
              >
                {s}
                {data && count > 0 && (
                  <span className="ml-1 text-[10px] font-normal opacity-60">{count}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Vue */}
        <div className="flex items-center gap-1 border-l border-zinc-200 dark:border-zinc-700 pl-3">
          {VIEWS.map(v => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              className={`px-3 h-7 rounded text-xs font-medium transition-colors ${
                view === v.id
                  ? 'bg-blue-600 text-white'
                  : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>

        <span className="ml-auto text-xs text-zinc-400">
          {loading ? 'Chargement…' : error ? 'Erreur' : ''}
        </span>
      </header>

      <main className="flex-1 p-4 max-w-[1400px] w-full mx-auto">
        {loading && (
          <div className="flex items-center justify-center gap-3 py-16 text-zinc-400">
            <span className="animate-spin text-xl">⟳</span>
            <span className="text-sm">Calcul EP4 en cours…</span>
          </div>
        )}
        {error === 'offline' ? (
          <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl p-4 text-sm text-amber-700 dark:text-amber-400">
            <p className="font-semibold">📵 EP4 indisponible hors ligne</p>
            <p className="text-xs mt-1 opacity-80">
              Cette page nécessite une connexion (calculs EP4 server-side via raw_detail).
              Repasse en ligne ou attends d&apos;être connecté pour voir les feuilles d&apos;activité.
            </p>
          </div>
        ) : error ? (
          <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-xl p-4 text-sm text-red-700 dark:text-red-400">
            Erreur EP4 : {error}
          </div>
        ) : null}

        {data && scenarioFlights.length === 0 && !error && (
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 text-center text-sm text-zinc-400">
            Aucun vol planifié sur le scénario {scenario} pour {MONTH_FR[mo - 1]} {y}.
          </div>
        )}

        {data && scenarioFlights.length > 0 && (
          view === 'horaire' ? (
            <Ep4HoraireConsolidee flights={scenarioFlights} year={y} month={mo} />
          ) : view === 'decompte' ? (
            <Ep4DecompteConsolidee flights={scenarioFlights} year={y} month={mo} />
          ) : (
            <Ep4FraisDeplacementConsolidee flights={scenarioFlights} />
          )
        )}
      </main>
    </div>
  );
}
