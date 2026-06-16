'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { NavBar } from '@/app/components/nav';
import { Ep4HoraireEP4Consolidee, Ep4DecompteEP4Consolidee, Ep4FraisEP4Consolidee } from '@/app/components/ep4-tables';
import { getEp4ForMonth, type Ep4MonthResponse } from '@/app/actions/ep4';
import { loadEp4ForMonthLocal } from '@/lib/ep4-local';

type ScenarioName = 'A' | 'B' | 'C';
type ViewName = 'horaire' | 'decompte' | 'frais';

const SCENARIOS: ScenarioName[] = ['A', 'B', 'C'];
const VIEWS: { id: ViewName; label: string }[] = [
  { id: 'horaire',  label: 'Feuille Horaire'      },
  { id: 'decompte', label: 'Feuille Décompte'     },
  { id: 'frais',    label: 'Frais de Déplacement' },
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

    setLoading(true); setError(null); setData(null);
    window.history.replaceState(null, '', `/ep4?m=${m}`);
    localStorage.setItem('cm-selected-month', m);

    let localOk = false;
    const applyData = (res: Ep4MonthResponse) => {
      if (cancelled) return;
      setData(res);
      const first = res.scenarios.find(s => s.flights.length > 0);
      if (first) setScenario(first.name);
    };

    // 1. Lecture Dexie d'abord (raw_detail + taux_app pré-cachés au sync).
    //    Si OK → on affiche tout de suite, l'UI ne dépend pas du réseau.
    //    Note : on reset setError(null) ici aussi car le path offline ci-dessous
    //    a pu déjà setError('offline') si la queueMicrotask a tiré avant la
    //    résolution Dexie (race typique async IDB > microtask).
    void loadEp4ForMonthLocal(m).then(local => {
      if (cancelled || !local) return;
      localOk = true;
      applyData(local);
      setError(null);
      setLoading(false);
    }).catch(() => { /* on tombera dans le path serveur ci-dessous */ });

    // 2. Refresh background depuis le serveur (timeout 10s pour rester réactif
    //    sur captif/SIM — sinon l'auto-fetch peut hanger). Si offline et pas de
    //    cache → on affiche le message offline en fin de tick.
    if (!navigator.onLine) {
      // Laisse au .then() Dexie une frame pour résoudre avant d'afficher l'offline.
      queueMicrotask(() => {
        if (cancelled) return;
        if (!localOk) { setError('offline'); setLoading(false); }
      });
      return;
    }
    Promise.race([
      getEp4ForMonth(m),
      new Promise<{ error: string }>(r => setTimeout(() => r({ error: 'timeout' }), 10_000)),
    ])
      .then(res => {
        if (cancelled) return;
        if ('error' in res) {
          if (!localOk) setError(res.error === 'timeout' ? 'offline' : res.error);
          return;
        }
        applyData(res);
        setError(null);
      })
      .catch(e => {
        if (cancelled) return;
        if (localOk) return;
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

      <header className="print:hidden flex flex-wrap items-center gap-3 px-4 h-14 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex-shrink-0">
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
                disabled={loading}
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

        {/* Bouton export PDF — affiché uniquement si on a des données */}
        {data && scenarioFlights.length > 0 && (
          <button
            onClick={() => window.print()}
            className="ml-auto flex items-center gap-1.5 px-3 h-7 rounded bg-zinc-800 dark:bg-zinc-100 text-white dark:text-zinc-900 text-xs font-medium hover:bg-zinc-700 dark:hover:bg-zinc-300 transition-colors"
            title="Imprimer / sauvegarder les 3 feuilles en PDF (iPad : 'Imprimer' → 'Enregistrer dans Fichiers')"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 6 2 18 2 18 9" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <rect x="6" y="14" width="12" height="8" />
            </svg>
            PDF
          </button>
        )}
        <span className={`text-xs text-zinc-400 ${data && scenarioFlights.length > 0 ? '' : 'ml-auto'}`}>
          {loading ? 'Chargement…' : error ? 'Erreur' : ''}
        </span>
      </header>

      {/* Vue impression : les 3 tableaux à la suite (Horaire → Décompte → Frais),
          uniquement visible via window.print(). Saut de page entre tableaux. */}
      {data && scenarioFlights.length > 0 && (
        <div className="hidden print:block p-2">
          <h1 className="text-base font-bold mb-2">
            EP4 — Scénario {scenario} · {MONTH_FR[mo - 1]} {y}
          </h1>
          <section className="break-after-page">
            <h2 className="text-sm font-semibold mb-2 mt-2">Feuille Horaire</h2>
            <Ep4HoraireEP4Consolidee flights={scenarioFlights} year={y} month={mo} />
          </section>
          <section className="break-after-page">
            <h2 className="text-sm font-semibold mb-2 mt-2">Feuille Décompte</h2>
            <Ep4DecompteEP4Consolidee flights={scenarioFlights} year={y} month={mo} />
          </section>
          <section>
            <h2 className="text-sm font-semibold mb-2 mt-2">Frais de Déplacement</h2>
            <Ep4FraisEP4Consolidee flights={scenarioFlights} />
          </section>
        </div>
      )}

      <main className="print:hidden flex-1 p-4 max-w-[1400px] w-full mx-auto">
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
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 text-center space-y-1">
            <p className="text-sm text-zinc-400">
              Aucun vol EP4 sur le scénario {scenario} pour {MONTH_FR[mo - 1]} {y}.
            </p>
            <p className="text-xs text-zinc-400/70">
              Si un vol apparaît dans le calendrier, il n&apos;a pas de données EP4 liées
              (pairing_instance_id manquant — vol ajouté sans passer par la recherche catalogue).
            </p>
          </div>
        )}

        {data && scenarioFlights.length > 0 && (
          view === 'horaire' ? (
            <Ep4HoraireEP4Consolidee flights={scenarioFlights} year={y} month={mo} />
          ) : view === 'decompte' ? (
            <Ep4DecompteEP4Consolidee flights={scenarioFlights} year={y} month={mo} />
          ) : (
            <Ep4FraisEP4Consolidee flights={scenarioFlights} />
          )
        )}
      </main>
    </div>
  );
}
