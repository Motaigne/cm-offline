'use client';

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { NavBar } from '@/app/components/nav';
import { Ep4HoraireEP4Consolidee, Ep4DecompteEP4Consolidee, Ep4FraisEP4Consolidee } from '@/app/components/ep4-tables';
import { getEp4ForMonth, type Ep4MonthResponse } from '@/app/actions/ep4';
import { loadEp4ForMonthLocal } from '@/lib/ep4-local';
import {
  Ep4ImportView, type Ep4ImportSummary,
  Ep4ImportHorairePanel, Ep4ImportActivitePanel, Ep4ImportFraisPanel,
} from './ep4-import-view';
import { computeEp4Diff } from '@/lib/ep4-diff';
import {
  saveEp4Import, loadEp4Import, listEp4Imports, deleteEp4Import,
  type StoredEp4Import,
} from '@/lib/local-db';
import type { Ep4PdfData } from '@/lib/ep4-pdf-parse';

type ScenarioName = 'A' | 'B' | 'C';
type ViewName = 'horaire' | 'decompte' | 'frais' | 'import';

const SCENARIOS: ScenarioName[] = ['A', 'B', 'C'];
const VIEWS: { id: ViewName; label: string }[] = [
  { id: 'horaire',  label: 'Feuille Horaire'      },
  { id: 'decompte', label: 'Feuille Décompte'     },
  { id: 'frais',    label: 'Frais de Déplacement' },
  { id: 'import',   label: 'Import PDF'           },
];

const MONTH_FR = ['Janvier','Février','Mars','Avril','Mai','Juin',
                  'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

/** Clé localStorage du PDF EP4 (V1 historique, un seul slot). Migré vers
 *  Dexie au boot puis supprimé. Voir importMigrationDone ci-dessous. */
const EP4_IMPORT_LS_KEY = 'cm-ep4-pdf-import';

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
  // Liste résumée des EP4 importés (un par mois). Source de vérité = Dexie.
  const [imports, setImports] = useState<Ep4ImportSummary[]>([]);
  // Mois actuellement affiché dans la vue Import. Garde la sélection entre
  // les switches de vue (refresh ré-hydrate via le useEffect ci-dessous).
  const [selectedImportMonth, setSelectedImportMonth] = useState<string | null>(null);
  const [currentImport, setCurrentImport] = useState<StoredEp4Import | null>(null);

  // Hydrate la liste depuis Dexie + migre le V1 (slot localStorage) si présent.
  useEffect(() => {
    void (async () => {
      // V1 → V2 migration : un seul slot localStorage avec un Ep4ImportState
      // qui contenait { data: Ep4PdfData }. On le rejoue dans Dexie sous le
      // monthIso extrait du parser, puis on clean le localStorage.
      if (typeof window !== 'undefined') {
        const raw = localStorage.getItem(EP4_IMPORT_LS_KEY);
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as { data?: Ep4PdfData; fileName?: string };
            const monthIso = parsed.data?.meta?.monthIso ?? null;
            if (monthIso && parsed.data) {
              await saveEp4Import(monthIso, parsed.fileName ?? '(legacy)', parsed.data);
            }
          } catch { /* JSON corrompu : ignore */ }
          localStorage.removeItem(EP4_IMPORT_LS_KEY);
        }
      }
      const list = await listEp4Imports();
      setImports(list);
    })();
  }, []);

  // Aligne le mois sélectionné (= EP4 PDF affiché dans Import PDF + dans les
  // onglets Horaire/Décompte/Frais) sur le mois de navigation. Sans ça, naviguer
  // ‹ › ne mettait pas à jour le PDF affiché → le diff ne marchait que pour le
  // mois auto-sélectionné au mount (le plus récent).
  useEffect(() => {
    setSelectedImportMonth(month);
  }, [month]);

  // Charge la data Dexie quand le mois sélectionné change.
  useEffect(() => {
    if (!selectedImportMonth) { setCurrentImport(null); return; }
    void loadEp4Import(selectedImportMonth).then(imp => setCurrentImport(imp));
  }, [selectedImportMonth]);

  const handleImportSuccess = useCallback(async (data: Ep4PdfData, fileName: string) => {
    const monthIso = data.meta.monthIso;
    if (!monthIso) return; // déjà validé côté view
    await saveEp4Import(monthIso, fileName, data);
    const list = await listEp4Imports();
    setImports(list);
    setSelectedImportMonth(monthIso);
    setCurrentImport(await loadEp4Import(monthIso));
  }, []);

  const handleDeleteMonth = useCallback(async (monthIso: string) => {
    await deleteEp4Import(monthIso);
    const list = await listEp4Imports();
    setImports(list);
    if (selectedImportMonth === monthIso) {
      const next = list[0]?.monthIso ?? null;
      setSelectedImportMonth(next);
      setCurrentImport(next ? await loadEp4Import(next) : null);
    }
  }, [selectedImportMonth]);

  const cancelRef = useRef<(() => void) | null>(null);

  // Sync horizontal scroll des 2 tableaux Décompte (calculé + PDF importé)
  // pour que les colonnes restent alignées quand l'utilisateur scroll
  // (~23 colonnes, déborde l'écran).
  const decompteCalcScrollRef   = useRef<HTMLDivElement>(null);
  const decompteImportScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (view !== 'decompte') return;
    const a = decompteCalcScrollRef.current;
    const b = decompteImportScrollRef.current;
    if (!a || !b) return;
    let syncing = false;
    const sync = (src: HTMLDivElement, dst: HTMLDivElement) => () => {
      if (syncing) return;
      syncing = true;
      dst.scrollLeft = src.scrollLeft;
      // Reset au prochain frame pour ne pas boucler sur le scroll event du dst.
      requestAnimationFrame(() => { syncing = false; });
    };
    const onA = sync(a, b);
    const onB = sync(b, a);
    a.addEventListener('scroll', onA, { passive: true });
    b.addEventListener('scroll', onB, { passive: true });
    return () => {
      a.removeEventListener('scroll', onA);
      b.removeEventListener('scroll', onB);
    };
  }, [view, currentImport]);

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
    //    Si Dexie a la data → on affiche immédiatement, UI ne dépend pas du
    //    réseau. Si Dexie n'a rien ET on est offline → on affiche le message
    //    "EP4 indisponible". Si Dexie rien + online → on attend le serveur.
    //    Note : pas de speculative setError('offline') AVANT que Dexie ait
    //    résolu (sinon flash visible le temps que Dexie revienne).
    void loadEp4ForMonthLocal(m).then(local => {
      if (cancelled) return;
      if (local) {
        localOk = true;
        applyData(local);
        setError(null);
        setLoading(false);
      } else if (!navigator.onLine) {
        setError('offline');
        setLoading(false);
      }
      // sinon : pas de cache + online → on laisse le path serveur ci-dessous
      // gérer (success ou error de race).
    }).catch(() => { /* path serveur ci-dessous prend le relais */ });

    // 2. Refresh background depuis le serveur si online. Timeout 10s pour
    //    rester réactif sur captif/SIM — sinon le server action hang. navigator
    //    .onLine peut être truthy même wifi/4G off (iOS), donc on essaie quand
    //    même, le timeout coupe.
    if (!navigator.onLine) return;
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

  // Diff calc ↔ PDF importé pour le mois courant. Sert de Set<key> à passer
  // aux 2 onglets Horaire/Décompte pour highlight des rows divergentes.
  // Memoizé pour éviter le recompute à chaque re-render (les inputs sont
  // référentiellement stables sauf à un sync/réimport).
  const diff = useMemo(() => {
    if (!currentImport || currentImport.monthIso !== month || scenarioFlights.length === 0) {
      return { horaireKeys: new Set<string>(), decompteKeys: new Set<string>(), fraisKeys: new Set<string>() };
    }
    return computeEp4Diff(scenarioFlights, currentImport.data);
  }, [currentImport, month, scenarioFlights]);

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
        {/* Vue Import PDF : indépendante de l'EP4 calculé (mois, scénario, etc.).
            L'utilisateur peut comparer avec son EP4 papier sans avoir le calcul
            côté app pour le mois en question. */}
        {view === 'import' ? (
          <Ep4ImportView
            imports={imports}
            selectedMonth={selectedImportMonth}
            currentImport={currentImport}
            onSelectMonth={setSelectedImportMonth}
            onImportSuccess={handleImportSuccess}
            onDeleteMonth={handleDeleteMonth}
          />
        ) : (
          <>
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
                <>
                  <Ep4HoraireEP4Consolidee
                    flights={scenarioFlights} year={y} month={mo}
                    highlightedKeys={diff.horaireKeys}
                  />
                  {currentImport?.monthIso === month && (
                    <div className="mt-4">
                      <p className="text-[10px] uppercase tracking-wide font-semibold text-zinc-400 mb-2">
                        Issue de l&apos;EP4 importé ({currentImport.fileName})
                      </p>
                      <Ep4ImportHorairePanel
                        rows={currentImport.data.horaire.rows}
                        highlightedKeys={diff.horaireKeys}
                      />
                    </div>
                  )}
                </>
              ) : view === 'decompte' ? (
                <>
                  <Ep4DecompteEP4Consolidee
                    flights={scenarioFlights} year={y} month={mo}
                    highlightedKeys={diff.decompteKeys}
                    scrollRef={decompteCalcScrollRef}
                  />
                  {currentImport?.monthIso === month && (
                    <div className="mt-4">
                      <p className="text-[10px] uppercase tracking-wide font-semibold text-zinc-400 mb-2">
                        Issue de l&apos;EP4 importé ({currentImport.fileName})
                      </p>
                      <Ep4ImportActivitePanel
                        rows={currentImport.data.activite.rows}
                        totaux={currentImport.data.activite.totaux}
                        summary={currentImport.data.activite.summary}
                        highlightedKeys={diff.decompteKeys}
                        scrollRef={decompteImportScrollRef}
                      />
                    </div>
                  )}
                </>
              ) : (
                <>
                  <Ep4FraisEP4Consolidee
                    flights={scenarioFlights}
                    highlightedKeys={diff.fraisKeys}
                  />
                  {currentImport?.monthIso === month && (
                    <div className="mt-4">
                      <p className="text-[10px] uppercase tracking-wide font-semibold text-zinc-400 mb-2">
                        Issue de l&apos;EP4 importé ({currentImport.fileName})
                      </p>
                      <Ep4ImportFraisPanel
                        rows={currentImport.data.frais.rows}
                        totaux={currentImport.data.frais.totaux}
                        highlightedKeys={diff.fraisKeys}
                      />
                    </div>
                  )}
                </>
              )
            )}
          </>
        )}
      </main>
    </div>
  );
}
