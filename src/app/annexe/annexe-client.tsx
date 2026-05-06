'use client';

import { useState, useTransition } from 'react';
import { saveAnnexeTable } from '@/app/actions/annexe';
import type { Json } from '@/types/supabase';

type AnnexeRow = { slug: string; name: string; description: string | null; data: Json; updated_at: string; };

// ── Shared card shell ──────────────────────────────────────────────────────────
function Card({
  title, children, table, canEdit,
}: {
  title: string;
  children: React.ReactNode;
  table: AnnexeRow;
  canEdit: boolean;
}) {
  const [editing, setEditing]   = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [err, setErr]           = useState('');
  const [saved, setSaved]       = useState(false);
  const [isPending, start]      = useTransition();

  function startEdit() { setJsonText(JSON.stringify(table.data, null, 2)); setErr(''); setEditing(true); }

  function handleSave() {
    setErr('');
    let parsed: Json;
    try { parsed = JSON.parse(jsonText); } catch { setErr('JSON invalide'); return; }
    start(async () => {
      const res = await saveAnnexeTable(table.slug, parsed);
      if (res.error) setErr(res.error);
      else { setSaved(true); setEditing(false); setTimeout(() => setSaved(false), 3000); }
    });
  }

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-100 dark:border-zinc-800">
        <p className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 uppercase tracking-wide">{title}</p>
        <div className="flex items-center gap-2">
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

// ── Section 1 cards ────────────────────────────────────────────────────────────
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

// ── Section 2 cards ────────────────────────────────────────────────────────────
function TauxAvionCard({ table, canEdit }: { table: AnnexeRow; canEdit: boolean }) {
  const rows = (table.data as { avion: string; taux: number }[]).filter(r => r.avion !== 'Groupe');
  return (
    <Card title="Taux horaire (€/h)" table={table} canEdit={canEdit}>
      <MiniTable headers={['Avion', 'Taux']} rows={rows.map(r => [r.avion, r.taux])} />
    </Card>
  );
}

function PrimeIncitationCard({ table, canEdit }: { table: AnnexeRow; canEdit: boolean }) {
  const rows = table.data as { role: string; type: string; montant: number }[];
  return (
    <Card title="Prime d'incitation" table={table} canEdit={canEdit}>
      <MiniTable headers={['', '€']} rows={rows.map(r => [`${r.role} ${r.type}`, r.montant])} />
    </Card>
  );
}

function PrimeIncitation330Card({ table, canEdit }: { table: AnnexeRow; canEdit: boolean }) {
  const all = table.data as { seuil: string; mois_max?: number; valeur_pvei: number }[];
  const rows = all
    .filter(r => r.mois_max !== undefined)
    .sort((a, b) => (b.mois_max ?? 0) - (a.mois_max ?? 0));
  return (
    <Card title="Prime d'incitation 330" table={table} canEdit={canEdit}>
      <MiniTable headers={['Seuil', 'PVEI ×']} rows={rows.map(r => [r.seuil, r.valeur_pvei])} />
    </Card>
  );
}

// ── Section 3: traitement_base ─────────────────────────────────────────────────
function TraitementBaseCard({ table, canEdit }: { table: AnnexeRow; canEdit: boolean }) {
  const d = table.data as { note?: string; coef_opl: number; base_cdb_a1: number };
  const label = d.note ?? 'CDB A1';
  return (
    <Card title="Traitement mensuel fixe de référence" table={table} canEdit={canEdit}>
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
    </Card>
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

// ── Section 5: prime_instruction ──────────────────────────────────────────────
type PrimeInstRow = { annee: number; montant: number; fonction: string };

function PrimeInstructionCard({ table, canEdit }: { table: AnnexeRow; canEdit: boolean }) {
  const all = table.data as PrimeInstRow[];
  const years   = [...new Set(all.map(r => r.annee))].sort((a, b) => a - b);
  const fonctions = [...new Set(all.map(r => r.fonction))];
  const byKey = Object.fromEntries(all.map(r => [`${r.fonction}-${r.annee}`, r.montant]));
  return (
    <Card title="Prime mensuelle d'instruction" table={table} canEdit={canEdit}>
      <table className="w-full">
        <thead>
          <tr className="bg-zinc-50 dark:bg-zinc-800/60">
            <th className="px-2.5 py-1.5 text-left text-[10px] font-medium text-zinc-400 uppercase tracking-wide whitespace-nowrap">Année</th>
            {years.map(y => (
              <th key={y} className="px-2.5 py-1.5 text-center text-[10px] font-medium text-zinc-400 uppercase tracking-wide">{y}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {fonctions.map((fn, i) => (
            <tr key={fn} className={i % 2 ? 'bg-zinc-50/50 dark:bg-zinc-800/20' : ''}>
              <td className="px-2.5 py-1 text-xs font-medium text-zinc-500 whitespace-nowrap">
                {fn === 'TRI_OPL' ? 'TRI OPL' : fn}
              </td>
              {years.map(y => (
                <td key={y} className="px-2.5 py-1 text-center text-xs font-mono text-zinc-700 dark:text-zinc-300">
                  {byKey[`${fn}-${y}`]?.toLocaleString('fr-FR', { minimumFractionDigits: 2 }) ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
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

// ── Main ───────────────────────────────────────────────────────────────────────
const KNOWN = ['cat_anciennete', 'coef_classe', 'taux_avion', 'prime_incitation', 'prime_incitation_330', 'traitement_base', 'prorata', 'prime_instruction', 'article_81', 'definitions'];

export function AnnexeClient({ tables, canEdit }: { tables: AnnexeRow[]; canEdit: boolean }) {
  const by = Object.fromEntries(tables.map(t => [t.slug, t]));
  const others = tables.filter(t => !KNOWN.includes(t.slug));

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
        {by.cat_anciennete && <CatAncienneteCard table={by.cat_anciennete} canEdit={canEdit} />}
        {by.coef_classe    && <CoefClasseCard    table={by.coef_classe}    canEdit={canEdit} />}
      </div>

      {/* 2. Taux avion + Primes d'incitation */}
      <div className="grid grid-cols-3 gap-4">
        {by.taux_avion          && <TauxAvionCard          table={by.taux_avion}          canEdit={canEdit} />}
        {by.prime_incitation    && <PrimeIncitationCard    table={by.prime_incitation}    canEdit={canEdit} />}
        {by.prime_incitation_330 && <PrimeIncitation330Card table={by.prime_incitation_330} canEdit={canEdit} />}
      </div>

      {/* 3. Traitement fixe */}
      {by.traitement_base && <TraitementBaseCard table={by.traitement_base} canEdit={canEdit} />}

      {/* 4. Prorata */}
      {by.prorata && <ProrataCard table={by.prorata} canEdit={canEdit} />}

      {/* 5. Prime d'instruction */}
      {by.prime_instruction && <PrimeInstructionCard table={by.prime_instruction} canEdit={canEdit} />}

      {/* 6. Article 81 */}
      {by.article_81 && <Article81Card table={by.article_81} canEdit={canEdit} />}

      {/* 7. Définitions */}
      {by.definitions && <DefinitionsCard table={by.definitions} canEdit={canEdit} />}

      {/* Autres */}
      {others.map(t => <GenericCard key={t.slug} table={t} canEdit={canEdit} />)}
    </div>
  );
}
