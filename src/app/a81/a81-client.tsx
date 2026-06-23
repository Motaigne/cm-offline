'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, useEffect } from 'react';
import type { A81YearData, A81Row } from '@/app/actions/a81';
import { loadAllA81Overrides } from '@/app/actions/a81';
import { computeA81ForYearLocal } from '@/lib/a81-local';
import { loadA81OverridesLocal, cacheA81Overrides } from '@/lib/local-db';
import { enqueueA81UpsertOverride, enqueueA81Delete, enqueueA81Restore, enqueueA81SavePlafondExo, syncNow } from '@/lib/sync-service';

// Cache module-level pour survivre aux remounts (notamment quand Next.js
// re-fetch la page en passant online → A81Client se ré-instancie avec
// localData=null → flicker vers initialData stale). En gardant le dernier
// local compute ici, la 1ère render après remount affiche déjà la bonne valeur.
const a81LocalCache = new Map<number, A81YearData>();

const MONTHS_FR_SHORT = ['Janv.', 'Févr.', 'Mars', 'Avril', 'Mai', 'Juin', 'Juil.', 'Août', 'Sept.', 'Oct.', 'Nov.', 'Déc.'];

function fmtDate(iso: string): string {
  if (!iso || iso.length < 10) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

function fmtDateTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const yyyy = d.getUTCFullYear();
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(d.getUTCDate()).padStart(2, '0');
  const hCent = d.getUTCHours() + d.getUTCMinutes() / 60;
  return `${dd}/${mm}/${yyyy} ${hCent.toFixed(2)}`;
}

/** ISO UTC → 'YYYY-MM-DDTHH:MM' pour <input type="datetime-local"> (en UTC). */
function isoToInputLocal(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const yyyy = d.getUTCFullYear();
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(d.getUTCDate()).padStart(2, '0');
  const hh   = String(d.getUTCHours()).padStart(2, '0');
  const mi   = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

/** 'YYYY-MM-DDTHH:MM' (interprété UTC) → ISO. */
function inputLocalToIso(s: string): string {
  if (!s) return '';
  return new Date(s + ':00Z').toISOString();
}

function fmtEur(n: number): string {
  return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTaux(t: number | null): string {
  if (t == null) return '—';
  return `${Math.round(t * 100)} %`;
}

/** Vrai si `h` (temps de séjour en heures) est à ±15 min d'un palier 12 h à
 *  partir de 24 h (24, 36, 48, 60, 72…). Sert au soulignement de la cellule
 *  TPS SEJOUR pour repérer les rotations « limites » côté `nb_jours` (tSej24
 *  arrondi au 0.5 supérieur — un déplacement de quelques minutes peut faire
 *  basculer dans le palier suivant). */
function isNearSejourBoundary(h: number): boolean {
  if (h < 23.75) return false;
  const nearest = Math.round((h - 24) / 12) * 12 + 24;
  return nearest >= 24 && Math.abs(h - nearest) <= 0.25;
}

/** Cellule datetime éditable avec affichage italique=origine / gras=modifié + petit-italique-origine dessous. */
function EditableDateTimeCell({
  iso, originIso, overridden, onSave,
}: {
  iso: string;
  originIso: string;
  overridden: boolean;
  onSave: (newIso: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(isoToInputLocal(iso));

  function start() { setVal(isoToInputLocal(iso)); setEditing(true); }
  function cancel() { setEditing(false); }
  function save() {
    const newIso = inputLocalToIso(val);
    if (newIso === iso) { setEditing(false); return; }
    onSave(newIso);
    setEditing(false);
  }
  function reset() { onSave(null); setEditing(false); }

  if (editing) {
    return (
      <div className="flex flex-col gap-2">
        <input
          type="datetime-local"
          value={val}
          onChange={e => setVal(e.target.value)}
          className="text-xs font-mono px-2 py-1.5 rounded border border-blue-300 dark:border-blue-700 bg-white dark:bg-zinc-900"
          autoFocus
        />
        <div className="flex gap-1.5 text-xs">
          <button
            onClick={save}
            className="px-3 py-1.5 rounded bg-blue-600 text-white font-semibold hover:bg-blue-700 active:bg-blue-800 min-w-[44px]"
          >OK</button>
          <button
            onClick={cancel}
            className="px-3 py-1.5 rounded bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-300 dark:hover:bg-zinc-600 min-w-[44px]"
            title="Annuler"
          >×</button>
          {overridden && (
            <button
              onClick={reset}
              className="px-3 py-1.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-900/60 min-w-[44px]"
              title="Restaurer la valeur d'origine"
            >↺ init</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={start}
      className="text-left w-full font-mono cursor-text hover:bg-blue-50 dark:hover:bg-blue-900/20 px-1 rounded"
      title="Cliquer pour modifier"
    >
      {overridden ? (
        <>
          <span className="font-bold text-zinc-800 dark:text-zinc-100 not-italic">{fmtDateTime(iso)}</span>
          <span className="block text-[9px] italic text-zinc-400">{fmtDateTime(originIso)}</span>
        </>
      ) : (
        <span className="italic text-zinc-700 dark:text-zinc-200">{fmtDateTime(iso)}</span>
      )}
    </button>
  );
}

export function A81Client({
  data: initialData, availableYears, currentYear,
}: {
  data: A81YearData;
  availableYears: number[];
  currentYear: number;
}) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [err, setErr] = useState('');

  // Compute local depuis Dexie au mount + après mutations. Fallback aux data
  // serveur si Dexie vide (1ère visite, jamais Sync) ou cache incomplet.
  // Init synchrone depuis le cache module-level pour éviter le flicker au remount.
  const [localData, setLocalData] = useState<A81YearData | null>(
    () => a81LocalCache.get(currentYear) ?? null,
  );
  const data = localData ?? initialData;

  async function recomputeLocal() {
    try {
      // Resync silencieux depuis le serveur si online — cacheA81Overrides
      // préserve les ops pending et n'écrasera pas les modifs offline non sync.
      if (typeof navigator !== 'undefined' && navigator.onLine) {
        try {
          const serverOverrides = await loadAllA81Overrides();
          await cacheA81Overrides(serverOverrides);
        } catch { /* erreur réseau → on continue avec Dexie */ }
      }
      // Toujours lire Dexie : = état mergé (serveur + pending optimistic).
      const overrides = await loadA81OverridesLocal();
      // Passe initialData en fallback : si Dexie n'a pas les rotations cachées
      // (mois jamais sync'd) on hérite des rows serveur ET on y applique les
      // overrides locaux, pour que les édits (debut/fin séjour) re-calculent
      // taux + nb_jours + montant immédiatement, sans attendre router.refresh.
      const local = await computeA81ForYearLocal(currentYear, overrides, initialData);
      a81LocalCache.set(currentYear, local);
      setLocalData(local);
    } catch {
      // Erreur lecture Dexie → on garde initialData
    }
  }

  useEffect(() => { void recomputeLocal(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentYear]);

  // Cartouches restaurées localement — pour cacher instantanément sans attendre
  // que revalidatePath/router.refresh propage côté serveur.
  const [restoredIds, setRestoredIds] = useState<Set<string>>(new Set());
  // Reset quand on change d'année (= props sont d'un autre dataset).
  useEffect(() => { setRestoredIds(new Set()); }, [data.year]);
  const visibleDeletedRows = data.deleted_rows.filter(r => !restoredIds.has(r.instance_id));

  const yearsToShow = availableYears.includes(currentYear)
    ? availableYears
    : [currentYear, ...availableYears].sort((a, b) => b - a);

  function changeYear(y: number) {
    router.push(`/a81?y=${y}`);
  }

  /** Tente de pousser la queue vers le serveur si online. Silencieux en cas
   *  d'échec (les ops restent en queue, badge nav reflète, sync manuel
   *  rejouera). */
  async function tryPushNow() {
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      try { await syncNow(); } catch { /* offline ou erreur — on retry au prochain Sync */ }
    }
  }

  function handleEditDebut(row: A81Row, newIso: string | null) {
    setErr('');
    start(async () => {
      await enqueueA81UpsertOverride(row.instance_id, { debut_sejour_at: newIso });
      await recomputeLocal();
      await tryPushNow();
      router.refresh();
    });
  }
  function handleEditFin(row: A81Row, newIso: string | null) {
    setErr('');
    start(async () => {
      await enqueueA81UpsertOverride(row.instance_id, { fin_sejour_at: newIso });
      await recomputeLocal();
      await tryPushNow();
      router.refresh();
    });
  }
  function handleDelete(row: A81Row) {
    const label = `${fmtDate(row.debut_rotation)} ${row.escale_debut}${row.escale_fin !== row.escale_debut ? '/' + row.escale_fin : ''}`;
    if (!confirm(`Supprimer cette ligne du tableau A81 ?\n\n${label}\n\nLa rotation reste dans le planning ; elle est juste masquée du tableau A81.`)) return;
    setErr('');
    start(async () => {
      await enqueueA81Delete(row.instance_id);
      await recomputeLocal();
      await tryPushNow();
      router.refresh();
    });
  }
  function handleRestore(instanceId: string) {
    setErr('');
    // Optimistic : cache la cartouche dès le clic.
    setRestoredIds(prev => { const n = new Set(prev); n.add(instanceId); return n; });
    start(async () => {
      await enqueueA81Restore(instanceId);
      await recomputeLocal();
      await tryPushNow();
      router.refresh();
    });
  }

  // Plafond exo brut : utilise data computed (server ou local) ; édition inline.
  const [plafondInput, setPlafondInput] = useState<string>(
    data.plafond_exo_brut != null ? String(data.plafond_exo_brut) : '',
  );
  useEffect(() => {
    setPlafondInput(data.plafond_exo_brut != null ? String(data.plafond_exo_brut) : '');
  }, [data.plafond_exo_brut]);

  function handlePlafondCommit() {
    const trimmed = plafondInput.trim();
    const parsed = trimmed === '' ? null : parseFloat(trimmed.replace(',', '.'));
    const newValue = parsed != null && !isNaN(parsed) ? parsed : null;
    if (newValue === (data.plafond_exo_brut ?? null)) return; // no-op
    setErr('');
    start(async () => {
      await enqueueA81SavePlafondExo(currentYear, newValue);
      await recomputeLocal();
      await tryPushNow();
      router.refresh();
    });
  }

  return (
    <div className="max-w-7xl mx-auto p-4 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
            Article 81 — Prime de séjour à l&apos;étranger
          </h1>
          <p className="text-xs text-zinc-400 mt-0.5">
            Rotations éligibles du planning ligne A {currentYear} · plafond annuel {data.plafond_jours} j
            {data.regime_used ? ` (régime ${data.regime_used})` : ''}.
            <span className="ml-2 text-zinc-300 dark:text-zinc-600">Clic sur Début/Fin Séjour pour éditer.</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-500">Année :</label>
          <select
            value={currentYear}
            onChange={e => changeYear(Number(e.target.value))}
            className="text-sm px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200"
          >
            {yearsToShow.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {err && <p className="text-xs text-red-500">{err}</p>}

      {data.rows.some(r => r.is_fictive) && (
        <div className="px-3 py-2 rounded-lg bg-violet-100 dark:bg-violet-900/40 border border-violet-200 dark:border-violet-800 text-xs text-violet-800 dark:text-violet-200">
          <span className="font-semibold uppercase tracking-wide">Projection</span> — certaines lignes (fond violet) sont basées sur des plannings fictifs des mois non encore déployés. Montants à titre indicatif uniquement.
        </div>
      )}

      {/* Légende — pastille à côté de "Esc. début" indique la source */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 rounded-lg bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 text-[11px] text-zinc-600 dark:text-zinc-300">
        <span className="font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Légende</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
          source EP4 (block réels)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
          source calendrier (estimation)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full bg-violet-500" />
          mois projeté
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="italic text-zinc-500">italique</span> = valeur d&apos;origine
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="font-bold not-italic text-zinc-700 dark:text-zinc-200">gras</span> = modifié manuellement
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="underline decoration-current">tps</span> à ±15 min d&apos;un palier 12 h (24/36/48/60/72…)
        </span>
      </div>

      {/* Tableau */}
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-zinc-50 dark:bg-zinc-800/60 text-zinc-400 uppercase tracking-wide">
              <tr>
                <th className="px-2 py-2 text-left font-medium whitespace-nowrap">Début Rot.</th>
                <th className="px-2 py-2 text-left font-medium whitespace-nowrap">Début Séjour</th>
                <th className="px-2 py-2 text-center font-medium">Esc. début</th>
                <th className="px-2 py-2 text-left font-medium whitespace-nowrap">Fin Séjour</th>
                <th className="px-2 py-2 text-center font-medium">Esc. fin</th>
                <th className="px-2 py-2 text-right font-medium whitespace-nowrap">Tps séjour (h)</th>
                <th className="px-2 py-2 text-right font-medium whitespace-nowrap">(1) Nb j</th>
                <th className="px-2 py-2 text-center font-medium">(2) Zone</th>
                <th className="px-2 py-2 text-right font-medium">(3) Taux</th>
                <th className="px-2 py-2 text-right font-medium whitespace-nowrap">(4) Val. jour</th>
                <th className="px-2 py-2 text-right font-medium whitespace-nowrap">(1×3×4) Montant</th>
                <th className="px-2 py-2 text-center font-medium w-6"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {data.rows.length === 0 && (
                <tr>
                  <td colSpan={12} className="px-4 py-8 text-center text-zinc-400 italic">
                    Aucune rotation éligible dans le planning ligne A pour {currentYear}.
                  </td>
                </tr>
              )}
              {data.rows.map(r => {
                  const monthIdx = Number(r.debut_rotation.slice(5, 7)) - 1;
                  const anyOverride = r.debut_sejour_overridden || r.fin_sejour_overridden;
                  const isM0 = r.split_part === 'm0';
                  const isM1 = r.split_part === 'm1';
                  // Alternance par mois (pair/impair) pour visibilité — la
                  // source (EP4/calendrier/fictif) est désormais signalée par
                  // une pastille à côté de l'escale début, pas par le fond.
                  const rowBg = monthIdx % 2 ? 'bg-zinc-200/70 dark:bg-zinc-800/60' : '';
                  // Pastille source : vert=EP4 > violet=fictif > jaune=calendrier.
                  const pastilleCls = r.source === 'ep4'
                    ? 'bg-emerald-500'
                    : r.is_fictive
                      ? 'bg-violet-500'
                      : 'bg-amber-500';
                  const pastilleTitle = r.source === 'ep4'
                    ? 'Source EP4 (block-off/block-on réels)'
                    : r.is_fictive
                      ? 'Mois projeté (planning fictif)'
                      : 'Source calendrier (estimation raw_detail)';
                  const tpsNearBoundary = !isM0 && isNearSejourBoundary(r.temps_sej_h);
                  return (
                  <tr key={`${r.instance_id}${r.split_part ?? ''}`} className={rowBg}>
                    <td className="px-2 py-1.5 whitespace-nowrap text-zinc-700 dark:text-zinc-200 italic">
                      {fmtDate(r.debut_rotation)}
                      <div className="text-[9px] text-zinc-400 leading-none">{MONTHS_FR_SHORT[monthIdx]}</div>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {isM1 ? (
                        <span
                          className="block font-mono italic text-zinc-300 dark:text-zinc-600 px-1"
                          title="Borne synthétique du début de mois (M+1 00:00)"
                        >{fmtDateTime(r.debut_sejour_at)}</span>
                      ) : (
                        <EditableDateTimeCell
                          iso={r.debut_sejour_at}
                          originIso={r.debut_sejour_at_origin}
                          overridden={r.debut_sejour_overridden}
                          onSave={iso => handleEditDebut(r, iso)}
                        />
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-center font-mono font-semibold text-zinc-700 dark:text-zinc-200 italic">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={`inline-block w-2 h-2 rounded-full ${pastilleCls}`} title={pastilleTitle} aria-label={pastilleTitle} />
                        {r.escale_debut}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {isM0 ? (
                        <span
                          className="block font-mono italic text-zinc-300 dark:text-zinc-600 px-1"
                          title="Borne synthétique de fin de mois (M 24:00)"
                        >{fmtDateTime(r.fin_sejour_at)}</span>
                      ) : (
                        <EditableDateTimeCell
                          iso={r.fin_sejour_at}
                          originIso={r.fin_sejour_at_origin}
                          overridden={r.fin_sejour_overridden}
                          onSave={iso => handleEditFin(r, iso)}
                        />
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-center font-mono font-semibold text-zinc-700 dark:text-zinc-200 italic">{r.escale_fin}</td>
                    <td className={`px-2 py-1.5 text-right font-mono ${isM0 ? 'italic text-zinc-400' : anyOverride ? 'font-bold not-italic text-zinc-800 dark:text-zinc-100' : 'italic text-zinc-700 dark:text-zinc-200'} ${tpsNearBoundary ? 'underline decoration-current underline-offset-2' : ''}`}
                        title={tpsNearBoundary ? 'À ±15 min d’un palier 12 h — un léger décalage peut faire basculer le nombre de jours' : undefined}>
                      {isM0 ? 'sur M+1' : r.temps_sej_h.toFixed(2)}
                    </td>
                    <td className={`px-2 py-1.5 text-right font-mono ${r.plafond ? 'text-amber-600 dark:text-amber-400 font-semibold' : anyOverride ? 'font-bold not-italic text-zinc-800 dark:text-zinc-100' : 'italic text-zinc-700 dark:text-zinc-200'}`}>
                      {r.plafond ? 'PLAF' : r.nb_jours.toFixed(1)}
                    </td>
                    <td className="px-2 py-1.5 text-center font-mono font-semibold text-zinc-700 dark:text-zinc-200 italic">{r.zone ?? '—'}</td>
                    <td className={`px-2 py-1.5 text-right font-mono ${anyOverride ? 'font-bold not-italic text-zinc-800 dark:text-zinc-100' : 'italic text-zinc-700 dark:text-zinc-200'}`}>
                      {fmtTaux(r.taux)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-zinc-700 dark:text-zinc-200 italic">{fmtEur(r.valeur_jour)}</td>
                    <td className={`px-2 py-1.5 text-right font-mono ${r.montant > 0
                      ? (anyOverride ? 'font-bold not-italic text-zinc-800 dark:text-zinc-100' : 'italic text-zinc-800 dark:text-zinc-100')
                      : 'italic text-zinc-400'}`}>
                      {fmtEur(r.montant)}
                    </td>
                    <td className="px-1 py-1.5 text-center">
                      {!isM1 && (
                        <button
                          onClick={() => handleDelete(r)}
                          disabled={isPending}
                          className="text-zinc-300 hover:text-red-500 dark:text-zinc-600 dark:hover:text-red-400 text-base leading-none disabled:opacity-30"
                          title="Supprimer cette ligne du tableau A81"
                        >×</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {data.rows.length > 0 && (
              <tfoot className="bg-zinc-100 dark:bg-zinc-800/80 border-t-2 border-zinc-300 dark:border-zinc-700 font-semibold">
                <tr>
                  <td colSpan={6} className="px-2 py-2 text-right text-zinc-500 uppercase tracking-wide text-[10px]">Totaux</td>
                  <td className="px-2 py-2 text-right font-mono text-zinc-800 dark:text-zinc-100">
                    {data.nb_total_jours.toFixed(1)}
                    {data.cumul_jours > data.plafond_jours && (
                      <span className="text-[9px] text-amber-600 dark:text-amber-400 ml-1">({data.cumul_jours.toFixed(1)} cumul.)</span>
                    )}
                  </td>
                  <td colSpan={3}></td>
                  <td className="px-2 py-2 text-right font-mono text-zinc-800 dark:text-zinc-100">
                    {fmtEur(data.montant_total)}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Lignes supprimées — restauration */}
      {visibleDeletedRows.length > 0 && (
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-3 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
            Lignes supprimées · {visibleDeletedRows.length}
          </p>
          <div className="flex flex-wrap gap-2">
            {visibleDeletedRows.map(d => {
              const label = `${fmtDate(d.debut_rotation)} ${d.escale_debut}${d.escale_fin !== d.escale_debut ? '/' + d.escale_fin : ''}`;
              return (
                <button
                  key={d.instance_id}
                  onClick={() => handleRestore(d.instance_id)}
                  disabled={isPending}
                  className="text-[11px] px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-40 inline-flex items-center gap-1"
                  title="Restaurer cette ligne"
                >
                  <span>↺</span>
                  <span className="font-mono">{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Footer fiscal */}
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-2 text-sm">
        {data.rows.length > 0 && (() => {
          const firstRow = data.rows[0];                          // chronologiquement la 1ère
          const lastRow  = data.rows[data.rows.length - 1];       // chronologiquement la dernière
          const sameValue = Math.abs(firstRow.valeur_jour - lastRow.valeur_jour) < 0.005;
          const fmtBreakdown = (b: NonNullable<A81Row['valeur_jour_breakdown']>): string => {
            const coef = b.isTri ? 96 : 76;
            const parts = b.isTri
              ? `tFixeTp=${fmtEur(b.fixe)} + Prime Instr.=${fmtEur(b.primeInstruction)} + ${coef}×PVEI(${b.pvei.toFixed(2)})×KSP(${b.ksp.toFixed(2)})`
              : `tFixeTp=${fmtEur(b.fixe)} + ${coef}×PVEI(${b.pvei.toFixed(2)})×KSP(${b.ksp.toFixed(2)})`;
            return `(${parts}) × 13/12 / 18`;
          };
          return (
            <div className="flex items-baseline justify-between gap-4 flex-wrap border-b border-zinc-100 dark:border-zinc-800 pb-2">
              <span className="text-zinc-600 dark:text-zinc-300">
                <strong>Valeur Jour :</strong>
                <span className="block text-[10px] italic text-zinc-400">
                  (tFixeTp + 76×PVEI×KSP) × 13/12 / 18 — 100% ·
                  {' '}(tFixeTp + Prime Instr. + 96×PVEI×KSP) × 13/12 / 18 — instructeurs
                  {' '}· tFixeTp = fixe × coefFonction × coefEchelon
                </span>
                {firstRow.valeur_jour_breakdown && (
                  <span className="block text-[10px] font-mono text-zinc-500 mt-1">
                    1ʳᵉ ({firstRow.debut_rotation.slice(0, 7)}) : {fmtBreakdown(firstRow.valeur_jour_breakdown)} = {fmtEur(firstRow.valeur_jour)} €
                  </span>
                )}
                {!sameValue && lastRow.valeur_jour_breakdown && (
                  <span className="block text-[10px] font-mono text-zinc-500">
                    Der. ({lastRow.debut_rotation.slice(0, 7)}) : {fmtBreakdown(lastRow.valeur_jour_breakdown)} = {fmtEur(lastRow.valeur_jour)} €
                  </span>
                )}
              </span>
              <span className="font-mono text-zinc-800 dark:text-zinc-100">
                {sameValue
                  ? `${fmtEur(firstRow.valeur_jour)} €`
                  : `${fmtEur(firstRow.valeur_jour)} / ${fmtEur(lastRow.valeur_jour)} €`}
              </span>
            </div>
          );
        })()}
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <span className="text-zinc-600 dark:text-zinc-300">
            <strong>Nombre total de jours de missions hors de France :</strong>
            <span className="block text-[10px] italic text-zinc-400">
              plafond {data.plafond_jours} j
              {data.regime_used ? ` · régime ${data.regime_used}` : ''}
              {data.cumul_jours > data.plafond_jours && (
                <span className="ml-1 text-amber-600 dark:text-amber-400">· cumul brut {data.cumul_jours.toFixed(1)} j</span>
              )}
            </span>
          </span>
          <span className="font-mono text-zinc-800 dark:text-zinc-100">
            {data.nb_total_jours.toFixed(1)} / {data.plafond_jours} j
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <span className="text-zinc-600 dark:text-zinc-300">
            <strong>Montant total des primes de séjour :</strong>
          </span>
          <span className="font-mono text-zinc-800 dark:text-zinc-100">{fmtEur(data.montant_total)} €</span>
        </div>
        <div className="flex items-baseline justify-between gap-4 flex-wrap border-t border-zinc-100 dark:border-zinc-800 pt-2 mt-2">
          <span className="text-zinc-600 dark:text-zinc-300">
            <strong>Montant brut fiscal pris en compte pour le calcul du plafond d&apos;exonération :</strong>
            <span className="block text-[10px] italic text-zinc-400">à saisir depuis la fiche de paie annuelle</span>
          </span>
          <div className="flex items-center gap-1">
            <input
              type="number"
              step="0.01"
              min={0}
              value={plafondInput}
              onChange={e => setPlafondInput(e.target.value)}
              onBlur={handlePlafondCommit}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              placeholder="0"
              className="w-32 px-2 py-1 text-right font-mono text-sm rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-100"
              disabled={isPending}
            />
            <span className="font-mono text-zinc-600 dark:text-zinc-300">€</span>
          </div>
        </div>
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <span className="text-zinc-600 dark:text-zinc-300">
            <strong>Montant brut fiscal exonérable au titre de l&apos;article 81A II :</strong>
            <span className="block text-[10px] italic text-zinc-400">
              = MIN(0,4 × plafond ; primes séjour)
              {data.plafond_exo_brut != null && data.plafond_exo_brut > 0 && (
                <span className="ml-1 font-mono">
                  · 0,4 × plafond = <span className="text-zinc-500">{fmtEur(0.4 * data.plafond_exo_brut)} €</span>
                </span>
              )}
            </span>
          </span>
          <span className={`font-mono ${data.montant_exo > 0 ? 'text-zinc-800 dark:text-zinc-100' : 'text-zinc-400'}`}>
            {fmtEur(data.montant_exo)} €
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <span className="text-zinc-600 dark:text-zinc-300">
            <strong>Montant net fiscal exonérable au titre de l&apos;article 81A II :</strong>
            <span className="block text-[10px] italic text-zinc-400">= 0,818 × Montant exo brut</span>
          </span>
          <span className={`font-mono ${data.montant_net_exo > 0 ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-zinc-400'}`}>
            {fmtEur(data.montant_net_exo)} €
          </span>
        </div>
      </div>
    </div>
  );
}
