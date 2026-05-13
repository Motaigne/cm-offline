'use client';

import { useState, useMemo, useEffect } from 'react';
import { PVEI, KSP } from '@/lib/finance';
import { getRotationsForMonth } from '@/app/actions/search';
import { cacheRotations, loadRotationsFromDB, getCachedMonths } from '@/lib/local-db';
import { ReleasePublisher } from './release-publisher';
import { computeArticle81 } from '@/lib/article81';
import type { Article81Data } from '@/lib/article81';

type Sig = {
  id: string;
  rotation_code: string | null;
  zone: string | null;
  aircraft_code: string;
  hc: number;
  hcr_crew: number;
  tsv_nuit: number | null;
  prime: number | null;
  nb_on_days: number;
  first_layover: string | null;
  layovers: number;
  rest_before_h: number | null;
  rest_after_h: number | null;
  a81: boolean | null;
  heure_debut: string | null;
  heure_fin: string | null;
  temps_sej: number | null;
};

type SortKey = 'rotation_code' | 'zone' | 'aircraft_code' | 'nb_on_days' | 'hc' | 'hcr_crew' | 'pv_h' | 'prime' | 'total_eur' | 'heure_debut' | 'heure_fin' | 'a81_brut' | 'a81_jour';
type SortDir = 'asc' | 'desc';

const MONTH_FR = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];

function fmt(n: number, dec = 0) {
  return n.toFixed(dec).replace('.', ',');
}

function rotToSig(s: Awaited<ReturnType<typeof getRotationsForMonth>>[0]): Sig {
  return {
    id: s.id, rotation_code: s.rotation_code, zone: s.zone,
    aircraft_code: s.aircraft_code, hc: s.hc, hcr_crew: s.hcr_crew,
    tsv_nuit: s.tsv_nuit, prime: s.prime, nb_on_days: s.nb_on_days,
    first_layover: s.first_layover, layovers: s.layovers,
    rest_before_h: s.rest_before_h, rest_after_h: s.rest_after_h, a81: s.a81,
    heure_debut: s.heure_debut, heure_fin: s.heure_fin,
    temps_sej: s.temps_sej ?? null,
  };
}

function fmtTime(t: string | null): string {
  if (!t) return '—';
  return t.slice(0, 5);
}

export function CatalogueTable({
  signatures: initialSigs, months: initialMonths, currentMonth: initialMonth, isAdmin,
  article81Data, valeurJour,
}: {
  signatures: Sig[];
  months: string[];
  currentMonth: string;
  isAdmin: boolean;
  article81Data: Article81Data | null;
  valeurJour: number;
}) {
  const [sigs, setSigs]             = useState<Sig[]>(initialSigs);
  const [months, setMonths]         = useState<string[]>(initialMonths);
  const [currentMonth, setMonth]    = useState(initialMonth);
  const [loading, setLoading]       = useState(false);
  const [fromCache, setFromCache]   = useState(false);
  const [noCache, setNoCache]       = useState(false);
  const [sortKey, setSortKey]       = useState<SortKey>('total_eur');
  const [sortDir, setSortDir]       = useState<SortDir>('desc');
  const [filter, setFilter]         = useState('');

  // Restaure le dernier mois sélectionné dans le calendrier
  useEffect(() => {
    const stored = localStorage.getItem('cm-selected-month');
    if (stored && stored !== currentMonth) void loadMonth(stored);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadMonth(m: string) {
    setMonth(m);
    setFromCache(false); setNoCache(false);
    window.history.replaceState(null, '', `/catalogue?m=${m}`);
    setLoading(true);
    try {
      // IDB d'abord (offline-first) — réseau seulement si IDB vide
      const cached = await loadRotationsFromDB(m);
      if (cached.length > 0) {
        setSigs(cached.map(rotToSig));
        setFromCache(true);
      } else if (navigator.onLine) {
        const data = await getRotationsForMonth(m);
        setSigs(data.map(rotToSig));
        void cacheRotations(data, m);
      } else {
        setNoCache(true); setSigs([]);
        const cms = await getCachedMonths(); if (cms.length) setMonths(cms);
      }
    } catch {
      const cached = await loadRotationsFromDB(m);
      if (cached.length > 0) { setSigs(cached.map(rotToSig)); setFromCache(true); }
      else { setNoCache(true); setSigs([]); }
    } finally { setLoading(false); }
  }

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  }

  const rows = useMemo(() => {
    const q = filter.toLowerCase();
    return sigs
      .map(s => {
        const tsvNuit  = s.tsv_nuit ?? 0;
        const prime    = s.prime ?? 0;
        const pvH      = s.hcr_crew + tsvNuit / 2;
        const montantPv = pvH * PVEI * KSP;
        const primeBT  = prime * 2.5 * PVEI;
        const totalEur = montantPv + primeBT;
        // Article 81 — montant prime séjour + montant/jour, lookup zone × tSej en annexe
        const a81 = (s.temps_sej != null && s.zone)
          ? computeArticle81({ tSej: Number(s.temps_sej), zone: s.zone, valeurJour, data: article81Data })
          : null;
        return {
          ...s,
          pv_h: pvH, total_eur: totalEur, montant_pv: montantPv, prime_bt: primeBT,
          a81_brut: a81?.montantPrimeSej ?? 0,
          a81_jour: a81?.montantPrimeSejJour ?? 0,
        };
      })
      .filter(s => !q || [s.rotation_code, s.zone, s.aircraft_code, s.first_layover].some(v => v?.toLowerCase().includes(q)))
      .sort((a, b) => {
        const va = a[sortKey as keyof typeof a] ?? '';
        const vb = b[sortKey as keyof typeof b] ?? '';
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
  }, [sigs, sortKey, sortDir, filter]);

  function monthLabel(m: string) {
    const [y, mo] = m.split('-').map(Number);
    return `${MONTH_FR[mo - 1]} ${y}`;
  }

  function Col({ k, children }: { k: SortKey; children: React.ReactNode }) {
    const active = sortKey === k;
    return (
      <th
        className="px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-zinc-400 cursor-pointer select-none hover:text-zinc-200 whitespace-nowrap"
        onClick={() => handleSort(k)}
      >
        {children} {active ? (sortDir === 'asc' ? '↑' : '↓') : ''}
      </th>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex-shrink-0">
        <select
          value={currentMonth}
          onChange={e => loadMonth(e.target.value)}
          disabled={loading}
          className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {months.map(m => (
            <option key={m} value={m}>{monthLabel(m)}</option>
          ))}
          {!months.includes(currentMonth) && (
            <option value={currentMonth}>{monthLabel(currentMonth)}</option>
          )}
        </select>
        <input
          type="search"
          placeholder="Filtrer…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm w-40"
        />
        <span className="text-xs text-zinc-400 ml-auto">
          {loading ? 'Chargement…' : noCache ? 'Non disponible hors ligne' : `${rows.length} rotation${rows.length > 1 ? 's' : ''}${fromCache ? ' · cache' : ''}`}
        </span>
        {isAdmin && (
          <>
            <a
              href={`/api/export/legacy?month=${currentMonth}&format=slim`}
              download
              className="text-xs px-2.5 py-1 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
              title="Export CSV format $MMAAAA$ (12 colonnes, M-1→M fusionné)"
            >
              Export slim
            </a>
            <a
              href={`/api/export/legacy?month=${currentMonth}&format=full`}
              download
              className="text-xs px-2.5 py-1 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
              title="Export CSV format MMAAAA (47 colonnes — colonnes dérivées TODO)"
            >
              Export full
            </a>
            <ReleasePublisher month={currentMonth} isAdmin={isAdmin} />
          </>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 bg-zinc-900 text-white z-10">
            <tr>
              <Col k="rotation_code">Rotation</Col>
              <Col k="zone">Zone</Col>
              <Col k="aircraft_code">Avion</Col>
              <Col k="heure_debut">Dép</Col>
              <Col k="heure_fin">Arr</Col>
              <Col k="nb_on_days">ON</Col>
              <Col k="hc">Hc</Col>
              <Col k="hcr_crew">Hcr</Col>
              <th className="px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-zinc-400 whitespace-nowrap">TSVnuit</th>
              <Col k="pv_h">PV (h)</Col>
              <Col k="prime">Prime</Col>
              <Col k="total_eur">Total €</Col>
              <Col k="a81_brut">A81 €</Col>
              <Col k="a81_jour">A81 / j</Col>
              <th className="px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Escale</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={15} className="px-4 py-8 text-center text-zinc-400 text-sm">
                  {months.length === 0 ? 'Aucun scraping disponible — importez d\'abord des rotations.' : 'Aucun résultat.'}
                </td>
              </tr>
            )}
            {rows.map((s, i) => (
              <tr
                key={s.id}
                className={`border-b border-zinc-100 dark:border-zinc-800 hover:bg-blue-50 dark:hover:bg-blue-950/20 transition-colors ${i % 2 === 0 ? '' : 'bg-zinc-50/50 dark:bg-zinc-900/30'}`}
              >
                <td className="px-2 py-1.5 font-medium text-zinc-800 dark:text-zinc-100 whitespace-nowrap">{s.rotation_code ?? '—'}</td>
                <td className="px-2 py-1.5 text-zinc-500">{s.zone ?? '—'}</td>
                <td className="px-2 py-1.5 text-zinc-500">{s.aircraft_code}</td>
                <td className="px-2 py-1.5 font-mono text-zinc-500 text-xs">{fmtTime(s.heure_debut)}</td>
                <td className="px-2 py-1.5 font-mono text-zinc-500 text-xs">{fmtTime(s.heure_fin)}</td>
                <td className="px-2 py-1.5 font-mono text-zinc-600 dark:text-zinc-300">{s.nb_on_days}</td>
                <td className="px-2 py-1.5 font-mono text-zinc-600 dark:text-zinc-300">{fmt(s.hc, 2)}</td>
                <td className="px-2 py-1.5 font-mono text-zinc-700 dark:text-zinc-200">{fmt(s.hcr_crew, 2)}</td>
                <td className="px-2 py-1.5 font-mono text-violet-600 dark:text-violet-400">{fmt((s.tsv_nuit ?? 0), 2)}</td>
                <td className="px-2 py-1.5 font-mono text-blue-600 dark:text-blue-400 font-semibold">{fmt(s.pv_h, 2)}</td>
                <td className="px-2 py-1.5 font-mono text-amber-600 dark:text-amber-400">
                  {(s.prime ?? 0) > 0 ? `×${s.prime}` : '—'}
                </td>
                <td className="px-2 py-1.5 font-mono font-bold text-zinc-900 dark:text-zinc-50 whitespace-nowrap">
                  {Math.round(s.total_eur)} €
                </td>
                <td className="px-2 py-1.5 font-mono text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                  {s.a81_brut > 0 ? `${Math.round(s.a81_brut)} €` : '—'}
                </td>
                <td className="px-2 py-1.5 font-mono text-emerald-700/70 dark:text-emerald-300/70 whitespace-nowrap">
                  {s.a81_jour > 0 ? `${Math.round(s.a81_jour)} €` : '—'}
                </td>
                <td className="px-2 py-1.5 text-zinc-500 text-xs">{s.first_layover ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
