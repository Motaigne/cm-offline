'use client';

import { useRouter } from 'next/navigation';
import type { A81YearData } from '@/app/actions/a81';

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
  // Heure en centième (HH + min/60), arrondi au centième.
  const hCent = d.getUTCHours() + d.getUTCMinutes() / 60;
  return `${dd}/${mm}/${yyyy} ${hCent.toFixed(2)}`;
}

function fmtEur(n: number): string {
  return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTaux(t: number | null): string {
  if (t == null) return '—';
  return `${Math.round(t * 100)} %`;
}

export function A81Client({
  data, availableYears, currentYear,
}: {
  data: A81YearData;
  availableYears: number[];
  currentYear: number;
}) {
  const router = useRouter();
  const yearsToShow = availableYears.includes(currentYear)
    ? availableYears
    : [currentYear, ...availableYears].sort((a, b) => b - a);

  function changeYear(y: number) {
    router.push(`/a81?y=${y}`);
  }

  // Plafond exonération (à venir étape 5.3) — placeholder pour l'instant.
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
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {data.rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-zinc-400 italic">
                    Aucune rotation éligible dans le planning ligne A pour {currentYear}.
                  </td>
                </tr>
              )}
              {data.rows.map((r, i) => {
                const monthIdx = Number(r.debut_rotation.slice(5, 7)) - 1;
                return (
                  <tr key={r.instance_id} className={i % 2 ? 'bg-zinc-50/50 dark:bg-zinc-800/20' : ''}>
                    <td className="px-2 py-1.5 whitespace-nowrap text-zinc-700 dark:text-zinc-200 italic">
                      {fmtDate(r.debut_rotation)}
                      <div className="text-[9px] text-zinc-400 leading-none">{MONTHS_FR_SHORT[monthIdx]}</div>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap font-mono text-zinc-700 dark:text-zinc-200 italic">{fmtDateTime(r.debut_sejour_at)}</td>
                    <td className="px-2 py-1.5 text-center font-mono font-semibold text-zinc-700 dark:text-zinc-200 italic">{r.escale_debut}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap font-mono text-zinc-700 dark:text-zinc-200 italic">{fmtDateTime(r.fin_sejour_at)}</td>
                    <td className="px-2 py-1.5 text-center font-mono font-semibold text-zinc-700 dark:text-zinc-200 italic">{r.escale_fin}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-zinc-700 dark:text-zinc-200 italic">{r.temps_sej_h.toFixed(2)}</td>
                    <td className={`px-2 py-1.5 text-right font-mono italic ${r.plafond ? 'text-amber-600 dark:text-amber-400 font-semibold' : 'text-zinc-700 dark:text-zinc-200'}`}>
                      {r.plafond ? 'PLAF' : r.nb_jours.toFixed(1)}
                    </td>
                    <td className="px-2 py-1.5 text-center font-mono font-semibold text-zinc-700 dark:text-zinc-200 italic">{r.zone ?? '—'}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-zinc-700 dark:text-zinc-200 italic">{fmtTaux(r.taux)}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-zinc-700 dark:text-zinc-200 italic">{fmtEur(r.valeur_jour)}</td>
                    <td className={`px-2 py-1.5 text-right font-mono italic ${r.montant > 0 ? 'text-zinc-800 dark:text-zinc-100' : 'text-zinc-400'}`}>
                      {fmtEur(r.montant)}
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
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Footer — synthèse fiscale (5.3 plus tard pour le plafond Exo éditable) */}
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
