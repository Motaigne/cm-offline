'use client';

import { useState, useMemo, useTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { type ProfileData } from '@/app/actions/profile';
import { type ProfileVersion } from '@/app/actions/profile-version';
import {
  enqueueSaveProfile,
  enqueueSaveProfileVersion,
  enqueueDeleteProfileVersion,
  syncNow,
} from '@/lib/sync-service';
import { signOut } from '@/app/actions/auth';
import { computeFullProfile, computePrimeInstructionMontant, getAnnexeDataFromRows, KSP, type AnnexeData, type AnnexeRow } from '@/lib/annexe';
import { computeValeurJour } from '@/lib/article81';
import { useOnlineStatus } from '@/hooks/use-online';
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

const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
function fmtDateApp(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const day = d === 1 ? '1er' : String(d);
  return `${day} ${MONTHS_FR[m - 1]} ${y}`;
}

/** Date du 1er du mois courant en YYYY-MM-01. */
function currentMonthStart(): string {
  return new Date().toISOString().slice(0, 7) + '-01';
}

/** Champs du formulaire dérivés soit d'une ProfileVersion soit de user_profile (legacy). */
type SourceProfile = ProfileVersion | ProfileRow | null | undefined;

function readSource(src: SourceProfile) {
  return {
    fonction:   (src?.fonction ?? '') as FonctionEnum | '',
    regime:     (src?.regime   ?? '') as RegimeEnum   | '',
    classe:     src?.classe?.toString() ?? '2',
    categorie:  src?.categorie ?? 'C',
    echelon:    src?.echelon?.toString() ?? '4',
    bonusAtpl:  src?.bonus_atpl ?? false,
    transport:  src?.transport ?? '',
    navigoEur:  String(src?.navigo_eur ?? 81.40),
    voitureKmAller: src?.voiture_km_aller != null ? String(src.voiture_km_aller) : '',
    voitureIndemniteKm: String(src?.voiture_indemnite_km ?? 0.3837),
    aircraft:   src?.aircraft_principal ?? 'A335',
    cngPv:      String(src?.cng_pv ?? 0),
    cngHs:      String(src?.cng_hs ?? 0),
    triNiveau:  src?.tri_niveau != null ? String(src.tri_niveau) : '',
    prime330Count: src?.prime_330_count ?? null,
    tmi:        Number(src?.tmi ?? 41),
  };
}

export function ProfilForm({
  initialData,
  isNew,
  annexeRows,
  allVersions,
}: {
  initialData?: ProfileRow;
  isNew: boolean;
  annexeRows: AnnexeRow[];
  allVersions: ProfileVersion[];
}) {
  const router = useRouter();
  const isOnline = useOnlineStatus();

  // State local optimiste pour les versions — évite de devoir recharger la
  // page après un create/delete. Resync depuis les props quand router.refresh()
  // ramène les nouvelles données.
  const [localVersions, setLocalVersions] = useState<ProfileVersion[]>(allVersions);
  useEffect(() => { setLocalVersions(allVersions); }, [allVersions]);

  // Versions triées (plus récente d'abord). Si aucune version → fallback initialData.
  const sortedVersions = useMemo(
    () => [...localVersions].sort((a, b) => b.valid_from.localeCompare(a.valid_from)),
    [localVersions],
  );
  const latestValidFrom = sortedVersions[0]?.valid_from;

  // Version actuellement sélectionnée dans le dropdown (= source du form).
  const [selectedValidFrom, setSelectedValidFrom] = useState<string>(
    latestValidFrom ?? currentMonthStart(),
  );
  const selectedVersion = sortedVersions.find(v => v.valid_from === selectedValidFrom) ?? null;
  const source: SourceProfile = selectedVersion ?? initialData ?? null;

  // Champs form — initialisés depuis la source, ré-initialisés à chaque switch.
  const init = readSource(source);
  const [fonction,  setFonction]  = useState<FonctionEnum | ''>(init.fonction);
  const [regime,    setRegime]    = useState<RegimeEnum   | ''>(init.regime);
  const [classe,    setClasse]    = useState(init.classe);
  const [categorie, setCategorie] = useState(init.categorie);
  const [echelon,   setEchelon]   = useState(init.echelon);
  const [bonusAtpl, setBonusAtpl] = useState(init.bonusAtpl);
  const [transport, setTransport] = useState(init.transport);
  const [navigoEur,          setNavigoEur]          = useState(init.navigoEur);
  const [voitureKmAller,     setVoitureKmAller]     = useState(init.voitureKmAller);
  const [voitureIndemniteKm, setVoitureIndemniteKm] = useState(init.voitureIndemniteKm);
  const [aircraft,  setAircraft]  = useState(init.aircraft);
  const [cngPv,     setCngPv]     = useState(init.cngPv);
  const [cngHs,     setCngHs]     = useState(init.cngHs);
  const [triNiveau, setTriNiveau] = useState<string>(init.triNiveau);
  const [prime330Count, setPrime330Count] = useState<number | null>(init.prime330Count);
  const [tmi,         setTmi]         = useState<number>(init.tmi);

  // Quand on change de version sélectionnée → reset le form depuis la nouvelle source.
  useEffect(() => {
    const v = sortedVersions.find(v => v.valid_from === selectedValidFrom) ?? null;
    const src: SourceProfile = v ?? initialData ?? null;
    const r = readSource(src);
    setFonction(r.fonction); setRegime(r.regime); setClasse(r.classe);
    setCategorie(r.categorie); setEchelon(r.echelon); setBonusAtpl(r.bonusAtpl);
    setTransport(r.transport); setNavigoEur(r.navigoEur); setVoitureKmAller(r.voitureKmAller);
    setVoitureIndemniteKm(r.voitureIndemniteKm); setAircraft(r.aircraft);
    setCngPv(r.cngPv); setCngHs(r.cngHs); setTriNiveau(r.triNiveau);
    setPrime330Count(r.prime330Count); setTmi(r.tmi);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedValidFrom]);

  const isTri    = fonction === 'TRI_OPL' || fonction === 'TRI_CDB';
  const prime330 = prime330Count != null;

  const [saved,     setSaved]     = useState(false);
  const [err,       setErr]       = useState('');
  const [isPending, start]        = useTransition();

  // ── Nouvelle version (UI inline) ───────────────────────────────────────────
  const [showNewForm, setShowNewForm] = useState(false);
  const [newDate, setNewDate]         = useState(() => {
    // Default = 1er du mois suivant.
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString().slice(0, 10);
  });
  const [newErr, setNewErr] = useState('');

  // ── Calcul live des éléments de paie ───────────────────────────────────────
  // L'annexe est versionnée : on slice les rows selon le mois de la version
  // de profil sélectionnée, sinon les éléments de paie restent figés sur
  // l'annexe du mois courant quel que soit le selectedValidFrom.
  const annexe = useMemo<Partial<AnnexeData>>(
    () => getAnnexeDataFromRows(annexeRows, selectedValidFrom.slice(0, 7)),
    [annexeRows, selectedValidFrom],
  );

  const computed = useMemo(() => {
    const hasAnnexe = !!(
      annexe.cat_anciennete?.length &&
      annexe.coef_classe?.length &&
      annexe.taux_avion?.length &&
      annexe.traitement_base
    );
    if (!hasAnnexe || !fonction) return null;

    const nb30e   = regime ? REGIME_NB30E[regime as RegimeEnum] : 23;
    const is10_12 = regime ? REGIME_MOIS12[regime as RegimeEnum] === 10 : false;
    const cl      = parseInt(classe)  || 2;
    const ech     = parseInt(echelon) || 4;

    const primeInstFonction = fonction === 'TRI_OPL' ? 'TRI_OPL'
      : fonction === 'TRI_CDB' ? 'ICPL'
      : null;
    const primeInstAnnee = (isTri && triNiveau !== '') ? parseInt(triNiveau) : null;

    const profileArgs = [aircraft, fonction, cl, categorie, ech, bonusAtpl, nb30e, 'LC' as const,
      primeInstFonction, primeInstAnnee, prime330Count, annexe as AnnexeData] as const;

    const main = computeFullProfile(...profileArgs);
    const juillAout = is10_12
      ? computeFullProfile(aircraft, fonction, cl, categorie, ech, bonusAtpl, 30, 'LC',
          primeInstFonction, primeInstAnnee, prime330Count, annexe as AnnexeData)
      : null;

    // Valeur Jour A81 : formule pilote "théorique 100%" → fixe TEMPS PLEIN
    // (non proratisé régime) + prime instruction NON proratisée.
    const primeInstNonProratise = (primeInstFonction && primeInstAnnee && annexe.prime_instruction)
      ? computePrimeInstructionMontant(annexe.prime_instruction, primeInstFonction, primeInstAnnee)
      : 0;
    const valeurJour = computeValeurJour({
      fixe: main.fixeTP,
      pvei: main.pvei,
      ksp: main.ksp,
      primeInstruction: primeInstNonProratise,
      isTri,
    });

    return { ...main, juillAout, valeurJour };
  }, [annexe, fonction, regime, aircraft, classe, categorie, echelon, bonusAtpl, isTri, triNiveau, prime330Count]);

  /** Champs à persister (commun entre saveProfile et saveProfileVersion). */
  function buildPayload(): ProfileData {
    return {
      fonction:           fonction as FonctionEnum,
      regime:             regime   as RegimeEnum,
      qualifs_avion:      [],
      classe:             classe   !== '' ? Number(classe)  : null,
      categorie:          categorie || null,
      echelon:            echelon  !== '' ? Number(echelon) : null,
      bonus_atpl:         bonusAtpl,
      transport:          transport || null,
      navigo_eur:           transport === 'Navigo'  ? (parseFloat(navigoEur) || 0) : null,
      voiture_km_aller:     transport === 'Voiture' && voitureKmAller !== '' ? Math.min(45, parseFloat(voitureKmAller)) : null,
      voiture_indemnite_km: transport === 'Voiture' ? (parseFloat(voitureIndemniteKm) || 0) : null,
      aircraft_principal: aircraft,
      cng_pv:             parseFloat(cngPv) || 0,
      cng_hs:             parseFloat(cngHs) || 0,
      tri_niveau:         isTri && triNiveau !== '' ? parseInt(triNiveau) : null,
      prime_330_count:    prime330Count,
      valeur_jour:        computed?.valeurJour ?? 600,
      tmi:                tmi,
    };
  }

  function handleSave() {
    if (!fonction || !regime) return;
    setErr(''); setSaved(false);
    const data = buildPayload();
    const targetValidFrom = selectedValidFrom;
    // Sync user_profile uniquement si on édite la version la plus récente (ou le 1er enregistrement d'un new user).
    const shouldSyncUserProfile = isNew || targetValidFrom === latestValidFrom;

    const versionFields = {
      fonction:   data.fonction,
      regime:     data.regime,
      qualifs_avion: data.qualifs_avion,
      classe:     data.classe,
      categorie:  data.categorie,
      echelon:    data.echelon,
      bonus_atpl: data.bonus_atpl,
      transport:  data.transport,
      navigo_eur: data.navigo_eur,
      voiture_km_aller:     data.voiture_km_aller,
      voiture_indemnite_km: data.voiture_indemnite_km,
      aircraft_principal:   data.aircraft_principal,
      cng_pv:     data.cng_pv,
      cng_hs:     data.cng_hs,
      tri_niveau: data.tri_niveau,
      prime_330_count: data.prime_330_count,
      valeur_jour: data.valeur_jour,
      tmi:        data.tmi,
    };
    // Optimistic row pour cache local (les lecteurs offline calculent paie là-dessus).
    const optimisticVersion: ProfileVersion = {
      user_id:     selectedVersion?.user_id ?? sortedVersions[0]?.user_id ?? '',
      valid_from:  targetValidFrom,
      base:        selectedVersion?.base ?? 'PAR',
      instructeur: selectedVersion?.instructeur ?? false,
      created_at:  selectedVersion?.created_at ?? new Date().toISOString(),
      updated_at:  new Date().toISOString(),
      ...versionFields,
    };

    start(async () => {
      try {
        // 1. user_profile : table de compat (display_name, onboarding check).
        if (shouldSyncUserProfile) {
          await enqueueSaveProfile(data);
        }
        // 2. user_profile_version : source de vérité paie. Cache local mis à
        //    jour de manière atomique avec la queue.
        await enqueueSaveProfileVersion(targetValidFrom, versionFields, optimisticVersion);

        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
        router.refresh();
        // Tentative de sync immédiate si online (best-effort). En offline,
        // l'op reste en queue et sera rejouée au prochain Sync manuel ou online.
        if (isOnline) {
          try { await syncNow(); } catch { /* silencieux : retry au prochain Sync */ }
        }
      } catch (e) {
        setErr(`Exception : ${String(e).slice(0, 300)}`);
        console.error('[saveProfile] threw:', e);
      }
    });
  }

  function handleCreateNewVersion() {
    setNewErr('');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) { setNewErr('Format YYYY-MM-DD requis'); return; }
    const [, , day] = newDate.split('-');
    if (day !== '01') { setNewErr('La date doit être le 1er du mois'); return; }
    if (sortedVersions.some(v => v.valid_from === newDate)) { setNewErr('Une version existe déjà à cette date'); return; }
    if (!fonction || !regime) { setNewErr('Fonction + régime requis avant de créer une version'); return; }

    const data = buildPayload();
    const fields = {
      fonction:   data.fonction,
      regime:     data.regime,
      qualifs_avion: data.qualifs_avion,
      classe:     data.classe,
      categorie:  data.categorie,
      echelon:    data.echelon,
      bonus_atpl: data.bonus_atpl,
      transport:  data.transport,
      navigo_eur: data.navigo_eur,
      voiture_km_aller:     data.voiture_km_aller,
      voiture_indemnite_km: data.voiture_indemnite_km,
      aircraft_principal:   data.aircraft_principal,
      cng_pv:     data.cng_pv,
      cng_hs:     data.cng_hs,
      tri_niveau: data.tri_niveau,
      prime_330_count: data.prime_330_count,
      valeur_jour: data.valeur_jour,
      tmi:        data.tmi,
    };
    // Optimistic update : ajoute la nouvelle version au state local et au
    // cache Dexie immédiatement → dropdown reflète la création sans navigation.
    const optimistic: ProfileVersion = {
      user_id: selectedVersion?.user_id ?? sortedVersions[0]?.user_id ?? '',
      valid_from: newDate,
      base: selectedVersion?.base ?? 'PAR',
      instructeur: selectedVersion?.instructeur ?? false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...fields,
    };
    start(async () => {
      try {
        await enqueueSaveProfileVersion(newDate, fields, optimistic);
      } catch (e) {
        setNewErr(`Exception : ${String(e).slice(0, 200)}`);
        return;
      }
      setLocalVersions(prev => [...prev, optimistic]);
      setShowNewForm(false);
      setSelectedValidFrom(newDate);
      router.refresh(); // resync silencieux en arrière-plan
      if (isOnline) {
        try { await syncNow(); } catch { /* silencieux */ }
      }
    });
  }

  function handleDeleteVersion() {
    if (sortedVersions.length <= 1) return;
    const label = fmtDateApp(selectedValidFrom);
    if (!confirm(`Supprimer la version du ${label} ?\n\nLes mois utilisant cette version basculeront sur la version précédente.`)) return;
    const toDelete = selectedValidFrom;
    start(async () => {
      try {
        await enqueueDeleteProfileVersion(toDelete);
      } catch (e) {
        setErr(`Exception : ${String(e).slice(0, 200)}`);
        return;
      }
      // Optimistic : retire la version du state local + sélectionne la suivante (la plus récente restante).
      const remaining = localVersions.filter(v => v.valid_from !== toDelete);
      setLocalVersions(remaining);
      const nextValidFrom = remaining
        .map(v => v.valid_from)
        .sort((a, b) => b.localeCompare(a))[0];
      if (nextValidFrom) setSelectedValidFrom(nextValidFrom);
      router.refresh();
      if (isOnline) {
        try { await syncNow(); } catch { /* silencieux */ }
      }
    });
  }

  const canSave = !!fonction && !!regime;
  const hasVersions = sortedVersions.length > 0;

  return (
    <div className="space-y-6">

      {/* ── Sélecteur de version ────────────────────────────────────────────── */}
      {hasVersions && (
        <div className="flex flex-wrap items-center gap-2 p-3 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
          <label className="text-xs text-zinc-500 font-medium">Version éditée :</label>
          <select
            value={selectedValidFrom}
            onChange={e => setSelectedValidFrom(e.target.value)}
            className="text-xs px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
          >
            {sortedVersions.map(v => (
              <option key={v.valid_from} value={v.valid_from}>
                À partir du {fmtDateApp(v.valid_from)}
                {v.valid_from === latestValidFrom ? ' (la plus récente)' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => { setShowNewForm(s => !s); setNewErr(''); }}
            className="text-xs px-2 py-1 rounded border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30"
          >
            + Nouvelle version
          </button>
          {sortedVersions.length > 1 && (
            <button
              type="button"
              onClick={handleDeleteVersion}
              disabled={isPending}
              className="text-xs px-2 py-1 rounded border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-40 ml-auto"
              title="Supprime cette version. Les mois concernés basculeront sur la version précédente."
            >
              Supprimer cette version
            </button>
          )}
        </div>
      )}

      {showNewForm && (
        <div className="p-3 rounded-xl bg-blue-50 dark:bg-blue-950/30 border border-blue-100 dark:border-blue-900 text-xs space-y-2">
          <ol className="list-decimal list-inside text-blue-700 dark:text-blue-300 space-y-0.5">
            <li>Choisis la date d&apos;application (1<sup>er</sup> du mois) ci-dessous.</li>
            <li>Modifie les champs du profil plus bas selon ce qui change à cette date.</li>
            <li>Reviens ici cliquer sur <strong>Créer</strong>.</li>
          </ol>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <label className="text-blue-700 dark:text-blue-300 font-medium">Date d&apos;application :</label>
            <input
              type="date"
              value={newDate}
              onChange={e => setNewDate(e.target.value)}
              className="px-2 py-1 rounded border border-blue-200 dark:border-blue-800 bg-white dark:bg-zinc-900 font-mono"
            />
            <button
              type="button"
              onClick={handleCreateNewVersion}
              disabled={isPending}
              className="px-3 py-1 rounded bg-blue-600 text-white font-semibold disabled:opacity-40"
            >
              {isPending ? '…' : 'Créer'}
            </button>
            <button
              type="button"
              onClick={() => { setShowNewForm(false); setNewErr(''); }}
              className="text-zinc-500 hover:text-zinc-700"
            >
              Annuler
            </button>
            {newErr && <span className="text-red-500">{newErr}</span>}
          </div>
        </div>
      )}

      {/* Fonction */}
      <Section label="Fonction">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {FONCTIONS.map(({ value, label }) => (
            <button key={value} type="button"
              onClick={() => {
                setFonction(value);
                if ((value === 'TRI_OPL' || value === 'TRI_CDB') && triNiveau === '') {
                  setTriNiveau('1');
                }
              }}
              className={pill(fonction === value)}>
              {label}
            </button>
          ))}
        </div>
        {isTri && (
          <div className="mt-3">
            <label className="block text-xs text-zinc-500 mb-1">Niveau d&apos;instruction</label>
            <div className="flex flex-wrap gap-2">
              {['1', '2', '3', '4', '5'].map(n => (
                <button key={n} type="button" onClick={() => setTriNiveau(n)} className={pill(triNiveau === n)}>
                  {n === '5' ? '≥ 5' : n}
                </button>
              ))}
            </div>
          </div>
        )}
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
        <label className="flex items-center gap-2 cursor-pointer select-none mt-3">
          <input
            type="checkbox"
            checked={prime330}
            onChange={e => setPrime330Count(e.target.checked ? 9 : null)}
            className="w-4 h-4 rounded"
          />
          <span className="text-sm">Prime A330</span>
        </label>
        {prime330 && (
          <div className="mt-3">
            <label className="block text-xs text-zinc-500 mb-1">Nombre d&apos;avions sur la flotte</label>
            <div className="flex flex-wrap gap-2">
              {[
                { count: 9, label: '< 9' },
                { count: 7, label: '< 7' },
                { count: 5, label: '< 5' },
              ].map(({ count, label }) => (
                <button
                  key={count}
                  type="button"
                  onClick={() => setPrime330Count(count)}
                  className={pill(prime330Count === count)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
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

        {transport === 'Navigo' && (
          <div className="mt-3">
            <label className="block text-xs text-zinc-500 mb-1">Navigo (€ / mois)</label>
            <input type="number" step="0.01" min={0} value={navigoEur}
              onChange={e => setNavigoEur(e.target.value)} placeholder="81.40"
              className={`${input} w-32 text-center font-mono`} />
            <p className="mt-1 text-[10px] text-zinc-400">IT mensuelle fixe (si ≥ 1 activité sur le mois).</p>
          </div>
        )}

        {transport === 'Voiture' && (
          <div className="mt-3 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">km aller (max 45)</label>
                <input type="number" step="0.1" min={0} max={45} value={voitureKmAller}
                  onChange={e => setVoitureKmAller(e.target.value)} placeholder="0"
                  className={`${input} text-center font-mono`} />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Indemnité / km (€)</label>
                <input type="number" step="0.0001" min={0} value={voitureIndemniteKm}
                  onChange={e => setVoitureIndemniteKm(e.target.value)} placeholder="0.3837"
                  className={`${input} text-center font-mono`} />
              </div>
            </div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
              Par activité = 2 × km aller × indemnité/km =
              <span className="ml-1 font-mono text-zinc-700 dark:text-zinc-200">
                {(2 * (parseFloat(voitureKmAller) || 0) * (parseFloat(voitureIndemniteKm) || 0)).toFixed(2)} €
              </span>
            </div>
          </div>
        )}
      </Section>

      {/* TMI (Taux Marginal d'Imposition) — utilisé pour le calcul du gain net A81 */}
      <Section label="TMI (Taux Marginal d'Imposition)">
        <div className="flex flex-wrap gap-2">
          {[45, 41, 30, 11, 0].map(t => (
            <button key={t} type="button" onClick={() => setTmi(t)} className={pill(tmi === t)}>
              {t} %
            </button>
          ))}
        </div>
      </Section>

      {err && <p className="text-sm text-red-500">{err}</p>}

      <button type="button" onClick={handleSave} disabled={isPending || !canSave}
        className="w-full rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2.5 text-sm font-semibold hover:opacity-80 disabled:opacity-40 transition-opacity">
        {saved
          ? (isOnline ? '✓ Enregistré' : '✓ Sauvegardé localement — synchro à la reconnexion')
          : isPending ? 'Enregistrement…' : isNew
          ? 'Créer mon profil'
          : `Enregistrer la version du ${fmtDateApp(selectedValidFrom)}`}
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
            {/* Row 1 : PVEI · K.S.P · Seuil HS */}
            <ValueCard label="PVEI"     value={`${computed.pvei.toFixed(2)} €/h`}  color="blue"
              formula="Avion × (ATPL + Classe) × CAT" />
            <ValueCard label="K.S.P"    value={KSP.toFixed(2)}                     color="zinc" />
            <ValueCard label="Seuil HS" value={`${computed.hsSeuil.toFixed(2)} h`} color="green"
              formula="75 − 2,5 × congés − 2,5 × (30 − 30e)" />

            {/* Row 2 : SMMG · T.Fixe · MGA (régime courant) */}
            <ValueCard label="SMMG"             value={`${computed.smmg.toFixed(2)} €`}           color="violet"
              formula="T.Fixe + MGA" />
            <ValueCard label="Traitement fixe"  value={`${computed.fixe.toFixed(2)} €`}           color="zinc"
              formula="Fixe × Coef(FO/CDB) × Echelon × 30e" />
            <ValueCard label="MGA"              value={`${computed.mga.toFixed(2)} €`}            color="violet"
              formula="85 × PVEI × (30e/30)" />

            {/* Row 3 : SMMG TP · T.Fixe TP · MGA TP (temps plein théorique) */}
            <ValueCard label="SMMG temps plein"    value={`${computed.smmgTP.toFixed(2)} €`}          color="violet"
              formula="T.Fixe TP + MGA TP" />
            <ValueCard label="T. Fixe temps plein" value={`${computed.fixeTP.toFixed(2)} €`}          color="zinc"   />
            <ValueCard label="MGA temps plein"     value={`${computed.mgaTP.toFixed(2)} €`}           color="violet"
              formula="85 × PVEI" />

            {/* Row 4 : Prime bi-tronçon · Prime d'incitation · Valeur Jour A81 */}
            <ValueCard label="Prime bi-tronçon" value={`${computed.primeBiTroncon.toFixed(2)} €`} color="amber"
              formula="2,5 × PVEI (sans KSP)" />
            <ValueCard label="Prime d'incitation"  value={`${computed.primeIncitation.toFixed(2)} €`} color="amber"  />
            <ValueCard label="Valeur Jour A81"     value={`${computed.valeurJour.toFixed(2)} €`}     color="green"
              formula={isTri
                ? '(T.Fixe TP + Prime instruc. + 96 × PVEI × KSP) × 13/12 / 18'
                : '(T.Fixe TP + 76 × PVEI × KSP) × 13/12 / 18'} />

            {/* Row 5 : Prime A330 jan-juin/sep-déc · Prime A330 juil-août */}
            {prime330 && computed.primeA330 > 0 && (
              <>
                <ValueCard
                  label={computed.juillAout ? 'Prime A330 (jan–juin, sep–déc)' : 'Prime A330'}
                  value={`${computed.primeA330.toFixed(2)} €`} color="amber" />
                {computed.juillAout && (
                  <ValueCard label="Prime A330 (juil–août)"
                    value={`${computed.juillAout.primeA330.toFixed(2)} €`} color="amber" />
                )}
              </>
            )}

            {/* Prime instruction (TRI uniquement) */}
            {isTri && computed.primeInstruction > 0 && (
              <>
                <ValueCard
                  label={computed.juillAout ? "Prime d'instruction (jan–juin, sep–déc)" : "Prime mensuelle d'instruction"}
                  value={`${computed.primeInstruction.toFixed(2)} €`} color="amber" />
                {computed.juillAout && (
                  <ValueCard label="Prime d'instruction (juil–août)"
                    value={`${computed.juillAout.primeInstruction.toFixed(2)} €`} color="amber" />
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Se déconnecter */}
      <form action={signOut} className="pt-4 border-t border-zinc-200 dark:border-zinc-700">
        <button
          type="submit"
          className="w-full rounded-lg border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 px-4 py-2.5 text-sm font-semibold hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
        >
          Se déconnecter
        </button>
      </form>
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

function ValueCard({ label, value, color = 'zinc', formula }: { label: string; value: string; color?: string; formula?: string }) {
  return (
    <div className="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-2.5">
      <p className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide leading-none mb-1">{label}</p>
      <p className={`text-sm font-semibold font-mono ${colorMap[color] ?? colorMap.zinc}`}>{value}</p>
      {formula && (
        <p className="text-[9px] text-zinc-400 dark:text-zinc-500 italic mt-0.5 leading-tight">{formula}</p>
      )}
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
