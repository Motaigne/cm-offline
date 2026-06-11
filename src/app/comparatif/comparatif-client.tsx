'use client';

import { useState, useMemo, useEffect } from 'react';
import { PVEI as PVEI_DEFAULT, KSP as KSP_DEFAULT } from '@/lib/finance';
import { getRotationsForMonth } from '@/app/actions/search';
import { cacheRotations, loadRotationsFromDB, getCachedMonths } from '@/lib/local-db';
import type { RotationSignature } from '@/app/actions/search';
import { getEp4Detail } from '@/app/actions/ep4';
import { buildEp4Rotation } from '@/lib/ep4';
import type { Ep4Rotation, PairingDetail, TauxAppRow } from '@/lib/ep4';
import type { IrMfRate } from '@/lib/ir-rates';
import { computeArticle81, TAXI_TSEJ_ADJUST_H } from '@/lib/article81';
import type { Article81Data } from '@/lib/article81';
import { getPveiKspForMonth, getValeurJourForMonth, VALEUR_JOUR_DEFAULT, type AnnexeRow } from '@/lib/annexe';
import type { ProfileVersion } from '@/app/actions/profile-version';

type SigInstance = {
  id: string;
  depart_date: string;   // "YYYY-MM-DD"
  depart_at: string;     // ISO UTC (= scheduledBeginBlockDate)
  arrivee_at: string;    // ISO UTC (= scheduledEndBlockDate)
  /** Bornes du REPOS pré/post-courrier (PAS briefing/closeout). */
  scheduled_begin_activity_at?: string | null;
  scheduled_end_activity_at?: string | null;
  /** Briefing (= scheduledBeginDutyDate) / closeout (= scheduledEndDutyDate).
   *  Null pour les instances pre-mig 0034 sans raw_summary. */
  scheduled_begin_duty_at?: string | null;
  scheduled_end_duty_at?: string | null;
  rest_before_h?: number | null;
  rest_after_h?: number | null;
  /** Payload PairingSummary brut (JSONB) — chargé avec l'instance pour le
   *  panneau Metadata complète offline-first (pas de fetch online). */
  raw_summary?: unknown;
};

type Sig = {
  id: string;
  rotation_code: string | null;
  zone: string | null;
  aircraft_code: string;
  hc: number;
  hcr_crew: number;
  hdv: number | null;
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

function rotationMontant(sig: Sig, pvei: number, ksp: number): number {
  const pv    = (sig.hcr_crew + (sig.tsv_nuit ?? 0) / 2) * pvei * ksp;
  const prime = (sig.prime ?? 0) * 2.5 * pvei;
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
    hdv: s.hdv,
    tsv_nuit: s.tsv_nuit, prime: s.prime, nb_on_days: s.nb_on_days,
    first_layover: s.first_layover, layovers: s.layovers,
    rest_before_h: s.rest_before_h, rest_after_h: s.rest_after_h,
    a81: s.a81, temps_sej: s.temps_sej, dead_head: s.dead_head,
    mep_flight: s.mep_flight, peq: s.peq,
    instances: s.instances.map(i => ({
      id: i.id, depart_date: i.depart_date,
      depart_at: i.depart_at, arrivee_at: i.arrivee_at,
      rest_before_h: i.rest_before_h,
      rest_after_h:  i.rest_after_h,
      scheduled_begin_activity_at: (i as { scheduled_begin_activity_at?: string | null }).scheduled_begin_activity_at ?? null,
      scheduled_end_activity_at:   (i as { scheduled_end_activity_at?:   string | null }).scheduled_end_activity_at   ?? null,
      scheduled_begin_duty_at:     (i as { scheduled_begin_duty_at?:     string | null }).scheduled_begin_duty_at     ?? null,
      scheduled_end_duty_at:       (i as { scheduled_end_duty_at?:       string | null }).scheduled_end_duty_at       ?? null,
      raw_summary:                 (i as { raw_summary?: unknown }).raw_summary ?? null,
    })),
  };
}

export function ComparatifClient({
  signatures: initialSigs, months: initialMonths, currentMonth: initialMonth,
  article81Data,
  profileVersions = [], annexeRows = [],
  isAdmin = false,
}: {
  signatures: Sig[];
  months: string[];
  currentMonth: string;
  article81Data: Article81Data | null;
  profileVersions?: ProfileVersion[];
  annexeRows?: AnnexeRow[];
  isAdmin?: boolean;
}) {
  const [sigs, setSigs]           = useState<Sig[]>(initialSigs);
  const [months, setMonths]       = useState<string[]>(initialMonths);
  const [currentMonth, setMonth]  = useState(initialMonth);
  const [loading, setLoading]     = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [noCache, setNoCache]     = useState(false);
  const [query, setQuery]         = useState('');
  const [selected, setSelected]   = useState<string | null>(null);
  const [selectedInstanceIdx, setSelectedInstanceIdx] = useState(0);

  const [year, mo] = currentMonth.split('-').map(Number);

  // Restaure le dernier mois sélectionné dans le calendrier — sauf s'il
  // pointe vers un mois fictif (projection) non dispo en comparatif :
  // on reste alors sur currentMonth (= fallback SSR réel).
  useEffect(() => {
    const stored = localStorage.getItem('cm-selected-month');
    if (stored && stored !== currentMonth && months.includes(stored)) void loadMonth(stored);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadMonth(m: string) {
    setMonth(m);
    setFromCache(false); setNoCache(false); setSelected(null); setSelectedInstanceIdx(0);
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
  // Instance affichée dans le tableau EP4 / Metadata / A81 — alimente l'override
  // briefing/closeout passé à buildEp4Rotation. selectedInstanceIdx doit être
  // remis à 0 partout où on change `selected` (sélection sig / retour liste).
  const selectedInst = sig?.instances[selectedInstanceIdx] ?? sig?.instances[0] ?? null;

  // PVEI/KSP dérivés du profil utilisateur applicable au mois courant.
  // Fallback aux constantes par défaut si profil incomplet ou annexe absente.
  const { pvei, ksp } = useMemo(() => {
    const r = getPveiKspForMonth(profileVersions, annexeRows, currentMonth);
    return r ?? { pvei: PVEI_DEFAULT, ksp: KSP_DEFAULT };
  }, [profileVersions, annexeRows, currentMonth]);

  // Valeur Jour A81 par mois courant — fallback 600 si profil/annexe insuffisants.
  const valeurJour = useMemo(
    () => getValeurJourForMonth(profileVersions, annexeRows, currentMonth) ?? VALEUR_JOUR_DEFAULT,
    [profileVersions, annexeRows, currentMonth],
  );

  const a81 = useMemo(() => {
    if (!sig?.temps_sej || !sig.zone) return null;
    // sig.temps_sej = block-to-block (scraper, sans taxi) — cf TAXI_TSEJ_ADJUST_H.
    return computeArticle81({
      tSej: Number(sig.temps_sej) + TAXI_TSEJ_ADJUST_H,
      zone: sig.zone,
      valeurJour,
      data: article81Data,
    });
  }, [sig, valeurJour, article81Data]);

  // EP4 calculé pour la rotation sélectionnée — alimente les nouvelles lignes
  // (HV real, Tme, CMT, HCV, HCT, HCA, H1, H2HC, etc.) du tableau champ/valeur.
  // Le raw_detail est fetché 1 seule fois par sig ; ep4 est rebuilt en mémoire
  // quand selectedInst change (override bornes briefing/closeout par instance).
  const [ep4Data, setEp4Data] = useState<{
    raw_detail: PairingDetail; taux: TauxAppRow[]; irRates: IrMfRate[];
  } | null>(null);
  const [ep4Loading, setEp4Ld] = useState(false);
  const sigId   = sig?.id ?? null;
  const sigRot  = sig?.rotation_code ?? '';
  const sigZone = sig?.zone ?? null;

  useEffect(() => {
    if (!sigId) { setEp4Data(null); return; }
    let cancelled = false;
    setEp4Ld(true); setEp4Data(null);
    getEp4Detail(sigId)
      .then(res => {
        if (cancelled || 'error' in res) return;
        setEp4Data({ raw_detail: res.raw_detail, taux: res.taux, irRates: res.irRates });
      })
      .catch(() => { /* silencieux : les lignes EP4 afficheront '—' */ })
      .finally(() => { if (!cancelled) setEp4Ld(false); });
    return () => { cancelled = true; };
  }, [sigId]);

  // Build EP4 en mémoire quand selectedInst change. TA = briefing → closeout
  // (mig 0039) ; fallback Manex (1h45 / 30min) pour les instances sans
  // scheduled_*_duty_at. NB : `scheduled_*_activity_at` = bornes du repos
  // pré/post-courrier, PAS utilisable pour TA.
  const ep4: Ep4Rotation | null = useMemo(() => {
    if (!ep4Data || !selectedInst) return null;
    const MANEX_BRIEF_MS = 1.75 * 3_600_000;
    const MANEX_CLOSE_MS = 0.5  * 3_600_000;
    const depMs   = selectedInst.depart_at  ? new Date(selectedInst.depart_at).getTime()  : null;
    const arrMs   = selectedInst.arrivee_at ? new Date(selectedInst.arrivee_at).getTime() : null;
    const briefMs = selectedInst.scheduled_begin_duty_at ? new Date(selectedInst.scheduled_begin_duty_at).getTime()
                   : depMs != null ? depMs - MANEX_BRIEF_MS : null;
    const closeMs = selectedInst.scheduled_end_duty_at   ? new Date(selectedInst.scheduled_end_duty_at).getTime()
                   : arrMs != null ? arrMs + MANEX_CLOSE_MS : null;
    if (briefMs == null || closeMs == null) return null;
    const override = {
      beginActivityMs: briefMs, endActivityMs: closeMs,
      beginBlockMs: depMs ?? undefined, endBlockMs: arrMs ?? undefined,
    };
    return buildEp4Rotation(ep4Data.raw_detail, sigRot, sigZone, year, mo, ep4Data.taux, ep4Data.irRates, override);
  }, [ep4Data, selectedInst, sigRot, sigZone, year, mo]);

  const ep4RawDetail: unknown = ep4Data?.raw_detail ?? null;

  const computed = useMemo(() => {
    if (!sig) return null;
    const tsvNuit   = sig.tsv_nuit ?? 0;
    const prime     = sig.prime ?? 0;
    const pvNuit    = tsvNuit / 2;
    // HCr canonique = ep4.H2HCr (= rtHDV × max(HCA, ΣH1r), basé sur les bornes
    // briefing/closeout de l'instance affichée via override). Fallback à
    // sig.hcr_crew (DB) tant que EP4 n'est pas chargé — pour les sigs splittées
    // ce fallback est faux (valeur héritée du raw_detail original) mais limité
    // à la fenêtre de chargement.
    const hcr       = ep4?.H2HCr ?? sig.hcr_crew;
    const pvTotal   = hcr + pvNuit;
    const montantPv = pvTotal * pvei * ksp;
    const primeBT   = prime * 2.5 * pvei;
    const pvPrime   = montantPv + primeBT;
    return { tsvNuit, pvNuit, pvTotal, montantPv, primeBT, pvPrime, hcr };
  }, [sig, pvei, ksp, ep4]);

  // Agrégats rotation depuis EP4 (sum across services/legs).
  const ep4Agg = useMemo(() => {
    if (!ep4) return null;
    const sumHV100  = ep4.services.reduce((s, svc) => s + svc.legs.reduce((ss, l) => ss + l.hv100,  0), 0);
    const sumHV100r = ep4.services.reduce((s, svc) => s + svc.legs.reduce((ss, l) => ss + l.hv100r, 0), 0);
    const sumHCV    = ep4.services.reduce((s, svc) => s + svc.HCV,  0);
    const sumHCVr   = ep4.services.reduce((s, svc) => s + svc.HCVr, 0);
    const sumHCT    = ep4.services.reduce((s, svc) => s + svc.HCT,  0);
    const sumH1     = ep4.services.reduce((s, svc) => s + svc.H1,   0);
    const sumH1r    = ep4.services.reduce((s, svc) => s + svc.H1r,  0);
    const sumTSVn   = ep4.services.reduce((s, svc) => s + svc.tsv_nuit, 0);
    const tmePerSvc = ep4.services.map(s => s.TME.toFixed(2).replace('.', ',')).join(' / ');
    const cmtPerSvc = ep4.services.map(s => s.CMT.toFixed(2).replace('.', ',')).join(' / ');
    return { sumHV100, sumHV100r, sumHCV, sumHCVr, sumHCT, sumH1, sumH1r, sumTSVn, tmePerSvc, cmtPerSvc };
  }, [ep4]);

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
            const montant = rotationMontant(s, pvei, ksp);
            return (
              <button
                key={s.id}
                onClick={() => { setSelected(s.id); setSelectedInstanceIdx(0); }}
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
              onClick={() => { setSelected(null); setSelectedInstanceIdx(0); }}
              className="text-xs text-zinc-400 hover:text-zinc-600 px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700"
            >
              ← Autre rotation
            </button>
          </div>

          {/* Disponibilités + HCr mois — lignes cliquables = sélecteur d'instance
              pour les blocs EP4 / Metadata / A81 ci-dessous (multi-instances avec
              briefing/closeout différents → TA, HCA, H2HCr propres à l'instance). */}
          {sig.instances.length > 0 && (
            <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
              <div className="px-4 py-2 bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
                <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide">
                  Disponibilités — {monthLabel(currentMonth)}
                </p>
                {sig.instances.length > 1 && (
                  <p className="text-[10px] text-zinc-400 italic">Cliquer une ligne pour la sélectionner</p>
                )}
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
                  {sig.instances.map((inst, idx) => {
                    // HCr canonique = ep4.H2HCr (fallback sig.hcr_crew tant que EP4
                    // pas chargé). Critique pour les sigs splittées dont sig.hcr_crew
                    // est hérité du raw_detail original (durée différente).
                    // NB : ep4.H2HCr est calculé pour l'instance sélectionnée — les
                    // autres lignes utilisent cette même valeur proratisée à leurs
                    // dates. Pour la "vraie" valeur d'une autre instance, cliquer
                    // dessus (sélecteur).
                    const hcrTotal = ep4?.H2HCr ?? sig.hcr_crew;
                    const hcrMois  = prorateForMonth(hcrTotal, inst.depart_at, inst.arrivee_at, year, mo);
                    const tsvMois  = prorateForMonth(sig.tsv_nuit ?? 0, inst.depart_at, inst.arrivee_at, year, mo);
                    const pvMois   = (hcrMois + tsvMois / 2) * pvei * ksp;
                    const eurMois  = Math.round(pvMois + (sig.prime ?? 0) * 2.5 * pvei);
                    const isProrated = hcrMois < hcrTotal - 0.01;
                    const isSelected = idx === selectedInstanceIdx && sig.instances.length > 1;
                    return (
                      <tr
                        key={inst.id}
                        onClick={() => setSelectedInstanceIdx(idx)}
                        className={`cursor-pointer transition-colors ${
                          isSelected
                            ? 'bg-blue-50 dark:bg-blue-950/30'
                            : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/40'
                        }`}
                      >
                        <td className="px-4 py-1.5 font-mono text-zinc-700 dark:text-zinc-300">
                          {isSelected && <span className="text-blue-500 mr-1">▸</span>}
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
                <Row label="Rotation" db={sig.rotation_code} calc={sig.rotation_code} formula="—" />

                {ep4Loading && <Row label="EP4" db="—" calc="Chargement…" formula="(en attente du raw_detail)" />}

                {!ep4Loading && ep4 && ep4Agg && (() => {
                  const sumTdv  = ep4.services.reduce((s, svc) => s + svc.legs.reduce((ss, l) => ss + l.tdv_troncon, 0), 0);
                  const pvNuit_db   = (sig.tsv_nuit ?? 0) / 2;
                  const pvNuit_mois = ep4.tsv_n_rot_m / 2;
                  const montantHCr_init  = ep4.H2HCr_initial * pvei * ksp;
                  const montantHCr_mois  = ep4.H2HCr * pvei * ksp;
                  const montantNuit_init = pvNuit_db   * pvei * ksp;
                  const montantNuit_mois = pvNuit_mois * pvei * ksp;
                  const hcrPlusPVn_init  = ep4.H2HCr_initial + pvNuit_db;
                  const hcrPlusPVn_mois  = ep4.H2HCr        + pvNuit_mois;
                  const montantRot_init  = montantHCr_init + montantNuit_init;
                  const montantRot_mois  = montantHCr_mois + montantNuit_mois;
                  const primeBT          = (sig.prime ?? 0) * 2.5 * pvei;
                  const montantTotal_init = montantRot_init + primeBT;
                  const montantTotal_mois = montantRot_mois + primeBT;
                  const eur = (n: number) => `${Math.round(n).toLocaleString('fr-FR')} €`;
                  return (
                    <>
                      <Row label="HV réal." db="—" calc={fmt(sumTdv)} formula="Σ legs.tdv_troncon (= arr_ms − dep_ms ; tdv_ref = tdv_real pour l'instant)" />

                      {ep4.services.map((svc, i) => (
                        <Row key={`tme-${i}`} label={`Tme svc ${i + 1}`} db="—" calc={fmt(svc.TME)} formula="max(1, Σ tdv_troncon / nb_tronçons)" />
                      ))}
                      {ep4.services.map((svc, i) => (
                        <Row key={`cmt-${i}`} label={`CMT svc ${i + 1}`} db="—" calc={fmt(svc.CMT)} formula="TME ≤ 2 ? 70/(21·TME+30) : 1" />
                      ))}

                      <Row label="HV100" db="—" calc={fmt(ep4Agg.sumHV100)} formula="Σ legs.hv100 (= TDV tronçon)" />

                      {ep4.services.map((svc, i) => (
                        <Row key={`hcv-${i}`} label={`HCV svc ${i + 1}`} db="—" calc={fmt(svc.HCV)} formula="(Σ tdv_norm + Σ tdv_MEP / 2) × CMT" />
                      ))}
                      {ep4.services.map((svc, i) => (
                        <Row key={`hct-${i}`} label={`HCT svc ${i + 1}`} db="—" calc={fmt(svc.HCT)} formula="TSV / 1,75" />
                      ))}

                      <Row label="TA"  db="—" calc={fmt(ep4.TA) + ' h'}  formula="scheduledEndDutyDate − scheduledBeginDutyDate (mig 0039)" />
                      <Row label="HCA" db="—" calc={fmt(ep4.HCA) + ' h'} formula="TA × 5/24" />

                      {ep4.services.map((svc, i) => (
                        <Row key={`h1-${i}`} label={`H1 svc ${i + 1}`} db="—" calc={fmt(svc.H1)} formula="max(HCV, HCT)" />
                      ))}

                      <Row label="rtHDV"        db="—"           calc={fmt(ep4.rtHDV, 4)}      formula="Σ HCVmoisM / Σ HCV" />
                      <Row label="H2HC (Hc)"    db={fmt(sig.hc)} calc={fmt(ep4.H2HC_initial)} formula="max(HCA, Σ H1) — avant proratisation mois" />
                      <Row label="H2HC mois"    db="—"           calc={fmt(ep4.H2HC)}         formula="rtHDV × max(HCA, Σ H1)" />

                      <Row label="HV100r" db="—" calc={fmt(ep4Agg.sumHV100r)} formula="Σ legs.hv100r (= tdv_troncon + 0,58)" />

                      {ep4.services.map((svc, i) => (
                        <Row key={`hcvr-${i}`} label={`HCVr svc ${i + 1}`} db="—" calc={fmt(svc.HCVr)} formula="(Σ hv100r_norm + Σ hv100r_MEP / 2) × CMT" />
                      ))}
                      {ep4.services.map((svc, i) => (
                        <Row key={`h1r-${i}`} label={`H1r svc ${i + 1}`} db="—" calc={fmt(svc.H1r)} formula="max(HCVr, HCT)" />
                      ))}

                      <Row label="H2HCr (HCr)" db={fmt(sig.hcr_crew)} calc={fmt(ep4.H2HCr_initial)} formula="max(HCA, Σ H1r)" />
                      <Row label="H2HCr mois"  db="—"                 calc={fmt(ep4.H2HCr)}         formula="rtHDV × max(HCA, Σ H1r)" />

                      <Row label="Montant HCr"      db="—" calc={eur(montantHCr_init)} formula="H2HCr_initial × PVEI × KSP" />
                      <Row label="Montant HCr mois" db="—" calc={eur(montantHCr_mois)} formula="H2HCr × PVEI × KSP" />

                      <Row label="TSVnuit"     db={fmt(sig.tsv_nuit)} calc={fmt(ep4.tsv_n_rot_m)} formula="Σ svc.tsv_n_ser_m (proraté mois)" />
                      <Row label="Majo Nuit"   db={fmt(pvNuit_db)}    calc={fmt(pvNuit_mois)}     formula="TSVnuit / 2" />
                      <Row label="Montant Nuit"      db="—" calc={eur(montantNuit_init)} formula="Majo Nuit (initial) × PVEI × KSP" />
                      <Row label="Montant Nuit mois" db="—" calc={eur(montantNuit_mois)} formula="Majo Nuit (mois) × PVEI × KSP" />

                      <Row
                        label="HCr + PVnuit mois / HCr + PVnuit"
                        db={fmt(sig.hcr_crew + pvNuit_db)}
                        calc={`${fmt(hcrPlusPVn_mois)} / ${fmt(hcrPlusPVn_init)}`}
                        formula="H2HCr + Majo Nuit (mois) / H2HCr_initial + Majo Nuit (initial)"
                      />
                      <Row
                        label="montantRot mois / montantRot"
                        db={eur((sig.hcr_crew + pvNuit_db) * pvei * ksp)}
                        calc={`${eur(montantRot_mois)} / ${eur(montantRot_init)}`}
                        formula="Montant HCr + Montant Nuit (mois / initial)"
                        highlight
                      />

                      <Row label="Prime bi-tronçon" db={sig.prime != null ? `×${sig.prime}` : '—'} calc={eur(primeBT)} formula={`${sig.prime ?? 0} × 2,5 × PVEI`} />

                      <Row
                        label="montantTotal mois / montantTotal"
                        db="—"
                        calc={`${eur(montantTotal_mois)} / ${eur(montantTotal_init)}`}
                        formula="montantRot + Prime bi-tronçon (mois / initial)"
                        highlight
                      />
                    </>
                  );
                })()}
              </tbody>
            </table>
          </div>

          <div className="text-xs text-zinc-400 bg-zinc-100 dark:bg-zinc-800/50 rounded-lg px-4 py-2.5">
            Calculs avec PVEI&nbsp;=&nbsp;{pvei.toFixed(2)}&nbsp;€/h · KSP&nbsp;=&nbsp;{ksp} · Prime bi-tronçon&nbsp;=&nbsp;{(2.5 * pvei).toFixed(2)}&nbsp;€
            <span className="ml-2 text-zinc-300 dark:text-zinc-500">(profil applicable au mois)</span>
          </div>

          {/* Article 81 — toujours visible (escale/zone/tSej en haut, calcs A81 si éligible) */}
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-emerald-200 dark:border-emerald-900/50 overflow-hidden">
            <div className="px-4 py-2 bg-emerald-50 dark:bg-emerald-950/30 border-b border-emerald-100 dark:border-emerald-900/40 flex items-center justify-between">
              <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 uppercase tracking-wide">
                Article 81 — Prime de séjour défiscalisée
              </p>
              {a81 && (
                <span className="text-[10px] text-emerald-600/70 dark:text-emerald-400/70">
                  zone {a81.zone} · valeur jour {valeurJour}€
                </span>
              )}
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                <Row label="Escale"       db={sig.first_layover ?? '—'}                            calc="—"                                                  formula="first_layover" />
                <Row label="Zone"         db={sig.zone ?? '—'}                                      calc="—"                                                  formula="Article 81 zone" />
                <Row label="A81"          db={sig.a81 ? 'Oui' : 'Non'}                              calc="—"                                                  formula="TSV escale ≥ 24h" />
                {(() => {
                  const inst = selectedInst;
                  if (!inst || sig.hdv == null) return (
                    <Row label="Temps séjour" db={fmt(sig.temps_sej, 1) + ' h'} calc="—" formula="(arrivee_at − depart_at) / 1h − HDV (par instance)" />
                  );
                  const totalBlock  = (new Date(inst.arrivee_at).getTime() - new Date(inst.depart_at).getTime()) / 3_600_000;
                  const tSejFormula = totalBlock - sig.hdv;
                  const delta       = tSejFormula - (sig.temps_sej ?? 0);
                  const warn        = Math.abs(delta) > 0.25;
                  return (
                    <Row
                      label="Temps séjour"
                      db={fmt(sig.temps_sej, 1) + ' h'}
                      calc={`${fmt(tSejFormula, 1)} h${warn ? `  ⚠ Δ ${delta > 0 ? '+' : ''}${delta.toFixed(1)}h` : ''}`}
                      formula="(arrivee_at − depart_at) / 1h − HDV (par instance)"
                      warn={warn}
                    />
                  );
                })()}
                {a81 ? (
                  <>
                    <Row label="tSej + 15 min"        db={fmt(a81.tSej + 15/60, 2) + ' h'}                                          calc={fmt(a81.tSej + 15/60, 2) + ' h'}                                                  formula="+15 min réglementaires (TSVP marge)" />
                    <Row label="tSej24"               db={a81.tSej24 > 0 ? `${a81.tSej24.toFixed(1)} j` : '—'}                       calc={a81.tSej24 > 0 ? `${a81.tSej24.toFixed(1)} j` : '—'}                                formula="ceil((tSej + 15min) / 24, 0.5) — 0 si < 24 h" />
                    <Row label="tauxSej"              db={a81.tauxSej != null ? `${(a81.tauxSej * 100).toFixed(0)} %` : '—'}        calc={a81.tauxSej != null ? `${(a81.tauxSej * 100).toFixed(0)} %` : '—'}                  formula={`Lookup matrice (zone ${a81.zone} × seuil ${(a81.tSej + 15/60).toFixed(2)}h)`} />
                    <Row label="Montant prime séjour" db="—"                                                                          calc={`${Math.round(a81.montantPrimeSej).toLocaleString('fr-FR')} €`}                       formula="valeurJour × tauxSej × tSej24" highlight />
                    <Row label="Montant / jour"       db="—"                                                                          calc={`${Math.round(a81.montantPrimeSejJour).toLocaleString('fr-FR')} €`}                   formula="valeurJour × tauxSej (montant pour 1 jour)" />
                  </>
                ) : (
                  <tr><td colSpan={4} className="px-4 py-2 text-xs text-zinc-400 italic">Rotation non éligible A81 (tSej &lt; 24h ou zone non éligible)</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Metadata — timestamps, repos, ON, TSV nuit par service */}
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
            <div className="px-4 py-2 bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-100 dark:border-zinc-800">
              <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wide">Metadata</p>
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {(() => {
                  const inst    = selectedInst;
                  const fmtIso  = (s: string | null | undefined) => s ? new Date(s).toISOString().replace('T', ' ').slice(0, 16) : '—';
                  const restBeforeCalc = inst?.scheduled_begin_activity_at && inst.depart_at
                    ? (new Date(inst.depart_at).getTime() - new Date(inst.scheduled_begin_activity_at).getTime()) / 3_600_000
                    : null;
                  const restAfterCalc = inst?.scheduled_end_activity_at && inst.arrivee_at
                    ? (new Date(inst.scheduled_end_activity_at).getTime() - new Date(inst.arrivee_at).getTime()) / 3_600_000
                    : null;
                  return (
                    <>
                      <Row label="ON" db={String(sig.nb_on_days)} calc={ep4 ? String(ep4.ON) : '—'} formula="nb jours UTC entre 1er block-off et dernier block-on" />
                      <Row label="Repos avant (h)" db={ep4 ? fmt(ep4.restBeforeHaul, 1) : '—'} calc={restBeforeCalc != null ? fmt(restBeforeCalc, 1) : fmt(inst?.rest_before_h, 1)} formula="DB = pairingDetail.restBeforeHaulDuration ; calc = (block-off − scheduledBeginActivityDate) / 1h" />
                      <Row label="Repos après (h)"  db={ep4 ? fmt(ep4.restPostHaul, 1) : '—'} calc={restAfterCalc  != null ? fmt(restAfterCalc, 1)  : fmt(inst?.rest_after_h, 1)}  formula="DB = pairingDetail.restPostHaulDuration ; calc = (scheduledEndActivityDate − block-on) / 1h" />
                      <Row label="scheduledBeginActivityDate" db={fmtIso(inst?.scheduled_begin_activity_at)} calc="—" formula="début du repos pré-courrier (PAS briefing)" />
                      <Row label="scheduledBeginDutyDate"     db={fmtIso(inst?.scheduled_begin_duty_at)}     calc="—" formula="briefing (mig 0039)" />
                      <Row label="scheduledBeginBlockDate"    db={fmtIso(inst?.depart_at)}                   calc="—" formula="block-off 1er leg (depart_at)" />
                      <Row label="scheduledEndBlockDate"      db={fmtIso(inst?.arrivee_at)}                  calc="—" formula="block-on dernier leg (arrivee_at)" />
                      <Row label="scheduledEndDutyDate"       db={fmtIso(inst?.scheduled_end_duty_at)}       calc="—" formula="closeout (mig 0039)" />
                      <Row label="scheduledEndActivityDate"   db={fmtIso(inst?.scheduled_end_activity_at)}   calc="—" formula="fin du repos post-courrier (PAS closeout)" />
                      {ep4 && ep4.services.map((svc, i) => (
                        <Row key={`tsvnj-${i}`} label={`TSVnuit J svc ${i + 1}`} db="—" calc={fmt(svc.tsv_nuit_j, 2)} formula="tsvNuitJ(dep_loc_h, block_block) — nuit jour J du tronçon" />
                      ))}
                      {ep4 && ep4.services.map((svc, i) => (
                        <Row key={`tsvnj1-${i}`} label={`TSVnuit J+1 svc ${i + 1}`} db="—" calc={fmt(svc.tsv_nuit_j1, 2)} formula="tsvNuitJ1(dep_loc_h, block_block) — nuit jour J+1" />
                      ))}
                      {ep4 && ep4.services.map((svc, i) => (
                        <Row key={`tsvns-${i}`} label={`TSVnuit S svc ${i + 1}`} db="—" calc={fmt(svc.tsv_nuit, 2)} formula="tsv_nuit_j + tsv_nuit_j1" />
                      ))}
                      {ep4 && ep4.services.map((svc, i) => (
                        <Row key={`tsvnsm-${i}`} label={`TSVnuit Sm svc ${i + 1}`} db="—" calc={fmt(svc.tsv_n_ser_m, 2)} formula="tsv_nuit proraté mois M (0 si dead-head)" />
                      ))}
                    </>
                  );
                })()}
              </tbody>
            </table>
          </div>

          {/* Metadata complète admin — raw_summary (offline, depuis sig) +
              raw_detail (online via EP4, exempté offline). */}
          {isAdmin && (
            <AdminMetadataPanel
              instances={sig.instances}
              rawDetail={ep4RawDetail}
              rawDetailLoading={ep4Loading}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  label, db, calc, formula, highlight, warn,
}: {
  label: string;
  db: string | null | undefined;
  calc: string | null | undefined;
  formula: string;
  highlight?: boolean;
  warn?: boolean;
}) {
  const rowBg  = warn ? 'bg-red-50/50 dark:bg-red-950/20' : (highlight ? 'bg-blue-50/50 dark:bg-blue-950/20' : '');
  const labelC = warn ? 'text-red-700 dark:text-red-300' : (highlight ? 'text-zinc-900 dark:text-zinc-50' : 'text-zinc-700 dark:text-zinc-300');
  const calcC  = warn ? 'text-red-600 dark:text-red-400' : (highlight ? 'text-blue-600 dark:text-blue-400' : 'text-zinc-800 dark:text-zinc-200');
  return (
    <tr className={rowBg}>
      <td className={`px-4 py-2 font-medium ${labelC}`}>{label}</td>
      <td className="px-4 py-2 text-right font-mono text-zinc-600 dark:text-zinc-400">{db ?? '—'}</td>
      <td className={`px-4 py-2 text-right font-mono font-semibold ${calcC}`}>{calc ?? '—'}</td>
      <td className="px-4 py-2 text-xs text-zinc-400 max-w-xs">{formula}</td>
    </tr>
  );
}

// ─── Panneau admin : raw_summary + raw_detail bruts CrewBidd ────────────────
// raw_summary vient directement de sig.instances[].raw_summary (chargé avec
// la sig → offline-first, dispo sans connexion). raw_detail vient de l'EP4
// fetch (exempté offline par la règle de base).
function AdminMetadataPanel({ instances, rawDetail, rawDetailLoading }: {
  instances: SigInstance[];
  rawDetail: unknown;
  rawDetailLoading: boolean;
}) {
  const [openInst, setOpenInst]   = useState<number>(0);
  const [openDetail, setOpenDetail] = useState<boolean>(false);
  const insts = instances ?? [];
  const inst  = insts[openInst] ?? null;
  const rawSummary = inst?.raw_summary as Record<string, unknown> | null;
  const rawDetailObj = rawDetail as Record<string, unknown> | null;
  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-amber-200 dark:border-amber-900/50 overflow-hidden">
      <div className="px-4 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-100 dark:border-amber-900/40">
        <p className="text-[11px] font-semibold text-amber-700 dark:text-amber-300 uppercase tracking-wide">
          Metadata complète (admin) — payloads CrewBidd bruts
        </p>
      </div>

      {/* raw_summary par instance */}
      <div className="px-4 py-2 border-b border-zinc-100 dark:border-zinc-800">
        <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide mb-1">
          raw_summary (PairingSummary)
        </p>
        {insts.length > 1 && (
          <div className="flex gap-1 flex-wrap mb-2">
            {insts.map((i, idx) => (
              <button
                key={i.id}
                onClick={() => setOpenInst(idx)}
                className={`text-[10px] px-2 py-0.5 rounded font-mono ${
                  openInst === idx
                    ? 'bg-amber-200 dark:bg-amber-900/60 text-amber-900 dark:text-amber-100'
                    : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:bg-zinc-200'
                }`}
              >
                {new Date(i.depart_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', timeZone: 'Europe/Paris' })}
              </button>
            ))}
          </div>
        )}
        {rawSummary ? <FlatJsonTable obj={rawSummary} /> : <p className="text-xs text-zinc-400 italic">raw_summary absent (sig pre-mig 0034 ou _raw non capturé)</p>}
      </div>

      {/* raw_detail (PairingDetail) — collapsible parce que volumineux */}
      <div className="px-4 py-2">
        <button
          onClick={() => setOpenDetail(o => !o)}
          className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide flex items-center gap-1 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          {openDetail ? '▼' : '▶'} raw_detail (PairingDetail signature){' '}
          <span className="text-[9px] text-zinc-300 dark:text-zinc-500 normal-case font-normal">— online uniquement (exempté offline)</span>
        </button>
        {openDetail && rawDetailLoading && <p className="mt-2 text-xs text-zinc-400 italic">Chargement…</p>}
        {openDetail && !rawDetailLoading && rawDetailObj && (
          <div className="mt-2 space-y-2">
            <div>
              <p className="text-[10px] font-semibold text-zinc-400 mb-1">Niveau rotation (clés top + pairingValue[0])</p>
              <FlatJsonTable obj={{
                ...Object.fromEntries(Object.entries(rawDetailObj).filter(([k]) => k !== 'flightDuty' && k !== 'pairingValue' && k !== 'serviceRest')),
                ...((rawDetailObj.pairingValue as Array<Record<string, unknown>>)?.[0] ?? {}),
              }} />
            </div>
            <div>
              <p className="text-[10px] font-semibold text-zinc-400 mb-1">flightDuty[] (résumé par service)</p>
              <pre className="text-[10px] font-mono bg-zinc-50 dark:bg-zinc-800/60 rounded p-2 overflow-x-auto max-h-64">
                {JSON.stringify(rawDetailObj.flightDuty, null, 2)}
              </pre>
            </div>
          </div>
        )}
        {openDetail && !rawDetailLoading && !rawDetailObj && <p className="mt-2 text-xs text-zinc-400 italic">raw_detail non chargé (offline ? ou erreur EP4)</p>}
      </div>
    </div>
  );
}

function FlatJsonTable({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
  const fmtVal = (v: unknown): string => {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'number') {
      // Heuristique : timestamps ms epoch entre 1990 et 2050 → format date
      if (v > 631_152_000_000 && v < 2_524_608_000_000) {
        return `${v} (${new Date(v).toISOString().replace('T', ' ').slice(0, 16)})`;
      }
      return String(v);
    }
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string')  return v;
    return JSON.stringify(v);
  };
  return (
    <table className="w-full text-[11px] font-mono">
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {entries.map(([k, v]) => (
          <tr key={k}>
            <td className="px-2 py-0.5 text-zinc-500 dark:text-zinc-400 align-top w-1/3">{k}</td>
            <td className="px-2 py-0.5 text-zinc-800 dark:text-zinc-200 break-all">{fmtVal(v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
