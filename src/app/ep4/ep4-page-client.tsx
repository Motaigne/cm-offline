'use client';

import { useEffect, useState } from 'react';
import { NavBar } from '@/app/components/nav';
import { Ep4Tables } from '@/app/components/ep4-tables';
import { getEp4ForMonth, type Ep4MonthResponse } from '@/app/actions/ep4';

const MONTH_FR = ['Janvier','Février','Mars','Avril','Mai','Juin',
                  'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

function shiftMonth(m: string, delta: number): string {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function Ep4PageClient({ month: initialMonth }: { month: string }) {
  const [month, setMonth]     = useState(initialMonth);
  const [data, setData]       = useState<Ep4MonthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  // Restaure le dernier mois sélectionné dans le calendrier au premier mount
  useEffect(() => {
    const stored = localStorage.getItem('cm-selected-month');
    if (stored && stored !== initialMonth) setMonth(stored);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setData(null);
    window.history.replaceState(null, '', `/ep4?m=${month}`);
    localStorage.setItem('cm-selected-month', month);
    getEp4ForMonth(month)
      .then(res => {
        if (cancelled) return;
        if ('error' in res) { setError(res.error); return; }
        setData(res);
      })
      .catch(e => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [month]);

  const [y, mo] = month.split('-').map(Number);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <NavBar />

      <header className="flex items-center justify-between px-4 h-14 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex-shrink-0">
        <span className="font-semibold text-sm tracking-tight">EP4 — Feuilles d&apos;activité</span>
        <div className="flex items-center gap-2">
          <button onClick={() => setMonth(shiftMonth(month, -1))}
            className="w-8 h-8 flex items-center justify-center rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-2xl">‹</button>
          <span className="text-sm font-semibold w-36 text-center">{MONTH_FR[mo - 1]} {y}</span>
          <button onClick={() => setMonth(shiftMonth(month, 1))}
            className="w-8 h-8 flex items-center justify-center rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-2xl">›</button>
        </div>
        <div className="text-xs text-zinc-400">
          {loading ? 'Chargement…' : error ? 'Erreur' : ''}
        </div>
      </header>

      <main className="flex-1 p-4 space-y-6 max-w-[1400px] w-full mx-auto">
        {error && (
          <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-xl p-4 text-sm text-red-700 dark:text-red-400">
            Erreur EP4 : {error}
          </div>
        )}

        {data && data.scenarios.every(s => s.flights.length === 0) && (
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 text-center text-sm text-zinc-400">
            Aucun vol planifié sur les scénarios A, B, C pour {MONTH_FR[mo - 1]} {y}.
          </div>
        )}

        {data && data.scenarios.map(scenario => (
          scenario.flights.length === 0 ? null : (
            <section key={scenario.name} className="space-y-4">
              <h2 className="text-2xl font-bold text-zinc-800 dark:text-zinc-100 px-1">
                Scénario {scenario.name}
                <span className="text-xs font-normal text-zinc-400 ml-3">
                  {scenario.flights.length} vol{scenario.flights.length > 1 ? 's' : ''}
                </span>
              </h2>

              {scenario.flights.map(flight => (
                <div key={flight.flight_item_id} className="space-y-2 pl-3 border-l-2 border-zinc-200 dark:border-zinc-700">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-semibold text-zinc-700 dark:text-zinc-200">
                      {flight.ep4.rotation_code || '—'}
                    </span>
                    <span className="text-zinc-400 font-mono text-xs">
                      {flight.start_date} → {flight.end_date}
                    </span>
                    {flight.is_spillover && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-amber-100 dark:bg-amber-950/50 text-amber-600 dark:text-amber-400">
                        À cheval (mois précédent)
                      </span>
                    )}
                  </div>
                  <Ep4Tables ep4={flight.ep4} year={y} month={mo} />
                </div>
              ))}
            </section>
          )
        ))}
      </main>
    </div>
  );
}
