'use client';

import { useState, useMemo, useEffect } from 'react';
import { PVEI, KSP } from '@/lib/finance';
import { getRotationsForMonth } from '@/app/actions/search';
import { cacheRotations, loadRotationsFromDB, getCachedMonths } from '@/lib/local-db';
import type { RotationSignature } from '@/app/actions/search';
import { Ep4Detail } from './ep4-detail';
import { computeArticle81 } from '@/lib/article81';
import type { Article81Data } from '@/lib/article81';

type SigInstance = {
  id: string;
  depart_date: string;   // "YYYY-MM-DD"
  depart_at: string;     // ISO UTC
  arrivee_at: string;    // ISO UTC
};

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
  temps_sej: number | null;
  dead_head: boolean | null;
  mep_flight: string | null;
  peq: number | null;
  instances: SigInstance[];
};

const MONTH_FR = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];

function fmt(n: number | null | undefined, dec = 2) {
  if (n == null) return '—';
  return n.toFixed(dec).replace('.', ',');
}

function fmtLocalTime(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString('fr-FR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
  });
}

function dayParis(isoStr: string): number {
  return parseInt(
    new Date(isoStr).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }).slice(8),
    10,
  );
}

function fmtDatePair(inst: SigInstance): string {
  const dep = parseInt(inst.depart_date.slice(8), 10);
  const arr = dayParis(inst.arrivee_at);
  return `${dep}-${arr}`;
}

function rotationMontant(sig: Sig): number {
  const pv    = (sig.hcr_crew + (sig.tsv_nuit ?? 0) / 2) * PVEI * KSP;
  const prime = (sig.prime ?? 0) * 2.5 * PVEI;
  return Math.round(pv + prime);
}

function prorateForMonth(val: number, departAt: string, arriveeAt: string, year: number, mo: number): number {
  const monthStart = Date.UTC(year, mo - 1, 1);
  const monthEnd   = Date.UTC(year, mo,     1);
  const dep = new Date(departAt).getTime();
  const arr = new Date(arriveeAt).getTime();
  if (arr <= dep) return val;
  const ratio = Math.max(0, (Math.min(arr, monthEnd) - Math.max(dep, monthStart)) / (arr - dep));
  return Math.round(val * ratio * 100) / 100;
}

function rotToSig(s: RotationSignature): Sig {
  return {
    id: s.id, rotation_code: s.rotation_code, zone: s.zone,
    aircraft_code: s.aircraft_code, hc: s.hc, hcr_crew: s.hcr_crew,
    tsv_nuit: s.tsv_nuit, prime: s.prime, nb_on_days: s.nb_on_days,
    first_layover: s.first_layover, layovers: s.layovers,
    rest_before_h: s.rest_before_h, rest_after_h: s.rest_after_h,
    a81: s.a81, temps_sej: s.temps_sej, dead_head: s.dead_head,
    mep_flight: s.mep_flight, peq: s.peq,
    instances: s.instances.map(i => ({
      id: i.id, depart_date: i.depart_date,
      depart_at: i.depart_at, arrivee_at: i.arrivee_at,
    })),
  };
}

export function ComparatifClient({
  signatures: initialSigs, months: initialMonths, currentMonth: initialMonth,
  article81Data, valeurJour,
}: {
  signatures: Sig[];
  months: string[];
  currentMonth: string;
  article81Data: Article81Data | null;
  valeurJour: number;
}) {
  const [sigs, setSigs]           = useState<Sig[]>(initialSigs);
  const [months, setMonths]       = useState<string[]>(initialMonths);
  const [currentMonth, setMonth]  = useState(initialMonth);
  const [loading, setLoading]     = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [noCache, setNoCache]     = useState(false);
  const [query, setQuery]         = useState('');
  const [selected, setSelected]   = useState<string | null>(null);

  const [year, mo] = currentMonth.split('-').map(Number);

  // Restaure le dernier mois sélectionné dans le calendrier
  useEffect(() => {
    const stored = localStorage.getItem('cm-selected-month');
    if (stored && stored !== currentMonth) void loadMonth(stored);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadMonth(m: string) {
    setMonth(m);
    setFromCache(false); setNoCache(false); setSelected(null);
    window.history.replaceState(null, '', `/comparatif?m=${m}`);
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

  function monthLabel(m: string) {
    const [y, mm] = m.split('-').map(Number);
    return `${MONTH_FR[mm - 1]} ${y}`;
  }

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return q
      ? sigs.filter(s =>
          s.rotation_code?.toLowerCase().includes(q) ||
          s.first_layover?.toLowerCase().includes(q))
      : sigs;
  }, [sigs, query]);

  const sig = useMemo(() => sigs.find(s => s.id === selected), [sigs, selected]);

  const computed = useMemo(() => {
    if (!sig) return null;
    const tsvNuit   = sig.tsv_nuit ?? 0;
    const prime     = sig.prime ?? 0;
    const pvNuit    = tsvNuit / 2;
    const pvTotal   = sig.hcr_crew + pvNuit;
    const montantPv = pvTotal * PVEI * KSP;
    const primeBT   = prime * 2.5 * PVEI;
    const pvPrime   = montantPv + primeBT;
    return { tsvNuit, pvNuit, pvTotal, montantPv, primeBT, pvPrime };
  }, [sig]);

  const a81 = useMemo(() => {
    if (!sig?.temps_sej || !sig.zone) return null;
    return computeArticle81({
      tSej: Number(sig.temps_sej),
      zone: sig.zone,
      valeurJour,
      data: article81Data,
    });
  }, [sig, valeurJour, article81Data]);

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-4">

      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={currentMonth}
          onChange={e => loadMonth(e.target.value)}
          disabled={loading}
          className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          {!months.includes(currentMonth) && (
            <option value={currentMonth}>{monthLabel(currentMonth)}</option>
          )}
        </select>
        <input
          type="search"
          placeholder="Rechercher escale ou code…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm w-56"
        />
        <span className="text-xs text-zinc-400 ml-auto">
          {loading ? 'Chargement…' : noCache ? 'Non disponible hors ligne' : `${sigs.length} rotation${sigs.length > 1 ? 's' : ''}${fromCache ? ' · cache' : ''}`}
        </span>
      </div>

      {/* Légende */}
      {!selected && (
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500 bg-zinc-100 dark:bg-zinc-800/50 rounded-lg px-3 py-2 leading-relaxed">
          <span className="font-medium text-zinc-500 dark:text-zinc-400">DEP→ARR</span> : heure locale Paris (1er départ · dernière arrivée) ·{' '}
          <span className="font-medium text-zinc-500 dark:text-zinc-400">dates</span> : couples jour-départ / jour-arrivée des instances du mois ·{' '}
          <span className="font-medium text-zinc-500 dark:text-zinc-400">€</span> : PV + prime bi-tronçon (PVEI du profil)
        </p>
      )}

      {/* Liste */}
      {!selected && (
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-center text-zinc-400 text-sm">
              {sigs.length === 0 ? 'Aucune rotation disponible pour ce mois.' : 'Aucun résultat.'}
            </p>
          )}
          {filtered.slice(0, 50).map(s => {
            const first = s.instances[0] ?? null;
            const datePairs = s.instances.map(fmtDatePair).join(' · ');
            const montant = rotationMontant(s);
            return (
              <button
                key={s.id}
                onClick={() => setSelected(s.id)}
                className="w-full flex items-center justify-between gap-3 px-4 py-2.5 border-b border-zinc-100 dark:border-zinc-800 hover:bg-blue-50 dark:hover:bg-blue-950/20 text-left transition-colors"
              >
                <div className="flex flex-col gap-0.5 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-zinc-800 dark:text-zinc-100">
                      {s.nb_on_days}ON {s.first_layover ?? s.rotation_code ?? '—'}
                    </span>
                    {s.dead_head && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-orange-100 dark:bg-orange-950/50 text-orange-600 dark:text-orange-400">
                        MEP {s.mep_flight ?? ''}
                      </span>
                    )}
                    {s.peq != null && s.peq > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-purple-100 dark:bg-purple-950/50 text-purple-600 dark:text-purple-400">
                        PEQ{s.peq}
                      </span>
                    )}
                    {first && (
                      <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400">
                        {fmtLocalTime(first.depart_at)} → {fmtLocalTime(first.arrivee_at)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                    {datePairs && <span className="font-mono">{datePairs}</span>}
                    <span>{s.zone} · {s.aircraft_code}</span>
                  </div>
                </div>
                <span className="text-sm font-semibold font-mono text-zinc-700 dark:text-zinc-200 flex-shrink-0">
                  {montant.toLocaleString('fr-FR')} €
                </span>
              </button>
            );
          })}
          {filtered.length > 50 && (
            <p className="px-4 py-2 text-xs text-zinc-400 text-center">
              +{filtered.length - 50} autres — affinez la recherche
            </p>
          )}
        </div>
      )}

      {/* Détail rotation */}
      {sig && computed && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{sig.rotation_code}</h2>
              {sig.dead_head && (
                <span className="text-xs px-2 py-0.5 rounded font-semibold bg-orange-100 dark:bg-orange-950/50 text-orange-600 dark:text-orange-400">
                  MEP {sig.mep_flight ?? ''}
                </span>
              )}
              {sig.peq != null && sig.peq > 0 && (
                <span className="text-xs px-2 py-0.5 rounded font-semibold bg-purple-100 dark:bg-purple-950/50 text-purple-600 dark:text-purple-400">
                  PEQ{sig.peq}
                </span>
              )}
            </div>
            <button
              onClick={() => setSelected(null)}
              className="text-xs text-zinc-400 hover:text-zinc-600 px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700"
            >
              ← Autre rotation
            </button>
          </div>

          {/* Disponibilités + HCr mois */}
          {sig.instances.length > 0 && (
            <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
              <div className="px-4 py-2 bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-100 dark:border-zinc-800">
                <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide">
                  Disponibilités — {monthLabel(currentMonth)}
                </p>
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-zinc-50/60 dark:bg-zinc-800/30">
                    <th className="px-4 py-1.5 text-left font-medium text-zinc-400 uppercase tracking-wide">Départ</th>
                    <th className="px-4 py-1.5 text-left font-medium text-zinc-400 uppercase tracking-wide">Arrivée</th>
                    <th className="px-4 py-1.5 text-center font-medium text-zinc-400 uppercase tracking-wide">Jours</th>
                    <th className="px-4 py-1.5 text-right font-medium text-zinc-400 uppercase tracking-wide">HCr mois</th>
                    <th className="px-4 py-1.5 text-right font-medium text-zinc-400 uppercase tracking-wide">€ mois</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {sig.instances.map(inst => {
                    const hcrMois = prorateForMonth(sig.hcr_crew, inst.depart_at, inst.arrivee_at, year, mo);
                    const tsvMois = prorateForMonth(sig.tsv_nuit ?? 0, inst.depart_at, inst.arrivee_at, year, mo);
                    const pvMois  = (hcrMois + tsvMois / 2) * PVEI * KSP;
                    const eurMois = Math.round(pvMois + (sig.prime ?? 0) * 2.5 * PVEI);
                    const isProrated = hcrMois < sig.hcr_crew - 0.01;
                    return (
                      <tr key={inst.id}>
                        <td className="px-4 py-1.5 font-mono text-zinc-700 dark:text-zinc-300">
                          {new Date(inst.depart_date + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}
                          <span className="text-zinc-400 ml-1">{fmtLocalTime(inst.depart_at)}</span>
                        </td>
                        <td className="px-4 py-1.5 font-mono text-zinc-700 dark:text-zinc-300">
                          {new Date(inst.arrivee_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' })}
                          <span className="text-zinc-400 ml-1">{fmtLocalTime(inst.arrivee_at)}</span>
                        </td>
                        <td className="px-4 py-1.5 text-center font-mono text-zinc-500">{fmtDatePair(inst)}</td>
                        <td className="px-4 py-1.5 text-right font-mono font-semibold text-zinc-800 dark:text-zinc-100">
                          {hcrMois.toFixed(2)}{isProrated && <span className="text-[10px] text-amber-500 ml-0.5">*</span>}
                        </td>
                        <td className="px-4 py-1.5 text-right font-mono font-semibold text-blue-600 dark:text-blue-400">
                          {eurMois.toLocaleString('fr-FR')} €{isProrated && <span className="text-[10px] text-amber-500 ml-0.5">*</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {sig.instances.some(inst => prorateForMonth(sig.hcr_crew, inst.depart_at, inst.arrivee_at, year, mo) < sig.hcr_crew - 0.01) && (
                <p className="px-4 py-1.5 text-[10px] text-amber-500 border-t border-zinc-100 dark:border-zinc-800">
                  * Rotation à cheval sur 2 mois — valeur proratée au temps de vol réalisé sur {monthLabel(currentMonth)}
                </p>
              )}
            </div>
          )}

          {/* Tableau EP4 */}
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-50 dark:bg-zinc-800">
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide">Champ</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-zinc-500 uppercase tracking-wide">Valeur DB</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-zinc-500 uppercase tracking-wide">Calculé</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide">Formule</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                <Row label="Rotation"         db={sig.rotation_code}           calc={sig.rotation_code}              formula="—" />
                <Row label="Hc"               db={fmt(sig.hc)}                 calc={fmt(sig.hc)}                    formula="Heures créditées" />
                <Row label="Hcr"              db={fmt(sig.hcr_crew)}           calc={fmt(sig.hcr_crew)}              formula="Hcr crew (rotation entière)" />
                <Row label="TSVnuit (h)"      db={fmt(computed.tsvNuit)}       calc={fmt(computed.tsvNuit)}          formula="TSV entre 18h–6h locale départ" />
                <Row label="PVnuit"           db="—"                           calc={fmt(computed.pvNuit)}           formula="TSVnuit / 2" />
                <Row label="Hcr + PVnuit"     db="—"                           calc={fmt(computed.pvTotal)}          formula="Hcr + TSVnuit/2" />
                <Row label="Montant PV"       db="—"                           calc={`${Math.round(computed.montantPv)} €`} formula="(Hcr+PVnuit) × PVEI × KSP" highlight />
                <Row label="Prime bi-tronçon" db={sig.prime != null ? `×${sig.prime}` : '—'} calc={`${Math.round(computed.primeBT)} €`} formula={`${sig.prime ?? 0} × 2,5 × PVEI`} />
                <Row label="PV + Prime"       db="—"                           calc={`${Math.round(computed.pvPrime)} €`} formula="Montant PV + Prime" highlight />
                <Row label="ON"               db={String(sig.nb_on_days)}      calc={String(sig.nb_on_days)}         formula="nb_on_days" />
                <Row label="Escale"           db={sig.first_layover ?? '—'}    calc={sig.first_layover ?? '—'}       formula="first_layover" />
                <Row label="Zone"             db={sig.zone ?? '—'}             calc={sig.zone ?? '—'}                formula="Article 81 zone" />
                <Row label="A81"              db={sig.a81 ? 'Oui' : 'Non'}    calc={sig.a81 ? 'Oui' : 'Non'}       formula="TSV escale ≥ 24h" />
                <Row label="Temps séjour"     db={fmt(sig.temps_sej, 1)}       calc={fmt(sig.temps_sej, 1)}          formula="Durée entre 1er atterrissage et dernier décollage (h)" />
                <Row label="Repos avant"      db={fmt(sig.rest_before_h, 1)}   calc={fmt(sig.rest_before_h, 1)}      formula="Rest before haul (h)" />
                <Row label="Repos après"      db={fmt(sig.rest_after_h, 1)}    calc={fmt(sig.rest_after_h, 1)}       formula="Rest after haul (h)" />
              </tbody>
            </table>
          </div>

          <div className="text-xs text-zinc-400 bg-zinc-100 dark:bg-zinc-800/50 rounded-lg px-4 py-2.5">
            Calculs avec PVEI&nbsp;=&nbsp;{PVEI}&nbsp;€/h · KSP&nbsp;=&nbsp;{KSP} · Prime bi-tronçon&nbsp;=&nbsp;{(2.5 * PVEI).toFixed(2)}&nbsp;€
            <span className="ml-2 text-zinc-300 dark:text-zinc-500">(modifiables dans /profil)</span>
          </div>

          {/* Article 81 — défiscalisation par rotation */}
          {a81 && (
            <div className="bg-white dark:bg-zinc-900 rounded-xl border border-emerald-200 dark:border-emerald-900/50 overflow-hidden">
              <div className="px-4 py-2 bg-emerald-50 dark:bg-emerald-950/30 border-b border-emerald-100 dark:border-emerald-900/40 flex items-center justify-between">
                <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 uppercase tracking-wide">
                  Article 81 — Prime de séjour défiscalisée
                </p>
                <span className="text-[10px] text-emerald-600/70 dark:text-emerald-400/70">
                  zone {a81.zone} · valeur jour {valeurJour}€
                </span>
              </div>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  <Row label="tSej"                  db={fmt(a81.tSej, 2) + ' h'}                                                  calc={fmt(a81.tSej, 2) + ' h'}                                                          formula="Temps entre 1er atterrissage et dernier décollage" />
                  <Row label="tSej + 15 min"         db={fmt(a81.tSej + 15/60, 2) + ' h'}                                          calc={fmt(a81.tSej + 15/60, 2) + ' h'}                                                  formula="+15 min réglementaires (TSVP marge)" />
                  <Row label="tSej24"                db={a81.tSej24 > 0 ? `${a81.tSej24.toFixed(1)} j` : '—'}                       calc={a81.tSej24 > 0 ? `${a81.tSej24.toFixed(1)} j` : '—'}                                formula="ceil((tSej + 15min) / 24, 0.5) — 0 si < 24 h" />
                  <Row label="tauxSej"               db={a81.tauxSej != null ? `${(a81.tauxSej * 100).toFixed(0)} %` : '—'}        calc={a81.tauxSej != null ? `${(a81.tauxSej * 100).toFixed(0)} %` : '—'}                  formula={`Lookup matrice (zone ${a81.zone} × seuil ${(a81.tSej + 15/60).toFixed(2)}h)`} />
                  <Row label="Montant prime séjour" db="—"                                                                          calc={`${Math.round(a81.montantPrimeSej).toLocaleString('fr-FR')} €`}                       formula="valeurJour × tauxSej × tSej24" highlight />
                  <Row label="Montant / jour"        db="—"                                                                          calc={`${Math.round(a81.montantPrimeSejJour).toLocaleString('fr-FR')} €`}                   formula="valeurJour × tauxSej (montant pour 1 jour)" />
                </tbody>
              </table>
            </div>
          )}

          {/* Détail EP4 — feuille horaire + feuille décompte (port du pipeline Python) */}
          <Ep4Detail
            sigId={sig.id}
            rotationCode={sig.rotation_code ?? ''}
            zone={sig.zone}
            year={year}
            month={mo}
          />
        </div>
      )}
    </div>
  );
}

function Row({
  label, db, calc, formula, highlight,
}: {
  label: string;
  db: string | null | undefined;
  calc: string | null | undefined;
  formula: string;
  highlight?: boolean;
}) {
  return (
    <tr className={highlight ? 'bg-blue-50/50 dark:bg-blue-950/20' : ''}>
      <td className={`px-4 py-2 font-medium ${highlight ? 'text-zinc-900 dark:text-zinc-50' : 'text-zinc-700 dark:text-zinc-300'}`}>{label}</td>
      <td className="px-4 py-2 text-right font-mono text-zinc-600 dark:text-zinc-400">{db ?? '—'}</td>
      <td className={`px-4 py-2 text-right font-mono font-semibold ${highlight ? 'text-blue-600 dark:text-blue-400' : 'text-zinc-800 dark:text-zinc-200'}`}>{calc ?? '—'}</td>
      <td className="px-4 py-2 text-xs text-zinc-400 max-w-xs">{formula}</td>
    </tr>
  );
}
