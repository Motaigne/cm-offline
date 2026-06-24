'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { saveAnnexeTable } from '@/app/actions/annexe';
import { computePrimeInstructionMontant, type PrimeInstruction } from '@/lib/annexe';
import type { Json } from '@/types/supabase';

type AnnexeRow = {
  slug: string;
  valid_from: string;
  name: string;
  description: string | null;
  data: Json;
  updated_at: string;
};

const MONTH_NAMES_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
function fmtDateApp(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const day = d === 1 ? '1er' : String(d);
  return `${day} ${MONTH_NAMES_FR[m - 1]} ${y}`;
}

// ── Shared card shell (non versionné) ──────────────────────────────────────────
function Card({
  title, children, table, canEdit, extraHeader,
}: {
  title: string;
  children: ReactNode;
  table: AnnexeRow;
  canEdit: boolean;
  /** UI optionnelle insérée dans le header (ex: dropdown de version). */
  extraHeader?: ReactNode;
}) {
  const [editing, setEditing]   = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [err, setErr]           = useState('');
  const [saved, setSaved]       = useState(false);
  const [isPending, start]      = useTransition();
  const router = useRouter();

  function startEdit() { setJsonText(JSON.stringify(table.data, null, 2)); setErr(''); setEditing(true); }

  function handleSave() {
    setErr('');
    let parsed: Json;
    try { parsed = JSON.parse(jsonText); } catch { setErr('JSON invalide'); return; }
    start(async () => {
      const res = await saveAnnexeTable(table.slug, parsed, table.valid_from);
      if (res.error) setErr(res.error);
      else {
        setSaved(true); setEditing(false);
        setTimeout(() => setSaved(false), 3000);
        router.refresh();
      }
    });
  }

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-100 dark:border-zinc-800 gap-2">
        <p className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 uppercase tracking-wide">{title}</p>
        <div className="flex items-center gap-2">
          {extraHeader}
          {saved && <span className="text-[10px] text-green-500 font-medium">✓</span>}
          {canEdit && !editing && (
            <button onClick={startEdit} className="text-[10px] px-2 py-0.5 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors">
              Modifier
            </button>
          )}
        </div>
      </div>
      {!editing ? (
        children
      ) : (
        <div className="p-3 space-y-2">
          <textarea
            value={jsonText}
            onChange={e => setJsonText(e.target.value)}
            className="w-full h-48 font-mono text-[10px] bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded p-2 resize-y"
            spellCheck={false}
          />
          {err && <p className="text-[10px] text-red-500">{err}</p>}
          <div className="flex gap-2">
            <button onClick={handleSave} disabled={isPending}
              className="px-3 py-1 rounded bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-[10px] font-semibold disabled:opacity-40">
              {isPending ? '…' : 'Sauvegarder'}
            </button>
            <button onClick={() => setEditing(false)}
              className="px-3 py-1 rounded border border-zinc-200 dark:border-zinc-700 text-[10px] text-zinc-500 hover:text-zinc-700">
              Annuler
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Versioned card shell ───────────────────────────────────────────────────────
// Pour les slugs versionnés (taux_avion, prime_incitation, traitement_base,
// prime_instruction). Affiche un dropdown de date d'application + bouton admin
// "+ Nouvelle version" qui crée une row (slug, valid_from) en copiant la data
// de la version sélectionnée comme template.
function VersionedCard({
  title, versions, canEdit, renderContent,
}: {
  title: string;
  versions: AnnexeRow[];                 // déjà triées (plus récente d'abord)
  canEdit: boolean;
  renderContent: (row: AnnexeRow) => ReactNode;
}) {
  const [selectedValidFrom, setSelectedValidFrom] = useState(versions[0]?.valid_from ?? '');
  const [showNewForm, setShowNewForm] = useState(false);
  const [newDate, setNewDate] = useState('');
  const [newErr, setNewErr] = useState('');
  const [isCreating, startCreate] = useTransition();
  const router = useRouter();

  const selected = versions.find(v => v.valid_from === selectedValidFrom) ?? versions[0];
  if (!selected) return null;

  function handleCreateVersion() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) { setNewErr('Format YYYY-MM-DD requis'); return; }
    if (versions.some(v => v.valid_from === newDate)) { setNewErr('Cette date existe déjà'); return; }
    setNewErr('');
    startCreate(async () => {
      const res = await saveAnnexeTable(selected.slug, selected.data, newDate);
      if (res.error) setNewErr(res.error);
      else {
        setShowNewForm(false); setNewDate('');
        setSelectedValidFrom(newDate);
        router.refresh();
      }
    });
  }

  const dropdown = (
    <>
      <select
        value={selected.valid_from}
        onChange={e => setSelectedValidFrom(e.target.value)}
        className="text-[10px] px-2 py-0.5 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300"
        title="Date d'application (visualisation — n'affecte pas les calculs)"
      >
        {versions.map(v => (
          <option key={v.valid_from} value={v.valid_from}>Date d&apos;application : {fmtDateApp(v.valid_from)}</option>
        ))}
      </select>
      {canEdit && (
        <button
          onClick={() => { setShowNewForm(s => !s); setNewErr(''); setNewDate(''); }}
          className="text-[10px] px-2 py-0.5 rounded border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30"
        >
          + Nouvelle version
        </button>
      )}
    </>
  );

  return (
    <div>
      <Card title={title} table={selected} canEdit={canEdit} extraHeader={dropdown}>
        {renderContent(selected)}
      </Card>
      {showNewForm && (
        <div className="mt-1 mx-1 px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-100 dark:border-blue-900 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-blue-700 dark:text-blue-300">Nouvelle date d&apos;application :</span>
          <input
            type="date"
            value={newDate}
            onChange={e => setNewDate(e.target.value)}
            className="px-2 py-1 rounded border border-blue-200 dark:border-blue-800 bg-white dark:bg-zinc-900 font-mono"
          />
          <span className="text-blue-600 dark:text-blue-400 italic">
            (les valeurs de la version &laquo;&nbsp;{fmtDateApp(selected.valid_from)}&nbsp;&raquo; seront dupliquées comme point de départ)
          </span>
          <button
            onClick={handleCreateVersion}
            disabled={isCreating || !newDate}
            className="px-3 py-1 rounded bg-blue-600 text-white font-semibold disabled:opacity-40"
          >
            {isCreating ? '…' : 'Créer'}
          </button>
          <button
            onClick={() => { setShowNewForm(false); setNewErr(''); setNewDate(''); }}
            className="text-zinc-500 hover:text-zinc-700"
          >
            Annuler
          </button>
          {newErr && <span className="text-red-500">{newErr}</span>}
        </div>
      )}
    </div>
  );
}

// ── Mini table ─────────────────────────────────────────────────────────────────
function MiniTable({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full">
      <thead>
        <tr className="bg-zinc-50 dark:bg-zinc-800/60">
          {headers.map(h => (
            <th key={h} className="px-2.5 py-1.5 text-left text-[10px] font-medium text-zinc-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {rows.map((row, i) => (
          <tr key={i} className={i % 2 ? 'bg-zinc-50/50 dark:bg-zinc-800/20' : ''}>
            {row.map((cell, j) => (
              <td key={j} className="px-2.5 py-1 text-xs font-mono text-zinc-700 dark:text-zinc-300 whitespace-nowrap">{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Section 1 cards (non versionnés) ───────────────────────────────────────────
function CatAncienneteCard({ table, canEdit }: { table: AnnexeRow; canEdit: boolean }) {
  const rows = table.data as { echelon: number; categorie: string; coefficient: number }[];
  return (
    <Card title="Catégorie d'ancienneté" table={table} canEdit={canEdit}>
      <MiniTable headers={['Échelon', 'Cat.', 'Coeff']} rows={rows.map(r => [r.echelon, r.categorie, r.coefficient])} />
    </Card>
  );
}

function CoefClasseCard({ table, canEdit }: { table: AnnexeRow; canEdit: boolean }) {
  const rows = table.data as { role: string; classe: number; coefficient: number }[];
  return (
    <Card title="Coefficients de classe" table={table} canEdit={canEdit}>
      <MiniTable headers={['Rôle', 'Classe', 'Coeff']} rows={rows.map(r => [r.role, r.classe, r.coefficient])} />
    </Card>
  );
}

// ── Section 2 cards (versionnés) ───────────────────────────────────────────────
function TauxAvionCard({ versions, canEdit }: { versions: AnnexeRow[]; canEdit: boolean }) {
  return (
    <VersionedCard title="Taux horaire (€/h)" versions={versions} canEdit={canEdit} renderContent={(table) => {
      const rows = (table.data as { avion: string; taux: number }[]).filter(r => r.avion !== 'Groupe');
      return <MiniTable headers={['Avion', 'Taux']} rows={rows.map(r => [r.avion, r.taux])} />;
    }} />
  );
}

function PrimeIncitationCard({ versions, canEdit }: { versions: AnnexeRow[]; canEdit: boolean }) {
  return (
    <VersionedCard title="Prime d'incitation" versions={versions} canEdit={canEdit} renderContent={(table) => {
      const rows = table.data as { role: string; type: string; montant: number }[];
      return <MiniTable headers={['', '€']} rows={rows.map(r => [`${r.role} ${r.type}`, r.montant])} />;
    }} />
  );
}

// Prime A330 — non versionnée.
function PrimeIncitation330Card({ table, canEdit }: { table: AnnexeRow; canEdit: boolean }) {
  const all = table.data as { seuil: string; mois_max?: number; avions_max?: number; valeur_pvei: number }[];
  // Tri par valeur_pvei descendante (tier le plus généreux en haut).
  const rows = [...all].sort((a, b) => b.valeur_pvei - a.valeur_pvei);
  return (
    <Card title="Prime d'incitation 330" table={table} canEdit={canEdit}>
      <MiniTable
        headers={['Seuil', 'PVEI ×']}
        rows={rows.map(r => [r.seuil.replace(/\bmois\b/g, 'avions'), r.valeur_pvei])}
      />
    </Card>
  );
}

// ── Section 3: traitement_base (versionné) ─────────────────────────────────────
function TraitementBaseCard({ versions, canEdit }: { versions: AnnexeRow[]; canEdit: boolean }) {
  return (
    <VersionedCard title="Traitement mensuel fixe de référence" versions={versions} canEdit={canEdit} renderContent={(table) => {
      const d = table.data as { note?: string; coef_opl: number; base_cdb_a1: number };
      const label = d.note ?? 'CDB A1';
      return (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs text-zinc-500">{label}</span>
            <span className="text-xs font-mono font-semibold text-zinc-800 dark:text-zinc-100">{d.base_cdb_a1} €</span>
          </div>
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs text-zinc-500">Coefficient OPL</span>
            <span className="text-xs font-mono font-semibold text-zinc-800 dark:text-zinc-100">{d.coef_opl}</span>
          </div>
        </div>
      );
    }} />
  );
}

// ── Section 4: prorata ─────────────────────────────────────────────────────────
type ProrataThreshold = { range: string; ji_restants: number; duree_min: number; duree_min_opt6: number; };

const RANGE_LABELS: Record<string, string> = {
  '0-2': '0/1/2', '3-4': '3/4', '5-7': '5/6/7',
  '8-9': '8/9', '10-12': '10/11/12', '13-14': '13/14',
  '15-17': '15/16/17', '18-19': '18/19', '20-22': '20/21/22',
  '23-24': '23/24', '25-27': '25/26/27', '>27': '> 27',
};

const PRORATA_ROWS: { label: string; key: keyof ProrataThreshold }[] = [
  { label: 'JI mensuels restants',        key: 'ji_restants'     },
  { label: "Durée min. d'une période",    key: 'duree_min'       },
  { label: 'Durée min. option 6 j',       key: 'duree_min_opt6'  },
];

function ProrataCard({ table, canEdit }: { table: AnnexeRow; canEdit: boolean }) {
  const d = table.data as { thresholds: ProrataThreshold[] };
  const cols = d.thresholds;
  return (
    <Card title="Prorata — jours donnant lieu à prorata" table={table} canEdit={canEdit}>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px]">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-800/60">
              <th className="px-2.5 py-1.5 text-left font-medium text-zinc-400 uppercase tracking-wide whitespace-nowrap min-w-[160px]">
                Jours de prorata
              </th>
              {cols.map(c => (
                <th key={c.range} className="px-1.5 py-1.5 text-center font-medium text-zinc-400 whitespace-nowrap">
                  {RANGE_LABELS[c.range] ?? c.range}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {PRORATA_ROWS.map(({ label, key }, i) => (
              <tr key={key} className={i % 2 ? 'bg-zinc-50/50 dark:bg-zinc-800/20' : ''}>
                <td className="px-2.5 py-1 font-medium text-zinc-500 whitespace-nowrap">{label}</td>
                {cols.map(c => (
                  <td key={c.range} className="px-1.5 py-1 text-center font-mono text-zinc-700 dark:text-zinc-300">{c[key]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Section 5: prime_instruction (versionné) ──────────────────────────────────
// Stockage : { icpl_a1, tri_opl_b1, multiplier, max_annee }
// Le tableau affiché est dérivé (compound depuis valeur arrondie).
function PrimeInstructionCard({ versions, canEdit }: { versions: AnnexeRow[]; canEdit: boolean }) {
  return (
    <VersionedCard title="Prime mensuelle d'instruction" versions={versions} canEdit={canEdit} renderContent={(table) => {
      const cfg = table.data as unknown as PrimeInstruction;
      const years = Array.from({ length: cfg.max_annee }, (_, i) => i + 1);
      const fonctions: { key: string; label: string }[] = [
        { key: 'ICPL',    label: 'ICPL' },
        { key: 'TRI_OPL', label: 'TRI OPL' },
      ];
      const yearLabel = (y: number) => (y === cfg.max_annee ? `${y} ou plus` : String(y));
      return (
        <>
          <table className="w-full">
            <thead>
              <tr className="bg-zinc-50 dark:bg-zinc-800/60">
                <th className="px-2.5 py-1.5 text-left text-[10px] font-medium text-zinc-400 uppercase tracking-wide whitespace-nowrap">Année</th>
                {years.map(y => (
                  <th key={y} className="px-2.5 py-1.5 text-center text-[10px] font-medium text-zinc-400 uppercase tracking-wide">{yearLabel(y)}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {fonctions.map((fn, i) => (
                <tr key={fn.key} className={i % 2 ? 'bg-zinc-50/50 dark:bg-zinc-800/20' : ''}>
                  <td className="px-2.5 py-1 text-xs font-medium text-zinc-500 whitespace-nowrap">{fn.label}</td>
                  {years.map(y => (
                    <td key={y} className="px-2.5 py-1 text-center text-xs font-mono text-zinc-700 dark:text-zinc-300">
                      {computePrimeInstructionMontant(cfg, fn.key, y).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-3 py-2 text-[10px] text-zinc-400 dark:text-zinc-500 border-t border-zinc-100 dark:border-zinc-800">
            Valeurs calculées : année N = round(année N−1 × {cfg.multiplier}, 2). Seuls a1 (ICPL) et b1 (TRI OPL) sont stockés ; éditer via &laquo;&nbsp;Modifier&nbsp;&raquo;.
          </p>
        </>
      );
    }} />
  );
}

// ── Article 81 — Taux de séjour ───────────────────────────────────────────────
type Article81Data = {
  rates: { taux: Record<string, number | null>; duree: string }[];
  zones: string[];
  zones_labels: Record<string, string>;
  duree_min_h: number;
  plafond_jours: number;
  decompte_tranche_h: number;
  declenchement_jours_min: number;
};

const ZONE_COLORS: Record<string, { th: string; td: string }> = {
  AME: { th: 'bg-blue-600 text-white',    td: '' },
  CSA: { th: 'bg-teal-600 text-white',    td: '' },
  AFR: { th: 'bg-amber-500 text-white',   td: '' },
  MGI: { th: 'bg-sky-400 text-white',     td: '' },
  APC: { th: 'bg-red-500 text-white',     td: '' },
  PAC: { th: 'bg-slate-400 text-white',   td: '' },
  COI: { th: 'bg-cyan-600 text-white',    td: '' },
  EUR: { th: 'bg-zinc-300 text-zinc-800 dark:bg-zinc-600 dark:text-zinc-100', td: '' },
  FRA: { th: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200', td: '' },
};

function fmtTaux(v: number | null | undefined): string {
  if (v == null) return 'N/A';
  return `${Math.round(v * 100)} %`;
}

function Article81Card({ table, canEdit }: { table: AnnexeRow; canEdit: boolean }) {
  const d = table.data as Article81Data;
  const zones = d.zones;
  const zoneNum = Object.fromEntries(zones.map((z, i) => [z, i + 1]));

  const footerRows = [
    { label: 'Déclenchement',  text: `Prime de séjour à l'étranger si jours hors France ≥ ${d.declenchement_jours_min} jours / an` },
    { label: 'Durée minimale', text: `Déplacement hors France pris en compte si ≥ ${d.duree_min_h}h (entre heure d'atterrissage et de décollage) ; par tranche de ${d.decompte_tranche_h}h (${d.decompte_tranche_h / 24}j).` },
    { label: 'Plafond',        text: `${d.plafond_jours} premiers jours (pour 360/30e, ajusté en 30e de paie réel). TAF7 12/12 → 53,5. TAF7 10/12 → 56,5` },
  ];

  return (
    <Card title="Article 81 — Taux de séjour" table={table} canEdit={canEdit}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr>
              <th
                rowSpan={2}
                className="px-3 py-2 text-left text-[10px] font-medium text-zinc-400 uppercase tracking-wide bg-zinc-50 dark:bg-zinc-800/60 whitespace-nowrap align-bottom border-b border-r border-zinc-200 dark:border-zinc-700"
              >
                Durée
              </th>
              {zones.map(z => (
                <th key={z} className={`px-2 py-1 text-center text-[10px] font-semibold whitespace-nowrap border-b border-zinc-200 dark:border-zinc-700 ${(ZONE_COLORS[z] ?? ZONE_COLORS.EUR).th}`}>
                  Zone {zoneNum[z]} / {z}
                </th>
              ))}
            </tr>
            <tr>
              {zones.map(z => (
                <th key={z} className={`px-2 py-1.5 text-center text-[10px] font-medium leading-tight border-b border-zinc-200 dark:border-zinc-700 ${(ZONE_COLORS[z] ?? ZONE_COLORS.EUR).th}`}>
                  {d.zones_labels[z]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {d.rates.map((rate, i) => (
              <tr key={i} className={i % 2 ? 'bg-zinc-50/50 dark:bg-zinc-800/20' : ''}>
                <td className="px-3 py-1.5 font-medium text-zinc-600 dark:text-zinc-300 whitespace-nowrap bg-zinc-100/70 dark:bg-zinc-800/50 border-r border-zinc-200 dark:border-zinc-700">
                  {rate.duree}
                </td>
                {zones.map(z => (
                  <td key={z} className={`px-2 py-1.5 text-center font-mono ${rate.taux[z] == null ? 'text-zinc-400' : 'text-zinc-700 dark:text-zinc-300'}`}>
                    {fmtTaux(rate.taux[z])}
                  </td>
                ))}
              </tr>
            ))}
            {footerRows.map(({ label, text }, i) => (
              <tr key={label} className={`border-t-2 border-zinc-200 dark:border-zinc-700 ${i % 2 ? 'bg-zinc-50/50 dark:bg-zinc-800/20' : ''}`}>
                <td className="px-3 py-1.5 text-[10px] font-semibold text-zinc-500 whitespace-nowrap bg-zinc-50 dark:bg-zinc-800/60 border-r border-zinc-200 dark:border-zinc-700">
                  {label}
                </td>
                <td colSpan={zones.length} className="px-3 py-1.5 text-[10px] text-zinc-500 italic">
                  {text}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Zones par rotation (rotation_zones) ───────────────────────────────────────
type RotationZoneRow = { rot: string; zone: string };
type RotationZonesData = { version?: string; rotations: RotationZoneRow[] };

function RotationZonesCard({
  table, canEdit, availableZones,
}: {
  table: AnnexeRow;
  canEdit: boolean;
  availableZones: string[];
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newRot, setNewRot] = useState('');
  const [newZone, setNewZone] = useState(availableZones[0] ?? 'AFR');
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('');

  const data = (table.data as RotationZonesData) ?? { rotations: [] };
  const rows = Array.isArray(data.rotations) ? data.rotations : [];
  const sorted = [...rows].sort((a, b) => a.rot.localeCompare(b.rot));
  const filtered = filter
    ? sorted.filter(r => r.rot.toLowerCase().includes(filter.toLowerCase()) || r.zone.toLowerCase().includes(filter.toLowerCase()))
    : sorted;

  async function persist(next: RotationZoneRow[]): Promise<boolean> {
    setBusy(true);
    const payload: RotationZonesData = {
      version: new Date().toISOString().slice(0, 10),
      rotations: next,
    };
    const res = await saveAnnexeTable(table.slug, payload as unknown as Json, table.valid_from);
    setBusy(false);
    if (res.error) { setErr(res.error); return false; }
    return true;
  }

  function addRow() {
    const rot = newRot.trim().toUpperCase().replace(/\s+/g, ' ');
    if (!rot) { setErr('Code rotation requis'); return; }
    if (rows.some(r => r.rot === rot)) { setErr(`"${rot}" existe déjà`); return; }
    setErr('');
    start(async () => {
      const ok = await persist([...rows, { rot, zone: newZone }]);
      if (ok) { setNewRot(''); setAdding(false); router.refresh(); }
    });
  }

  function removeRow(rot: string) {
    if (!confirm(`Supprimer "${rot}" ?`)) return;
    start(async () => {
      const ok = await persist(rows.filter(r => r.rot !== rot));
      if (ok) router.refresh();
    });
  }

  function updateZone(rot: string, zone: string) {
    start(async () => {
      const ok = await persist(rows.map(r => r.rot === rot ? { ...r, zone } : r));
      if (ok) router.refresh();
    });
  }

  return (
    <Card
      title={`Zones par rotation (${rows.length})`}
      table={table}
      canEdit={canEdit}
      extraHeader={
        <input
          type="search"
          placeholder="Filtrer…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="w-28 rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-2 py-0.5 text-[10px]"
        />
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-800/60">
              <th className="px-3 py-1.5 text-left text-[10px] font-medium text-zinc-400 uppercase tracking-wide whitespace-nowrap border-b border-zinc-200 dark:border-zinc-700">ROT</th>
              <th className="px-3 py-1.5 text-left text-[10px] font-medium text-zinc-400 uppercase tracking-wide border-b border-zinc-200 dark:border-zinc-700">Zone</th>
              {canEdit && <th className="w-8 border-b border-zinc-200 dark:border-zinc-700"></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {filtered.map(({ rot, zone }, i) => {
              const c = (ZONE_COLORS[zone] ?? ZONE_COLORS.EUR).th;
              return (
                <tr key={rot} className={i % 2 ? 'bg-zinc-50/40 dark:bg-zinc-800/20' : ''}>
                  <td className="px-3 py-1 font-mono text-zinc-700 dark:text-zinc-200 whitespace-nowrap">{rot}</td>
                  <td className="px-3 py-1">
                    {canEdit ? (
                      <select
                        value={zone}
                        onChange={e => updateZone(rot, e.target.value)}
                        disabled={busy}
                        className={`px-2 py-0.5 rounded text-[10px] font-bold border-0 outline-none cursor-pointer appearance-none ${c}`}
                      >
                        {availableZones.map(z => <option key={z} value={z} className="bg-white text-zinc-900">{z}</option>)}
                      </select>
                    ) : (
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${c}`}>{zone}</span>
                    )}
                  </td>
                  {canEdit && (
                    <td className="px-1 text-center">
                      <button
                        onClick={() => removeRow(rot)}
                        disabled={busy}
                        className="text-zinc-300 hover:text-red-500 text-base leading-none w-6 h-6"
                        title="Supprimer"
                      >×</button>
                    </td>
                  )}
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={canEdit ? 3 : 2} className="px-3 py-4 text-center text-[10px] text-zinc-400 italic">
                  {filter ? 'Aucun résultat' : 'Aucune rotation'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div className="px-3 py-2 border-t border-zinc-100 dark:border-zinc-800 flex flex-wrap items-center gap-2">
          {!adding ? (
            <button
              onClick={() => { setAdding(true); setErr(''); }}
              className="text-[10px] px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200"
            >
              + Ajouter
            </button>
          ) : (
            <>
              <input
                type="text"
                value={newRot}
                onChange={e => setNewRot(e.target.value.toUpperCase())}
                placeholder="Ex: BZV PNR"
                autoFocus
                className="font-mono text-xs px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 w-40 uppercase"
              />
              <select
                value={newZone}
                onChange={e => setNewZone(e.target.value)}
                className={`px-2 py-1 rounded text-xs font-bold border-0 outline-none cursor-pointer appearance-none ${(ZONE_COLORS[newZone] ?? ZONE_COLORS.EUR).th}`}
              >
                {availableZones.map(z => <option key={z} value={z} className="bg-white text-zinc-900">{z}</option>)}
              </select>
              <button
                onClick={addRow}
                disabled={busy || !newRot.trim()}
                className="px-3 py-1 rounded bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-[10px] font-semibold disabled:opacity-40"
              >
                {busy ? '…' : 'Ajouter'}
              </button>
              <button
                onClick={() => { setAdding(false); setErr(''); setNewRot(''); }}
                className="px-3 py-1 rounded border border-zinc-200 dark:border-zinc-700 text-[10px] text-zinc-500 hover:text-zinc-700"
              >
                Annuler
              </button>
              {err && <span className="text-[10px] text-red-500 ml-1">{err}</span>}
            </>
          )}
          {data.version && (
            <span className="ml-auto text-[10px] text-zinc-400">v{data.version}</span>
          )}
        </div>
      )}
    </Card>
  );
}

// ── Définitions ───────────────────────────────────────────────────────────────
type DefinitionRow = { terme: string; definition: string; formule: string; is_header?: boolean };

function DefinitionsCard({ table, canEdit }: { table: AnnexeRow; canEdit: boolean }) {
  const rows = table.data as DefinitionRow[];
  return (
    <Card title="Définitions" table={table} canEdit={canEdit}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <colgroup>
            <col className="w-[10%]" />
            <col className="w-[57%]" />
            <col className="w-[33%]" />
          </colgroup>
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-800/60">
              <th className="px-2.5 py-1.5 text-left text-[10px] font-medium text-zinc-400 uppercase tracking-wide whitespace-nowrap border-b border-zinc-200 dark:border-zinc-700">Terme</th>
              <th className="px-2.5 py-1.5 text-left text-[10px] font-medium text-zinc-400 uppercase tracking-wide border-b border-zinc-200 dark:border-zinc-700">Définition</th>
              <th className="px-2.5 py-1.5 text-left text-[10px] font-medium text-zinc-400 uppercase tracking-wide border-b border-zinc-200 dark:border-zinc-700">Formule</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map((row, i) => (
              <tr key={i} className={i % 2 ? 'bg-zinc-50/50 dark:bg-zinc-800/20' : ''}>
                <td className="px-2.5 py-1.5 font-mono font-semibold text-zinc-700 dark:text-zinc-200 whitespace-nowrap align-top">{row.terme}</td>
                <td className="px-2.5 py-1.5 text-zinc-600 dark:text-zinc-300 leading-relaxed align-top">{row.definition}</td>
                <td className="px-2.5 py-1.5 font-mono text-zinc-700 dark:text-zinc-200 align-top">{row.formule}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Generic fallback ───────────────────────────────────────────────────────────
function GenericCard({ table, canEdit }: { table: AnnexeRow; canEdit: boolean }) {
  const isArray = Array.isArray(table.data);
  const rows = isArray ? (table.data as Record<string, Json>[]) : null;
  const headers = rows && rows.length > 0 ? Object.keys(rows[0]) : [];
  return (
    <Card title={table.name} table={table} canEdit={canEdit}>
      <div className="overflow-x-auto">
        {rows ? (
          <MiniTable headers={headers} rows={rows.map(row => headers.map(h => row[h] == null ? '—' : String(row[h])))} />
        ) : (
          <pre className="p-3 text-[10px] font-mono text-zinc-600 dark:text-zinc-300 overflow-x-auto">
            {JSON.stringify(table.data, null, 2)}
          </pre>
        )}
      </div>
    </Card>
  );
}

// ── IR / MF Rates ─────────────────────────────────────────────────────────────
type IrMfRate = { escale: string; country: string; currency?: string; ir_eur: number; mf_eur: number };

function parseIrCsv(csv: string): IrMfRate[] {
  const lines = csv.trim().split('\n').slice(1); // skip header
  const result: IrMfRate[] = [];
  for (const line of lines) {
    // handle quoted fields with commas inside
    const parts = line.match(/(".*?"|[^,]+)(?:,|$)/g)?.map(s => s.replace(/^"|"$|,$/g, '').trim()) ?? [];
    if (parts.length < 4) continue;
    const parseEur = (s: string) => parseFloat(s.replace('€', '').replace(',', '.').trim()) || 0;
    result.push({ escale: parts[0], country: parts[1], ir_eur: parseEur(parts[2]), mf_eur: parseEur(parts[3]) });
  }
  return result;
}

function IrMfRatesCard({ table, canEdit }: { table: AnnexeRow; canEdit: boolean }) {
  const [filter, setFilter]         = useState('');
  const [showAdd, setShowAdd]       = useState(false);
  const [showCsv, setShowCsv]       = useState(false);
  const [csvText, setCsvText]       = useState('');
  const [newEscale, setNewEscale]   = useState('');
  const [newPays, setNewPays]       = useState('');
  const [newIr, setNewIr]           = useState('');
  const [newMf, setNewMf]           = useState('');
  const [err, setErr]               = useState('');
  const [saved, setSaved]           = useState('');
  const [isPending, start]          = useTransition();
  const router = useRouter();

  const rates = (table.data as IrMfRate[]).slice().sort((a, b) => a.escale.localeCompare(b.escale));
  const filtered = filter
    ? rates.filter(r => r.escale.toLowerCase().includes(filter.toLowerCase()) || r.country.toLowerCase().includes(filter.toLowerCase()))
    : rates;

  function doSave(newData: IrMfRate[], msg: string) {
    setErr('');
    start(async () => {
      const sorted = newData.slice().sort((a, b) => a.escale.localeCompare(b.escale));
      const res = await saveAnnexeTable(table.slug, sorted as unknown as Json, table.valid_from);
      if (res.error) { setErr(res.error); }
      else {
        setSaved(msg); setShowAdd(false); setShowCsv(false);
        setTimeout(() => setSaved(''), 3000);
        router.refresh();
      }
    });
  }

  function handleAdd() {
    const ir = parseFloat(newIr.replace(',', '.'));
    const mf = parseFloat(newMf.replace(',', '.'));
    if (!newEscale || isNaN(ir)) { setErr('Escale et IR requis'); return; }
    const without = rates.filter(r => r.escale.toUpperCase() !== newEscale.toUpperCase());
    doSave([...without, { escale: newEscale.toUpperCase(), country: newPays.toUpperCase(), ir_eur: ir, mf_eur: isNaN(mf) ? ir * 0.2 : mf }], `✓ ${newEscale.toUpperCase()} ajouté`);
    setNewEscale(''); setNewPays(''); setNewIr(''); setNewMf('');
  }

  function handleCsvImport() {
    const parsed = parseIrCsv(csvText);
    if (!parsed.length) { setErr('CSV invalide ou vide'); return; }
    doSave(parsed, `✓ ${parsed.length} escales importées`);
    setCsvText('');
  }

  function handleDelete(escale: string) {
    doSave(rates.filter(r => r.escale !== escale), `✓ ${escale} supprimé`);
  }

  return (
    <Card title="Indemnité Repas & Menus Frais — taux par escale" table={table} canEdit={canEdit}>
      {/* Barre recherche + actions */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-zinc-100 dark:border-zinc-800">
        <input
          value={filter} onChange={e => setFilter(e.target.value)}
          placeholder="Filtrer escale ou pays…"
          className="flex-1 min-w-[160px] text-[11px] px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200"
        />
        <span className="text-[10px] text-zinc-400">{filtered.length} / {rates.length}</span>
        {canEdit && (
          <>
            <button onClick={() => { setShowAdd(v => !v); setShowCsv(false); setErr(''); }}
              className="text-[10px] px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
              + Escale
            </button>
            <button onClick={() => { setShowCsv(v => !v); setShowAdd(false); setErr(''); }}
              className="text-[10px] px-2 py-1 rounded border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30">
              Importer CSV
            </button>
          </>
        )}
        {saved && <span className="text-[10px] text-green-500 font-medium">{saved}</span>}
      </div>

      {/* Formulaire ajout */}
      {showAdd && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-zinc-50 dark:bg-zinc-800/50 border-b border-zinc-100 dark:border-zinc-800 text-[11px]">
          <input placeholder="ESCALE" value={newEscale} onChange={e => setNewEscale(e.target.value)}
            className="w-20 px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 font-mono uppercase" />
          <input placeholder="PAYS" value={newPays} onChange={e => setNewPays(e.target.value)}
            className="w-36 px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800" />
          <input placeholder="IR €" value={newIr} onChange={e => setNewIr(e.target.value)}
            className="w-20 px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 font-mono" />
          <input placeholder="MF € (auto ×20%)" value={newMf} onChange={e => setNewMf(e.target.value)}
            className="w-28 px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 font-mono" />
          <button onClick={handleAdd} disabled={isPending}
            className="px-3 py-1 rounded bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 font-semibold disabled:opacity-40">
            {isPending ? '…' : 'Ajouter'}
          </button>
          {err && <span className="text-red-500">{err}</span>}
        </div>
      )}

      {/* Import CSV */}
      {showCsv && (
        <div className="px-3 py-2 bg-blue-50 dark:bg-blue-950/30 border-b border-blue-100 dark:border-blue-900 space-y-2">
          <p className="text-[10px] text-blue-700 dark:text-blue-300">
            Colle le contenu du CSV (avec en-tête : ESCALE, PAYS, IR…, MF…). Remplace toutes les escales existantes.
          </p>
          <textarea value={csvText} onChange={e => setCsvText(e.target.value)}
            rows={6} placeholder="ESCALE,PAYS,IR AF…,MF AF…&#10;JNB/CPT,AFRIQUE DU SUD,&quot;22,28€&quot;,…"
            className="w-full font-mono text-[10px] px-2 py-1.5 rounded border border-blue-200 dark:border-blue-800 bg-white dark:bg-zinc-900 resize-y" />
          <div className="flex gap-2 items-center">
            <button onClick={handleCsvImport} disabled={isPending || !csvText.trim()}
              className="px-3 py-1 rounded bg-blue-600 text-white text-[10px] font-semibold disabled:opacity-40">
              {isPending ? '…' : 'Importer'}
            </button>
            <button onClick={() => setShowCsv(false)} className="text-[10px] text-zinc-500 hover:text-zinc-700">Annuler</button>
            {err && <span className="text-[10px] text-red-500">{err}</span>}
          </div>
        </div>
      )}

      {/* Tableau */}
      <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-800/90 z-10">
            <tr>
              <th className="px-2.5 py-1.5 text-left text-[10px] font-medium text-zinc-400 uppercase tracking-wide whitespace-nowrap">Escale</th>
              <th className="px-2.5 py-1.5 text-left text-[10px] font-medium text-zinc-400 uppercase tracking-wide">Pays</th>
              <th className="px-2.5 py-1.5 text-right text-[10px] font-medium text-zinc-400 uppercase tracking-wide whitespace-nowrap">IR €</th>
              <th className="px-2.5 py-1.5 text-right text-[10px] font-medium text-zinc-400 uppercase tracking-wide whitespace-nowrap">MF €</th>
              {canEdit && <th className="w-6" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {filtered.map((r, i) => (
              <tr key={r.escale} className={i % 2 ? 'bg-zinc-50/50 dark:bg-zinc-800/20' : ''}>
                <td className="px-2.5 py-1 font-mono font-semibold text-zinc-700 dark:text-zinc-200 whitespace-nowrap">{r.escale}</td>
                <td className="px-2.5 py-1 text-zinc-500 dark:text-zinc-400">{r.country}</td>
                <td className="px-2.5 py-1 text-right font-mono text-zinc-700 dark:text-zinc-300">{r.ir_eur.toFixed(2)}</td>
                <td className="px-2.5 py-1 text-right font-mono text-zinc-500 dark:text-zinc-400">{r.mf_eur.toFixed(2)}</td>
                {canEdit && (
                  <td className="px-1 py-1 text-center">
                    <button onClick={() => handleDelete(r.escale)} disabled={isPending}
                      className="text-zinc-300 hover:text-red-500 dark:text-zinc-600 dark:hover:text-red-400 text-[10px] leading-none disabled:opacity-30">
                      ×
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── DDA / VOL P rules ─────────────────────────────────────────────────────────
type DdaRulesData = {
  version: string;
  rules: DdaRuleRow[];
};

type DdaRuleRow = {
  from: string;
  to: string;
  gap_from: string;
  gap_to: string;
  ok?: number[];
  forbidden?: number[];
  min_ok_above?: number;
  rpc_dependent?: boolean;
  rpc?: Record<string, { ok: number[]; forbidden: number[]; min_ok_above: number }>;
  rpc_report_alt?: { ok?: number[]; note?: string };
};

const CAT_SHORT: Record<string, string> = {
  DDA_REPOS: 'DDA REPOS',
  DDA_VOL: 'DDA VOL',
  VOL_P: 'VOL P',
  CONGES: 'CONGES',
};

const GAP_REF_SHORT: Record<string, string> = {
  end: 'fin',
  start: 'début',
  block_off: 'départ',
  rpc_first_day: 'après 1er j. RPC',
  rpc_last_day: 'après dernier j. RPC',
  end_no_rpc: 'fin (RPC ignoré)',
};

const MAX_GAP_COL = 6;

function gapVerdict(bucket: { ok?: number[]; forbidden?: number[]; min_ok_above?: number }, gap: number): 'OK' | 'X' {
  if (bucket.ok?.includes(gap)) return 'OK';
  if (bucket.min_ok_above != null && gap >= bucket.min_ok_above) return 'OK';
  if (bucket.forbidden?.includes(gap)) return 'X';
  return 'OK';
}

function RuleMatrixRow({ label, bucket, refSuffix }: {
  label: string;
  bucket: { ok?: number[]; forbidden?: number[]; min_ok_above?: number };
  refSuffix?: string;
}) {
  return (
    <tr>
      <td className="px-2 py-1 text-[11px] font-medium text-zinc-700 dark:text-zinc-200 whitespace-nowrap">
        {label}
        {refSuffix && <span className="ml-1 text-[9px] text-zinc-400 font-normal">({refSuffix})</span>}
      </td>
      {Array.from({ length: MAX_GAP_COL + 1 }, (_, gap) => {
        const v = gapVerdict(bucket, gap);
        const isPlus = gap === MAX_GAP_COL && bucket.min_ok_above != null && bucket.min_ok_above <= MAX_GAP_COL;
        return (
          <td key={gap}
            className={`px-1 py-1 text-center text-[10px] font-mono font-semibold ${
              v === 'OK' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                         : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
            }`}>
            {v === 'OK' ? 'OK' : 'X'}
            {isPlus && v === 'OK' && <span className="text-[8px] opacity-60">+</span>}
          </td>
        );
      })}
    </tr>
  );
}

function DdaRulesCard({ table, canEdit }: { table: AnnexeRow; canEdit: boolean }) {
  const d = table.data as unknown as DdaRulesData;
  const rules = Array.isArray(d?.rules) ? d.rules : [];

  return (
    <Card title={table.name} table={table} canEdit={canEdit}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-800/60">
              <th className="px-2 py-1.5 text-left text-[10px] font-medium text-zinc-400 uppercase tracking-wide whitespace-nowrap">Paire</th>
              {Array.from({ length: MAX_GAP_COL + 1 }, (_, g) => (
                <th key={g} className="px-1 py-1.5 text-center text-[10px] font-medium text-zinc-400 whitespace-nowrap">
                  gap {g}{g === MAX_GAP_COL ? '+' : ''}j
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rules.flatMap((r, i) => {
              const label = `${CAT_SHORT[r.from] ?? r.from} → ${CAT_SHORT[r.to] ?? r.to}`;
              const ref = `${GAP_REF_SHORT[r.gap_from] ?? r.gap_from} → ${GAP_REF_SHORT[r.gap_to] ?? r.gap_to}`;
              if (r.rpc_dependent && r.rpc) {
                return Object.entries(r.rpc).map(([rpcDays, bucket]) => (
                  <RuleMatrixRow
                    key={`${i}-${rpcDays}`}
                    label={`${label} · RPC ${rpcDays}j`}
                    bucket={bucket}
                    refSuffix={ref}
                  />
                ));
              }
              return [
                <RuleMatrixRow
                  key={i}
                  label={label}
                  bucket={{ ok: r.ok, forbidden: r.forbidden, min_ok_above: r.min_ok_above }}
                  refSuffix={ref}
                />,
                ...(r.rpc_report_alt ? [
                  <tr key={`${i}-alt`} className="bg-amber-50/40 dark:bg-amber-900/10">
                    <td colSpan={MAX_GAP_COL + 2} className="px-2 py-1 text-[10px] text-amber-700 dark:text-amber-300 italic">
                      ↳ Option : si report RPC accepté à la fin des CONGES → gap {r.rpc_report_alt.ok?.join('/')}j OK
                    </td>
                  </tr>
                ] : []),
              ];
            })}
          </tbody>
        </table>
      </div>
      <p className="px-3 py-1.5 text-[10px] text-zinc-400 border-t border-zinc-100 dark:border-zinc-800">
        Légende : <strong>OK</strong> = enchaînement autorisé · <strong>X</strong> = interdit · <strong>+</strong> = et au-delà.
        Référentiel des dates entre parenthèses (jour pris comme origine du gap pour chaque item).
      </p>
    </Card>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────
const KNOWN = ['cat_anciennete', 'coef_classe', 'taux_avion', 'prime_incitation', 'prime_incitation_330', 'traitement_base', 'prorata', 'prime_instruction', 'article_81', 'definitions', 'ir_mf_rates', 'dda_rules', 'vol_p_rules', 'rotation_zones'];

const VERSIONED_SLUGS = new Set(['taux_avion', 'prime_incitation', 'traitement_base', 'prime_instruction']);

export function AnnexeClient({ rows, canEdit }: { rows: AnnexeRow[]; canEdit: boolean }) {
  // Groupe par slug, trie par valid_from desc (plus récent d'abord).
  const bySlug = new Map<string, AnnexeRow[]>();
  for (const row of rows) {
    if (!bySlug.has(row.slug)) bySlug.set(row.slug, []);
    bySlug.get(row.slug)!.push(row);
  }
  for (const list of bySlug.values()) list.sort((a, b) => b.valid_from.localeCompare(a.valid_from));

  // Pour les slugs non-versionnés : on prend la plus récente. Pour les
  // versionnés : on passe toute la liste à VersionedCard via le wrapper.
  const latest = (slug: string) => bySlug.get(slug)?.[0];
  const versions = (slug: string) => bySlug.get(slug) ?? [];

  const others = rows.filter(r => !KNOWN.includes(r.slug));
  // Pour les non-versionnés inconnus → on prend juste la plus récente par slug
  const othersLatest = new Map<string, AnnexeRow>();
  for (const r of others) if (!othersLatest.has(r.slug)) othersLatest.set(r.slug, r);

  const catAnc      = latest('cat_anciennete');
  const coefCl      = latest('coef_classe');
  const prime330    = latest('prime_incitation_330');
  const prorata     = latest('prorata');
  const a81         = latest('article_81');
  const ddaRules    = latest('dda_rules');
  const volPRules   = latest('vol_p_rules');
  const definitions = latest('definitions');
  const irMfLatest  = latest('ir_mf_rates');
  const rotZones    = latest('rotation_zones');

  // Zones dispo pour le dropdown : on les prend du tableau Article 81 (source
  // canonique des libellés/codes zones), en retirant FRA (base, jamais une
  // destination de rotation).
  const a81Zones = (a81?.data as Article81Data | null)?.zones ?? [];
  const rotZonesAvailable = a81Zones.filter(z => z !== 'FRA');

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">Annexe — Tables de référence</h1>
        {canEdit && (
          <span className="text-xs bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 px-2 py-1 rounded-full font-medium">
            Mode édition
          </span>
        )}
      </div>

      {/* 1. Ancienneté + Classe */}
      <div className="grid grid-cols-2 gap-4">
        {catAnc && <CatAncienneteCard table={catAnc} canEdit={canEdit} />}
        {coefCl && <CoefClasseCard    table={coefCl} canEdit={canEdit} />}
      </div>

      {/* 2. Taux avion + Primes d'incitation */}
      <div className="grid grid-cols-3 gap-4">
        {VERSIONED_SLUGS.has('taux_avion') && versions('taux_avion').length > 0 && (
          <TauxAvionCard versions={versions('taux_avion')} canEdit={canEdit} />
        )}
        {versions('prime_incitation').length > 0 && (
          <PrimeIncitationCard versions={versions('prime_incitation')} canEdit={canEdit} />
        )}
        {prime330 && <PrimeIncitation330Card table={prime330} canEdit={canEdit} />}
      </div>

      {/* 3. Traitement fixe (versionné) */}
      {versions('traitement_base').length > 0 && (
        <TraitementBaseCard versions={versions('traitement_base')} canEdit={canEdit} />
      )}

      {/* 4. Prorata */}
      {prorata && <ProrataCard table={prorata} canEdit={canEdit} />}

      {/* 5. Prime d'instruction (versionné) */}
      {versions('prime_instruction').length > 0 && (
        <PrimeInstructionCard versions={versions('prime_instruction')} canEdit={canEdit} />
      )}

      {/* 6. Article 81 */}
      {a81 && <Article81Card table={a81} canEdit={canEdit} />}

      {/* 6b. Zones par rotation (mapping ROT → zone A81) */}
      {rotZones && <RotationZonesCard table={rotZones} canEdit={canEdit} availableZones={rotZonesAvailable} />}

      {/* 7. IR / MF — toujours visible (même si la ligne DB manque) */}
      <IrMfRatesCard
        table={irMfLatest ?? { slug: 'ir_mf_rates', valid_from: '2025-04-01', name: 'IR + MF', description: null, data: [], updated_at: '' }}
        canEdit={canEdit}
      />

      {/* 8. Règles DDA / VOL P */}
      {ddaRules  && <DdaRulesCard table={ddaRules}  canEdit={canEdit} />}
      {volPRules && <DdaRulesCard table={volPRules} canEdit={canEdit} />}

      {/* 9. Définitions */}
      {definitions && <DefinitionsCard table={definitions} canEdit={canEdit} />}

      {/* Autres */}
      {[...othersLatest.values()].map(t => <GenericCard key={t.slug} table={t} canEdit={canEdit} />)}
    </div>
  );
}
