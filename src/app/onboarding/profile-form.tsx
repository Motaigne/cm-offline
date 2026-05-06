'use client';

import { useState } from 'react';
import { createProfile } from '@/app/actions/profile';
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
  TTA92:       'TTA 92 % (1 mois off/an)',
  TTA83:       'TTA 83 % (2 mois off/an)',
  TTA75:       'TTA 75 % (4 mois off/an)',
};

const REGIMES    = Object.keys(REGIME_LABELS) as RegimeEnum[];
const AVIONS     = ['A359', 'A335', 'B777', 'B787'];
const AF_BASES   = ['CDG', 'ORY', 'NCE', 'LYS', 'MRS', 'BOD', 'TLS', 'NTE'];
const CATEGORIES = ['A', 'B', 'C'];
const TRANSPORTS = ['Navigo', 'Voiture'];

export function ProfileForm({
  email,
  initialData,
}: {
  email: string;
  initialData?: ProfileRow;
}) {
  const [displayName, setDisplayName] = useState(initialData?.display_name ?? '');
  const [base, setBase]               = useState(initialData?.base ?? 'CDG');
  const [fonction, setFonction]       = useState<FonctionEnum | ''>(initialData?.fonction ?? '');
  const [regime, setRegime]           = useState<RegimeEnum | ''>(initialData?.regime ?? '');
  const [qualifs, setQualifs]         = useState<string[]>(initialData?.qualifs_avion ?? []);
  const [classe, setClasse]           = useState(initialData?.classe?.toString() ?? '');
  const [categorie, setCategorie]     = useState(initialData?.categorie ?? '');
  const [echelon, setEchelon]         = useState(initialData?.echelon?.toString() ?? '');
  const [bonusAtpl, setBonusAtpl]     = useState(initialData?.bonus_atpl ?? false);
  const [transport, setTransport]     = useState(initialData?.transport ?? '');
  const [pending, setPending]         = useState(false);
  const [error, setError]             = useState<string | null>(null);

  function toggleQualif(avion: string) {
    setQualifs((prev) =>
      prev.includes(avion) ? prev.filter((a) => a !== avion) : [...prev, avion]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!fonction || !regime) return;
    setPending(true);
    setError(null);

    const result = await createProfile({
      display_name:  displayName || email,
      base,
      fonction,
      regime,
      qualifs_avion: qualifs,
      classe:        classe !== '' ? Number(classe) : null,
      categorie:     categorie || null,
      echelon:       echelon !== '' ? Number(echelon) : null,
      bonus_atpl:    bonusAtpl,
      transport:     transport || null,
    });

    if (result && 'error' in result) {
      setError(result.error);
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">

      {/* Nom + Base */}
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="block text-sm font-medium mb-1">Nom affiché</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={email}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Base</label>
          <select
            value={base}
            onChange={(e) => setBase(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            {AF_BASES.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
      </div>

      {/* Fonction */}
      <div>
        <label className="block text-sm font-medium mb-2">Fonction</label>
        <div className="grid grid-cols-2 gap-2">
          {FONCTIONS.map(({ value, label }) => (
            <label key={value} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="fonction"
                value={value}
                checked={fonction === value}
                onChange={() => setFonction(value)}
                required
              />
              <span className="text-sm font-mono">{label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Régime */}
      <div>
        <label className="block text-sm font-medium mb-1">Régime</label>
        <select
          value={regime}
          onChange={(e) => setRegime(e.target.value as RegimeEnum)}
          required
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="" disabled>Choisir…</option>
          {REGIMES.map((r) => (
            <option key={r} value={r}>{REGIME_LABELS[r]}</option>
          ))}
        </select>
      </div>

      {/* Avions */}
      <div>
        <label className="block text-sm font-medium mb-2">Avions qualifiés</label>
        <div className="flex gap-4">
          {AVIONS.map((avion) => (
            <label key={avion} className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={qualifs.includes(avion)}
                onChange={() => toggleQualif(avion)}
              />
              <span className="text-sm font-mono">{avion}</span>
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-zinc-400">A335 = bi-qual A332 + A350</p>
      </div>

      {/* Paie */}
      <div className="space-y-3">
        <p className="text-sm font-medium">
          Paie <span className="font-normal text-zinc-400">(optionnel)</span>
        </p>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Classe (0–5)</label>
            <input
              type="number" min={0} max={5}
              value={classe}
              onChange={(e) => setClasse(e.target.value)}
              placeholder="—"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Catégorie</label>
            <select
              value={categorie}
              onChange={(e) => setCategorie(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="">—</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Échelon (1–10)</label>
            <input
              type="number" min={1} max={10}
              value={echelon}
              onChange={(e) => setEchelon(e.target.value)}
              placeholder="—"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Transport</label>
            <select
              value={transport}
              onChange={(e) => setTransport(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="">—</option>
              {TRANSPORTS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={bonusAtpl}
                onChange={(e) => setBonusAtpl(e.target.checked)}
              />
              <span className="text-sm">Bonus ATPL</span>
            </label>
          </div>
        </div>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <button
        type="submit"
        disabled={pending || !fonction || !regime}
        className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {pending ? 'Enregistrement…' : 'Enregistrer'}
      </button>
    </form>
  );
}
