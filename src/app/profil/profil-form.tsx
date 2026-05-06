'use client';

import { useState, useMemo, useTransition } from 'react';
import { saveProfile, type ProfileData } from '@/app/actions/profile';
import { computeFullProfile, KSP, type AnnexeData } from '@/lib/annexe';
import type { Database, Tables } from '@/types/supabase';

type FonctionEnum = Database['public']['Enums']['fonction_enum'];
type RegimeEnum   = Database['public']['Enums']['regime_enum'];
type ProfileRow   = Tables<'user_profile'>;

const FONCTIONS: { value: FonctionEnum; label: string }[] = [
  { value: 'CDB',     label: 'CDB' },
  { value: 'OPL',     label: 'OPL' },
  { value: 'TRI_CDB', label: 'TRI CDB' },
  { value: 'TRI_OPL', label: 'TRI OPL' },
];

const REGIME_LABELS: Record<RegimeEnum, string> = {
  TP:          'Temps plein',
  TAF7_10_12:  'TAF 7j × 10 mois',
  TAF7_12_12:  'TAF 7j × 12 mois',
  TAF10_10_12: 'TAF 10j × 10 mois',
  TAF10_12_12: 'TAF 10j × 12 mois',
  TTA92:       'TTA 92 %',
  TTA83:       'TTA 83 %',
  TTA75:       'TTA 75 %',
};

// Nb de 30ème typique par régime (base de calcul mensuel)
const REGIME_NB30E: Record<RegimeEnum, number> = {
  TP:          30,
  TAF7_10_12:  23,
  TAF7_12_12:  23,
  TAF10_10_12: 20,
  TAF10_12_12: 20,
  TTA92:       28,
  TTA83:       25,
  TTA75:       23,
};

// Fraction de mois travaillés dans l'année pour les régimes TAF
const REGIME_MOIS12: Partial<Record<RegimeEnum, number>> = {
  TAF7_10_12:  10,
  TAF7_12_12:  12,
  TAF10_10_12: 10,
  TAF10_12_12: 12,
};

const REGIMES    = Object.keys(REGIME_LABELS) as RegimeEnum[];
const AVIONS     = ['A335', 'A350', 'B787', 'B777'];
const CATEGORIES = ['A', 'B', 'C'];
const TRANSPORTS = ['Navigo', 'Voiture'];

export function ProfilForm({
  initialData,
  isNew,
  annexe,
}: {
  initialData?: ProfileRow;
  isNew: boolean;
  annexe: Partial<AnnexeData>;
}) {
  const [fonction,  setFonction]  = useState<FonctionEnum | ''>(initialData?.fonction ?? '');
  const [regime,    setRegime]    = useState<RegimeEnum   | ''>(initialData?.regime   ?? '');
  const [classe,    setClasse]    = useState(initialData?.classe?.toString()  ?? '2');
  const [categorie, setCategorie] = useState(initialData?.categorie           ?? 'C');
  const [echelon,   setEchelon]   = useState(initialData?.echelon?.toString() ?? '4');
  const [bonusAtpl, setBonusAtpl] = useState(initialData?.bonus_atpl          ?? false);
  const [transport, setTransport] = useState(initialData?.transport           ?? '');
  const [aircraft,  setAircraft]  = useState(initialData?.aircraft_principal  ?? 'A335');
  const [cngPv,     setCngPv]     = useState(String(initialData?.cng_pv       ?? 0));
  const [cngHs,     setCngHs]     = useState(String(initialData?.cng_hs       ?? 0));

  const [saved,     setSaved]     = useState(false);
  const [err,       setErr]       = useState('');
  const [isPending, start]        = useTransition();

  // ── Calcul live des éléments de paie ───────────────────────────────────────
  const computed = useMemo(() => {
    const hasAnnexe = !!(
      annexe.cat_anciennete?.length &&
      annexe.coef_classe?.length &&
      annexe.taux_avion?.length &&
      annexe.traitement_base
    );
    if (!hasAnnexe || !fonction) return null;

    const nb30e = regime ? REGIME_NB30E[regime as RegimeEnum] : 23;
    const cl    = parseInt(classe)   || 2;
    const ech   = parseInt(echelon)  || 4;

    return computeFullProfile(
      aircraft,
      fonction,
      cl,
      categorie,
      ech,
      bonusAtpl,
      nb30e,
      'LC',
      null,
      null,
      annexe as AnnexeData,
    );
  }, [annexe, fonction, regime, aircraft, classe, categorie, echelon, bonusAtpl]);

  function handleSave() {
    if (!fonction || !regime) return;
    setErr(''); setSaved(false);
    const data: ProfileData = {
      fonction:           fonction as FonctionEnum,
      regime:             regime   as RegimeEnum,
      qualifs_avion:      [],
      classe:             classe   !== '' ? Number(classe)  : null,
      categorie:          categorie || null,
      echelon:            echelon  !== '' ? Number(echelon) : null,
      bonus_atpl:         bonusAtpl,
      transport:          transport || null,
      aircraft_principal: aircraft,
      cng_pv:             parseFloat(cngPv) || 0,
      cng_hs:             parseFloat(cngHs) || 0,
    };
    start(async () => {
      const res = await saveProfile(data);
      if (res && 'error' in res) setErr(res.error ?? 'Erreur inconnue');
      else { setSaved(true); setTimeout(() => setSaved(false), 3000); }
    });
  }

  const canSave = !!fonction && !!regime;

  return (
    <div className="space-y-6">

      {/* Fonction */}
      <Section label="Fonction">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {FONCTIONS.map(({ value, label }) => (
            <button key={value} type="button" onClick={() => setFonction(value)} className={pill(fonction === value)}>
              {label}
            </button>
          ))}
        </div>
      </Section>

      {/* Régime */}
      <Section label="Régime">
        <select value={regime} onChange={e => setRegime(e.target.value as RegimeEnum)} className={input}>
          <option value="" disabled>Choisir…</option>
          {REGIMES.map(r => <option key={r} value={r}>{REGIME_LABELS[r]}</option>)}
        </select>
      </Section>

      {/* Ancienneté */}
      <Section label="Ancienneté">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Classe (1–5)</label>
            <input type="number" min={1} max={5} value={classe}
              onChange={e => setClasse(e.target.value)} className={input} />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Catégorie</label>
            <select value={categorie} onChange={e => setCategorie(e.target.value)} className={input}>
              <option value="">—</option>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Échelon (1–10)</label>
            <input type="number" min={1} max={10} value={echelon}
              onChange={e => setEchelon(e.target.value)} className={input} />
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer select-none mt-3">
          <input type="checkbox" checked={bonusAtpl} onChange={e => setBonusAtpl(e.target.checked)} className="w-4 h-4 rounded" />
          <span className="text-sm">Bonus ATPL (+0,06)</span>
        </label>
      </Section>

      {/* Avion */}
      <Section label="Avion">
        <div className="flex flex-wrap gap-2">
          {AVIONS.map(av => (
            <button key={av} type="button" onClick={() => setAircraft(av)} className={pill(aircraft === av)}>
              {av}
            </button>
          ))}
        </div>
      </Section>

      {/* Congés */}
      <Section label="Congés (source EP4)">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">CNG.PV (€)</label>
            <input type="number" step="0.01" value={cngPv}
              onChange={e => setCngPv(e.target.value)} placeholder="495.06" className={input} />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">CNG.HS (€)</label>
            <input type="number" step="0.01" value={cngHs}
              onChange={e => setCngHs(e.target.value)} placeholder="27.02" className={input} />
          </div>
        </div>
      </Section>

      {/* Transport */}
      <Section label="Transport (optionnel)">
        <div className="flex flex-wrap gap-2">
          {['', ...TRANSPORTS].map(t => (
            <button key={t} type="button" onClick={() => setTransport(t)} className={pill(transport === t)}>
              {t || '—'}
            </button>
          ))}
        </div>
      </Section>

      {err && <p className="text-sm text-red-500">{err}</p>}

      <button type="button" onClick={handleSave} disabled={isPending || !canSave}
        className="w-full rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2.5 text-sm font-semibold hover:opacity-80 disabled:opacity-40 transition-opacity">
        {saved ? '✓ Enregistré' : isPending ? 'Enregistrement…' : isNew ? 'Créer mon profil' : 'Enregistrer'}
      </button>

      {/* ── Éléments de paie calculés (live) ─────────────────────────────── */}
      {computed && (
        <div className="pt-2 border-t border-zinc-200 dark:border-zinc-700 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
            Éléments de paie
            <span className="ml-2 font-normal normal-case text-zinc-300 dark:text-zinc-600">
              · {aircraft}
              {regime && ` · ${REGIME_NB30E[regime as RegimeEnum]}/30`}
              {regime && REGIME_MOIS12[regime as RegimeEnum] !== undefined && (
                <span className="text-zinc-400 dark:text-zinc-500"> · {REGIME_MOIS12[regime as RegimeEnum]}/12</span>
              )}
            </span>
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {/* ligne 1 */}
            <ValueCard label="PVEI"                value={`${computed.pvei.toFixed(2)} €/h`}          color="blue"   />
            <ValueCard label="K.S.P"               value={KSP.toFixed(2)}                             color="zinc"   />
            <ValueCard label="Seuil HS"            value={`${computed.hsSeuil.toFixed(2)} h`}         color="green"  />
            {/* ligne 2 */}
            <ValueCard label="MGA"                 value={`${computed.mga.toFixed(2)} €`}             color="violet" />
            <ValueCard label="Traitement fixe"     value={`${computed.fixe.toFixed(2)} €`}            color="zinc"   />
            <ValueCard label="Prime bi-tronçon"    value={`${computed.primeBiTroncon.toFixed(2)} €`}  color="amber"  />
            {/* ligne 3 */}
            <ValueCard label="MGA temps plein"     value={`${computed.mgaTP.toFixed(2)} €`}           color="violet" />
            <ValueCard label="T. Fixe temps plein" value={`${computed.fixeTP.toFixed(2)} €`}          color="zinc"   />
            <ValueCard label="Prime d'incitation"  value={`${computed.primeIncitation.toFixed(2)} €`} color="amber"  />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers UI ────────────────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-2">{label}</p>
      {children}
    </div>
  );
}

const colorMap: Record<string, string> = {
  blue:   'text-blue-600 dark:text-blue-400',
  violet: 'text-violet-600 dark:text-violet-400',
  amber:  'text-amber-600 dark:text-amber-400',
  green:  'text-green-600 dark:text-green-400',
  zinc:   'text-zinc-800 dark:text-zinc-100',
};

function ValueCard({ label, value, color = 'zinc' }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-2.5">
      <p className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide leading-none mb-1">{label}</p>
      <p className={`text-sm font-semibold font-mono ${colorMap[color] ?? colorMap.zinc}`}>{value}</p>
    </div>
  );
}

function pill(active: boolean) {
  return [
    'px-3 py-1.5 rounded-lg text-sm font-medium border-2 transition-all',
    active
      ? 'border-zinc-800 dark:border-zinc-200 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
      : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:border-zinc-400',
  ].join(' ');
}

const input = 'w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm';
