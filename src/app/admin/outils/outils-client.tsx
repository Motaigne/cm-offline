'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  generateFictiveSnapshots,
  deleteFictiveSnapshotsForMonth,
  type FictiveGenResult,
} from '@/app/actions/admin-projection';

const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

function fmtMonth(monthYM: string): string {
  const [y, m] = monthYM.split('-').map(Number);
  if (!y || !m) return monthYM;
  return `${MONTHS_FR[m - 1]} ${y}`;
}

function shiftMonthStr(month: string, n: number): string {
  const [y, mo] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface Fictive {
  target_month: string;
  unique_signatures: number | null;
  flights_found: number | null;
  finished_at: string | null;
}

export function OutilsClient({
  latestRealMonth, fictives: initialFictives,
}: {
  latestRealMonth: string | null;
  fictives: Fictive[];
}) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [err, setErr] = useState('');
  const [result, setResult] = useState<FictiveGenResult | null>(null);

  // Picker : 13 mois après le dernier mois réel
  const baseMonth = latestRealMonth ?? new Date().toISOString().slice(0, 7);
  const candidates: string[] = [];
  for (let i = 1; i <= 13; i++) candidates.push(shiftMonthStr(baseMonth, i));

  const [startMonth, setStartMonth] = useState<string>(candidates[0]);
  const [endMonth,   setEndMonth]   = useState<string>(candidates[Math.min(3, candidates.length - 1)]);

  async function handleGenerate() {
    setErr(''); setResult(null);
    if (startMonth > endMonth) { setErr('Mois début > mois fin'); return; }
    start(async () => {
      const r = await generateFictiveSnapshots({ startMonth, endMonth });
      if ('error' in r) { setErr(r.error); return; }
      setResult(r);
      router.refresh();
    });
  }

  async function handleDelete(month: string) {
    if (!confirm(`Supprimer la projection ${fmtMonth(month)} ?\n\nCela effacera aussi tous les vols posés par les utilisateurs sur ce mois fictif.`)) return;
    setErr(''); setResult(null);
    start(async () => {
      const r = await deleteFictiveSnapshotsForMonth(month);
      if ('error' in r) { setErr(r.error); return; }
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">

      {/* ── Générateur ──────────────────────────────────────────────────────── */}
      <section className="p-4 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Générer une projection</h2>

        {!latestRealMonth ? (
          <p className="text-xs text-red-600 dark:text-red-400">
            Aucun snapshot réel détecté — il faut au moins 3 mois réels pour générer.
          </p>
        ) : (
          <p className="text-xs text-zinc-500">
            Dernier mois réel : <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-200">{fmtMonth(latestRealMonth)}</span>.
            La projection clone les rotations présentes dans les 3 derniers mois réels et décale les dates.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Mois début</label>
            <select
              value={startMonth}
              onChange={e => setStartMonth(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm font-mono"
            >
              {candidates.map(m => (<option key={m} value={m}>{fmtMonth(m)}</option>))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Mois fin</label>
            <select
              value={endMonth}
              onChange={e => setEndMonth(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm font-mono"
            >
              {candidates.map(m => (<option key={m} value={m}>{fmtMonth(m)}</option>))}
            </select>
          </div>
        </div>

        <button
          type="button"
          onClick={handleGenerate}
          disabled={isPending || !latestRealMonth}
          className="w-full rounded-lg bg-violet-600 text-white px-4 py-2.5 text-sm font-semibold hover:bg-violet-700 disabled:opacity-40 transition-colors"
        >
          {isPending ? 'Génération…' : 'Générer la projection'}
        </button>

        {err && <p className="text-sm text-red-500">{err}</p>}
        {result && (
          <div className="p-3 rounded bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900 text-xs text-green-800 dark:text-green-200 space-y-1">
            <p><strong>{result.created} projection{result.created > 1 ? 's' : ''} créée{result.created > 1 ? 's' : ''}</strong> : {result.months.map(fmtMonth).join(', ')}.</p>
            <p>Sources : {result.sourceMonths.map(fmtMonth).join(' + ')} ({result.yearRoundCount} rotations année-ronde).</p>
          </div>
        )}
      </section>

      {/* ── Liste des projections existantes ────────────────────────────────── */}
      <section className="p-4 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          Projections actives ({initialFictives.length})
        </h2>
        {initialFictives.length === 0 ? (
          <p className="text-xs text-zinc-500">Aucune projection active.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-zinc-400">
              <tr>
                <th className="text-left font-medium py-1">Mois</th>
                <th className="text-right font-medium py-1">Signatures</th>
                <th className="text-right font-medium py-1">Instances</th>
                <th className="text-right font-medium py-1">Créé le</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {initialFictives.map(f => {
                const monthYM = f.target_month.slice(0, 7);
                return (
                  <tr key={f.target_month} className="border-t border-zinc-200 dark:border-zinc-800">
                    <td className="py-2 font-mono">{fmtMonth(monthYM)}</td>
                    <td className="py-2 text-right font-mono">{f.unique_signatures ?? '—'}</td>
                    <td className="py-2 text-right font-mono">{f.flights_found ?? '—'}</td>
                    <td className="py-2 text-right font-mono text-zinc-400">
                      {f.finished_at ? new Date(f.finished_at).toLocaleDateString('fr-FR') : '—'}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => handleDelete(monthYM)}
                        disabled={isPending}
                        className="text-red-600 dark:text-red-400 hover:underline disabled:opacity-40"
                      >
                        Supprimer
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
