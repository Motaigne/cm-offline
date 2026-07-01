'use client';

import { useState, useMemo, useEffect } from 'react';
import { PVEI as PVEI_DEFAULT, KSP as KSP_DEFAULT } from '@/lib/finance';
import { getRotationsForMonth } from '@/app/actions/search';
import { cacheRotations, loadRotationsFromDB, getCachedMonths } from '@/lib/local-db';
import { raceTimeout } from '@/lib/net';
import { ReleasePublisher } from './release-publisher';
import { computeArticle81, TAXI_TSEJ_ADJUST_H } from '@/lib/article81';
import type { Article81Data } from '@/lib/article81';
import { getPveiKspForMonth, getValeurJourForMonth, VALEUR_JOUR_DEFAULT, type AnnexeRow } from '@/lib/annexe';
import type { ProfileVersion } from '@/app/actions/profile-version';

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

type SortKey = 'rotation_code' | 'zone' | 'aircraft_code' | 'nb_on_days' | 'hc' | 'hcr_crew' | 'hc_on' | 'pv_h' | 'prime' | 'total_eur' | 'heure_debut' | 'heure_fin' | 'a81_brut' | 'a81_jour';
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

/** Sigs affichables au catalogue : exclut les sigs rescued (hors snapshot du
 *  mois — spillover M-1, vol d'un ancien snapshot). Elles restent en cache
 *  Dexie pour le calendrier/EP4 offline mais ne sont pas des rotations
 *  proposables et gonflent les compteurs. */
function catalogSigs(sigs: Awaited<ReturnType<typeof getRotationsForMonth>>): Sig[] {
  return sigs.filter(s => !s.rescued).map(rotToSig);
}

function fmtTime(t: string | null): string {
  if (!t) return '—';
  return t.slice(0, 5);
}

/** Cellule d'en-tête triable. Top-level pour éviter la recréation à chaque render. */
function Col({
  k, children, sortKey, sortDir, onSort,
}: {
  k: SortKey;
  children: React.ReactNode;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  const active = sortKey === k;
  return (
    <th
      className="px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-zinc-400 cursor-pointer select-none hover:text-zinc-200 whitespace-nowrap"
      onClick={() => onSort(k)}
    >
      {children} {active ? (sortDir === 'asc' ? '↑' : '↓') : ''}
    </th>
  );
}

export function CatalogueTable({
  signatures: initialSigs, months: initialMonths, currentMonth: initialMonth, isAdmin,
  article81Data,
  profileVersions = [], annexeRows = [],
}: {
  signatures: Sig[];
  months: string[];
  currentMonth: string;
  isAdmin: boolean;
  article81Data: Article81Data | null;
  /** Versions du profil utilisateur — pour dériver PVEI + Valeur Jour applicables au mois. */
  profileVersions?: ProfileVersion[];
  /** Rows annexe versionnées — pour `getPveiKspForMonth` + `getValeurJourForMonth`. */
  annexeRows?: AnnexeRow[];
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
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Restaure le dernier mois sélectionné dans le calendrier — sauf s'il
  // pointe vers un mois fictif (projection) qui n'est pas dispo en
  // catalogue : on reste alors sur currentMonth (= fallback SSR réel).
  useEffect(() => {
    const stored = localStorage.getItem('cm-selected-month');
    if (stored && stored !== currentMonth && months.includes(stored)) void loadMonth(stored);
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
        setSigs(catalogSigs(cached));
        setFromCache(true);
      } else if (navigator.onLine) {
        // Timeout : sans ça, cache vide + wifi captif = spinner bloqué à
        // l'infini (le catch de repli ne s'exécute jamais). Sur timeout → catch
        // → nouvelle tentative Dexie → "pas de cache" au lieu d'un hang.
        const data = await raceTimeout(getRotationsForMonth(m), 10_000, 'catalogue getRotations');
        setSigs(catalogSigs(data));
        // Cache la liste COMPLÈTE (rescued incluses) : le calendrier/EP4
        // offline en a besoin — seul l'affichage catalogue les exclut.
        void cacheRotations(data, m);
      } else {
        setNoCache(true); setSigs([]);
        const cms = await getCachedMonths(); if (cms.length) setMonths(cms);
      }
    } catch {
      const cached = await loadRotationsFromDB(m);
      if (cached.length > 0) { setSigs(catalogSigs(cached)); setFromCache(true); }
      else { setNoCache(true); setSigs([]); }
    } finally { setLoading(false); }
  }

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  }

  // PVEI/KSP dérivés du profil utilisateur applicable au mois courant.
  // Fallback aux constantes par défaut si profil incomplet ou annexe non chargée.
  const { pvei, ksp } = useMemo(() => {
    const r = getPveiKspForMonth(profileVersions, annexeRows, currentMonth);
    return r ?? { pvei: PVEI_DEFAULT, ksp: KSP_DEFAULT };
  }, [profileVersions, annexeRows, currentMonth]);

  // Valeur Jour A81 par mois courant — fallback 600 si profil/annexe insuffisants.
  const valeurJour = useMemo(
    () => getValeurJourForMonth(profileVersions, annexeRows, currentMonth) ?? VALEUR_JOUR_DEFAULT,
    [profileVersions, annexeRows, currentMonth],
  );

  // Enrichement + tri — coûteux (500+ rows × computeArticle81), mais ne dépend
  // pas du filtre. Re-calculé seulement au changement de mois / profil / tri.
  const enrichedSorted = useMemo(() => {
    const enriched = sigs.map(s => {
      const tsvNuit  = s.tsv_nuit ?? 0;
      const prime    = s.prime ?? 0;
      const pvH      = s.hcr_crew + tsvNuit / 2;
      const montantPv = pvH * pvei * ksp;
      const primeBT  = prime * 2.5 * pvei;
      const totalEur = montantPv + primeBT;
      // Article 81 — montant prime séjour + montant/jour, lookup zone × tSej en annexe
      // s.temps_sej = block-to-block (scraper, sans taxi) — cf TAXI_TSEJ_ADJUST_H.
      const a81 = (s.temps_sej != null && s.zone)
        ? computeArticle81({ tSej: Number(s.temps_sej) + TAXI_TSEJ_ADJUST_H, zone: s.zone, valeurJour, data: article81Data })
        : null;
      const hcOn = s.nb_on_days > 0 ? s.hc / s.nb_on_days : 0;
      return {
        ...s,
        pv_h: pvH, total_eur: totalEur, montant_pv: montantPv, prime_bt: primeBT,
        hc_on: hcOn,
        a81_brut: a81?.montantPrimeSej ?? 0,
        a81_jour: a81?.montantPrimeSejJour ?? 0,
      };
    });
    enriched.sort((a, b) => {
      const va = a[sortKey as keyof typeof a] ?? '';
      const vb = b[sortKey as keyof typeof b] ?? '';
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return enriched;
  }, [sigs, pvei, ksp, valeurJour, article81Data, sortKey, sortDir]);

  // Filtrage uniquement — O(n), s'exécute à chaque keystroke du filtre sans
  // jamais déclencher de recompute de computeArticle81.
  const rows = useMemo(() => {
    const q = filter.toLowerCase();
    if (!q) return enrichedSorted;
    return enrichedSorted.filter(s =>
      [s.rotation_code, s.zone, s.aircraft_code, s.first_layover].some(v => v?.toLowerCase().includes(q)),
    );
  }, [enrichedSorted, filter]);

  function monthLabel(m: string) {
    const [y, mo] = m.split('-').map(Number);
    return `${MONTH_FR[mo - 1]} ${y}`;
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
              title="CSV pour Google Sheet (onglet $MMAAAA$) — 12 colonnes, rotations M-1 chevauchant M incluses, tri par PV+Prime"
            >
              Export slim
            </a>
            <a
              href={`/api/export/legacy?month=${currentMonth}&format=full`}
              download
              className="text-xs px-2.5 py-1 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
              title="CSV détaillé (onglet MMAAAA) — 47 colonnes avec ligne par étape (colonnes calculées TME/CMT/HCV en cours de portage)"
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
              {([
                ['rotation_code', 'Rotation'],
                ['zone',          'Zone'],
                ['aircraft_code', 'Avion'],
                ['heure_debut',   'Dép'],
                ['heure_fin',     'Arr'],
                ['nb_on_days',    'ON'],
                ['hc',            'Hc'],
                ['hcr_crew',      'Hcr'],
                ['hc_on',         'HC/ON'],
              ] as const).map(([k, label]) => (
                <Col key={k} k={k} sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>{label}</Col>
              ))}
              <th className="px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-zinc-400 whitespace-nowrap">TSVnuit</th>
              {([
                ['pv_h',      'PV (h)'],
                ['prime',     'Prime'],
                ['total_eur', 'Total €'],
                ['a81_brut',  'A81 €'],
                ['a81_jour',  'A81 / j'],
              ] as const).map(([k, label]) => (
                <Col key={k} k={k} sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>{label}</Col>
              ))}
              <th className="px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Escale</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={16} className="px-4 py-8 text-center text-zinc-400 text-sm">
                  {months.length === 0 ? 'Aucun scraping disponible — importez d\'abord des rotations.' : 'Aucun résultat.'}
                </td>
              </tr>
            )}
            {rows.map((s, i) => (
              <tr
                key={s.id}
                onClick={() => setSelectedId(prev => prev === s.id ? null : s.id)}
                className={[
                  'border-b border-zinc-100 dark:border-zinc-800 transition-colors cursor-pointer',
                  selectedId === s.id
                    ? 'bg-zinc-200 dark:bg-zinc-700/60 hover:bg-zinc-200 dark:hover:bg-zinc-700/60'
                    : `hover:bg-blue-50 dark:hover:bg-blue-950/20 ${i % 2 === 0 ? '' : 'bg-zinc-50/50 dark:bg-zinc-900/30'}`,
                ].join(' ')}
              >
                <td className="px-2 py-1.5 font-medium text-zinc-800 dark:text-zinc-100 whitespace-nowrap">{s.rotation_code ?? '—'}</td>
                <td className="px-2 py-1.5 text-zinc-500">{s.zone ?? '—'}</td>
                <td className="px-2 py-1.5 text-zinc-500">{s.aircraft_code}</td>
                <td className="px-2 py-1.5 font-mono text-zinc-500 text-xs">{fmtTime(s.heure_debut)}</td>
                <td className="px-2 py-1.5 font-mono text-zinc-500 text-xs">{fmtTime(s.heure_fin)}</td>
                <td className="px-2 py-1.5 font-mono text-zinc-600 dark:text-zinc-300">{s.nb_on_days}</td>
                <td className="px-2 py-1.5 font-mono text-zinc-600 dark:text-zinc-300">{fmt(s.hc, 2)}</td>
                <td className="px-2 py-1.5 font-mono text-zinc-700 dark:text-zinc-200">{fmt(s.hcr_crew, 2)}</td>
                <td className="px-2 py-1.5 font-mono text-zinc-500">{s.hc_on > 0 ? fmt(s.hc_on, 2) : '—'}</td>
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
