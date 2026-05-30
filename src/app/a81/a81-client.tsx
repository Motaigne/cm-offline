'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { A81YearData, A81Row } from '@/app/actions/a81';
import { upsertA81Override, deleteA81Row } from '@/app/actions/a81';

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
      <div className="flex flex-col gap-1">
        <input
          type="datetime-local"
          value={val}
          onChange={e => setVal(e.target.value)}
          className="text-[10px] font-mono px-1 py-0.5 rounded border border-blue-300 dark:border-blue-700 bg-white dark:bg-zinc-900"
          autoFocus
        />
        <div className="flex gap-1 text-[9px]">
          <button onClick={save} className="px-1.5 py-0.5 rounded bg-blue-600 text-white font-semibold">OK</button>
          <button onClick={cancel} className="px-1.5 py-0.5 rounded text-zinc-500 hover:text-zinc-700">×</button>
          {overridden && (
            <button onClick={reset} className="px-1.5 py-0.5 rounded text-amber-600 hover:text-amber-800" title="Restaurer la valeur d'origine">↺</button>
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
  data, availableYears, currentYear,
}: {
  data: A81YearData;
  availableYears: number[];
  currentYear: number;
}) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [err, setErr] = useState('');

  const yearsToShow = availableYears.includes(currentYear)
    ? availableYears
    : [currentYear, ...availableYears].sort((a, b) => b - a);

  function changeYear(y: number) {
    router.push(`/a81?y=${y}`);
  }

  function handleEditDebut(row: A81Row, newIso: string | null) {
    setErr('');
    start(async () => {
      const res = await upsertA81Override(row.instance_id, { debut_sejour_at: newIso });
      if ('error' in res) { setErr(res.error); return; }
      router.refresh();
    });
  }
  function handleEditFin(row: A81Row, newIso: string | null) {
    setErr('');
    start(async () => {
      const res = await upsertA81Override(row.instance_id, { fin_sejour_at: newIso });
      if ('error' in res) { setErr(res.error); return; }
      router.refresh();
    });
  }
  function handleDelete(row: A81Row) {
    const label = `${fmtDate(row.debut_rotation)} ${row.escale_debut}${row.escale_fin !== row.escale_debut ? '/' + row.escale_fin : ''}`;
    if (!confirm(`Supprimer cette ligne du tableau A81 ?\n\n${label}\n\nLa rotation reste dans le planning ; elle est juste masquée du tableau A81.`)) return;
    setErr('');
    start(async () => {
      const res = await deleteA81Row(row.instance_id);
      if ('error' in res) { setErr(res.error); return; }
      router.refresh();
    });
  }

  const plafondExoBrut = 0;
  const montantExo = plafondExoBrut > 0 ? Math.min(0.4 * plafondExoBrut, data.montant_total) : 0;
  const montantNetExo = 0.818 * montantExo;

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
              {data.rows.map((r, i) => {
                const monthIdx = Number(r.debut_rotation.slice(5, 7)) - 1;
                const anyOverride = r.debut_sejour_overridden || r.fin_sejour_overridden;
                return (
                  <tr key={r.instance_id} className={i % 2 ? 'bg-zinc-50/50 dark:bg-zinc-800/20' : ''}>
                    <td className="px-2 py-1.5 whitespace-nowrap text-zinc-700 dark:text-zinc-200 italic">
                      {fmtDate(r.debut_rotation)}
                      <div className="text-[9px] text-zinc-400 leading-none">{MONTHS_FR_SHORT[monthIdx]}</div>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <EditableDateTimeCell
                        iso={r.debut_sejour_at}
                        originIso={r.debut_sejour_at_origin}
                        overridden={r.debut_sejour_overridden}
                        onSave={iso => handleEditDebut(r, iso)}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-center font-mono font-semibold text-zinc-700 dark:text-zinc-200 italic">{r.escale_debut}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <EditableDateTimeCell
                        iso={r.fin_sejour_at}
                        originIso={r.fin_sejour_at_origin}
                        overridden={r.fin_sejour_overridden}
                        onSave={iso => handleEditFin(r, iso)}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-center font-mono font-semibold text-zinc-700 dark:text-zinc-200 italic">{r.escale_fin}</td>
                    <td className={`px-2 py-1.5 text-right font-mono ${anyOverride ? 'font-bold not-italic text-zinc-800 dark:text-zinc-100' : 'italic text-zinc-700 dark:text-zinc-200'}`}>
                      {r.temps_sej_h.toFixed(2)}
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
                      <button
                        onClick={() => handleDelete(r)}
                        disabled={isPending}
                        className="text-zinc-300 hover:text-red-500 dark:text-zinc-600 dark:hover:text-red-400 text-base leading-none disabled:opacity-30"
                        title="Supprimer cette ligne du tableau A81"
                      >×</button>
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

      {/* Footer fiscal */}
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-2 text-sm">
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <span className="text-zinc-600 dark:text-zinc-300">
            <strong>Nombre total de jours de missions hors de France :</strong>
          </span>
          <span className="font-mono text-zinc-800 dark:text-zinc-100">{data.nb_total_jours.toFixed(1)} j</span>
        </div>
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <span className="text-zinc-600 dark:text-zinc-300">
            <strong>Montant total des primes de séjour :</strong>
          </span>
          <span className="font-mono text-zinc-800 dark:text-zinc-100">{fmtEur(data.montant_total)} €</span>
        </div>
        <div className="flex items-baseline justify-between gap-4 flex-wrap border-t border-zinc-100 dark:border-zinc-800 pt-2 mt-2">
          <span className="text-zinc-400">
            <strong>Montant brut fiscal pris en compte pour le calcul du plafond d&apos;exonération :</strong>
            <span className="block text-[10px] italic">à saisir (étape suivante)</span>
          </span>
          <span className="font-mono text-zinc-400">— €</span>
        </div>
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <span className="text-zinc-400">
            <strong>Montant brut fiscal exonérable au titre de l&apos;article 81A II :</strong>
          </span>
          <span className="font-mono text-zinc-400">{fmtEur(montantExo)} €</span>
        </div>
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <span className="text-zinc-400">
            <strong>Montant net fiscal exonérable au titre de l&apos;article 81A II :</strong>
            <span className="block text-[10px] italic">= 0,818 × Montant exo brut</span>
          </span>
          <span className="font-mono text-zinc-400">{fmtEur(montantNetExo)} €</span>
        </div>
      </div>
    </div>
  );
}
