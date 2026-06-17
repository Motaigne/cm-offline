'use client';

// Vue "Import EP4 PDF" — multi-mois.
// Architecture :
// - Le parsing PDF reste dans cette vue (status / error local).
// - Le STOCKAGE est délégué à Dexie via les callbacks fournis par
//   Ep4PageClient (qui détient la liste des imports + le mois sélectionné).
// - Permet de garder ~12-13 EP4 mensuels accessibles offline (un par mois),
//   sans repasser par le PDF.

import { useRef, useState } from 'react';
import {
  parseEp4PdfFile, Ep4FormatError,
} from '@/lib/ep4-pdf-extract';
import type { Ep4PdfData } from '@/lib/ep4-pdf-parse';
import type { StoredEp4Import } from '@/lib/local-db';
import { diffKey } from '@/lib/ep4-diff';

/** Classe Tailwind row "divergente" — alignée avec ep4-tables.tsx (DIFF_ROW_CLASS). */
const DIFF_ROW_CLASS = 'bg-amber-50/60 dark:bg-amber-950/30';

const MONTH_FR = ['Janvier','Février','Mars','Avril','Mai','Juin',
                  'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

function monthLabel(monthIso: string): string {
  const [y, m] = monthIso.split('-').map(Number);
  if (!y || !m) return monthIso;
  return `${MONTH_FR[m - 1]} ${y}`;
}

export interface Ep4ImportSummary {
  monthIso:   string;
  importedAt: string;
  fileName:   string;
}

interface Props {
  imports:        Ep4ImportSummary[];
  selectedMonth:  string | null;
  currentImport:  StoredEp4Import | null;
  onSelectMonth:  (monthIso: string) => void;
  /** Le parent gère le save Dexie + refresh de la liste. */
  onImportSuccess: (data: Ep4PdfData, fileName: string) => Promise<void>;
  onDeleteMonth:  (monthIso: string) => void;
}

export function Ep4ImportView({
  imports, selectedMonth, currentImport,
  onSelectMonth, onImportSuccess, onDeleteMonth,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [parsing, setParsing]   = useState<{ fileName: string } | null>(null);
  const [parseError, setParseError] = useState<{ fileName: string; msg: string } | null>(null);

  async function handleFile(file: File) {
    setParsing({ fileName: file.name });
    setParseError(null);
    try {
      const buffer = await file.arrayBuffer();
      const data = await parseEp4PdfFile(buffer);
      if (!data.meta.monthIso) {
        throw new Ep4FormatError("Mois introuvable dans l'EP4 (méta.monthIso vide).");
      }
      await onImportSuccess(data, file.name);
      setParsing(null);
    } catch (e) {
      const msg = e instanceof Ep4FormatError
        ? `Format non reconnu : ${e.message}`
        : `Erreur de parsing : ${String((e as Error)?.message ?? e)}`;
      setParseError({ fileName: file.name, msg });
      setParsing(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Bandeau d'import */}
      <section className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => inputRef.current?.click()}
            disabled={parsing !== null}
            className="flex items-center gap-1.5 px-3 h-8 rounded bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            Importer un EP4 (.pdf)
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = ''; // permet de re-choisir le même fichier
            }}
          />
          {parsing && (
            <span className="text-xs text-zinc-500">
              Lecture <span className="font-mono">{parsing.fileName}</span>…
            </span>
          )}
        </div>
        <p className="text-[11px] text-zinc-500 mt-2">
          Le fichier reste sur votre appareil — il n&apos;est jamais envoyé sur un serveur.
          Les EP4 importés sont conservés localement (un par mois).
        </p>
      </section>

      {/* Erreur de parsing */}
      {parseError && (
        <section className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-xl p-4">
          <p className="text-sm font-semibold text-red-700 dark:text-red-400">
            Impossible de lire <span className="font-mono">{parseError.fileName}</span>
          </p>
          <p className="text-xs mt-1 text-red-600 dark:text-red-400/80">{parseError.msg}</p>
        </section>
      )}

      {/* Sélecteur de mois importés */}
      {imports.length > 0 && (
        <section className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
          <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">
            EP4 importés ({imports.length})
          </h3>
          <div className="flex flex-wrap gap-2">
            {imports.map(imp => {
              const active = imp.monthIso === selectedMonth;
              return (
                <button
                  key={imp.monthIso}
                  onClick={() => onSelectMonth(imp.monthIso)}
                  title={`Importé le ${imp.importedAt.slice(0, 10)} — ${imp.fileName}`}
                  className={`px-3 h-7 rounded-full text-xs font-semibold transition-colors ${
                    active
                      ? 'bg-blue-600 text-white'
                      : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                  }`}
                >
                  {monthLabel(imp.monthIso)}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Warnings + data du mois sélectionné */}
      {currentImport && (
        <>
          <div className="flex items-center justify-between text-xs text-zinc-500 px-1">
            <span>
              <span className="text-emerald-600 dark:text-emerald-400">✓</span>{' '}
              <span className="font-mono">{currentImport.fileName}</span>
              <span className="mx-2">·</span>
              importé le {currentImport.importedAt.slice(0, 10)}
              {currentImport.data.warnings.length > 0 && (
                <span className="ml-2 text-amber-600 dark:text-amber-400">
                  {currentImport.data.warnings.length} warning(s)
                </span>
              )}
            </span>
            <button
              onClick={() => onDeleteMonth(currentImport.monthIso)}
              className="text-zinc-400 hover:text-red-500 underline"
              title="Supprimer cet EP4 du stockage local"
            >
              Supprimer ce mois
            </button>
          </div>

          {currentImport.data.warnings.length > 0 && (
            <section className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl p-3">
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">Warnings de parsing :</p>
              <ul className="mt-1 list-disc list-inside text-[11px] text-amber-700 dark:text-amber-400/90">
                {currentImport.data.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </section>
          )}

          <Ep4ImportTables data={currentImport.data} />
        </>
      )}

      {/* Cas vide : aucun import + pas de parsing en cours */}
      {imports.length === 0 && !parsing && !parseError && (
        <section className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-6 text-center">
          <p className="text-sm text-zinc-400">
            Aucun EP4 importé pour le moment.
          </p>
          <p className="text-xs text-zinc-400/70 mt-1">
            Clique sur <strong>Importer un EP4 (.pdf)</strong> ci-dessus pour démarrer.
          </p>
        </section>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Affichage des données extraites (identique à la V1 mais sans state local)
// ───────────────────────────────────────────────────────────────────────────

function Ep4ImportTables({ data }: { data: Ep4PdfData }) {
  return (
    <>
      <MetaPanel meta={data.meta} />
      <HorairePanel rows={data.horaire.rows} />
      <ActivitePanel
        rows={data.activite.rows}
        totaux={data.activite.totaux}
        summary={data.activite.summary}
      />
      <FraisPanel rows={data.frais.rows} totaux={data.frais.totaux} />
    </>
  );
}

// Panels exportés pour ré-affichage dans les onglets Feuille Horaire / Décompte /
// Frais de /ep4 (= comparaison à l'œil avec le tableau calculé).
export {
  HorairePanel as Ep4ImportHorairePanel,
  ActivitePanel as Ep4ImportActivitePanel,
  FraisPanel as Ep4ImportFraisPanel,
};

function MetaPanel({ meta }: { meta: Ep4PdfData['meta'] }) {
  const cells: { label: string; value: string | null }[] = [
    { label: 'Mois',       value: meta.monthLabel },
    { label: 'Base',       value: meta.base },
    { label: 'Spécialité', value: meta.specialite },
    { label: 'Libellé',    value: meta.libelle },
    { label: 'Classe',     value: meta.classe },
    { label: 'Échelon',    value: meta.echelon },
    { label: 'Nom',        value: meta.nom },
    { label: 'Prénom',     value: meta.prenom },
    { label: 'Matricule',  value: meta.matricule },
    { label: 'Édité le',   value: meta.ediLe?.replace(/^Edit[ée]\s+le\s+/, '') ?? null },
  ];
  return (
    <section className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
      <h3 className="text-sm font-semibold mb-3">Métadonnées</h3>
      <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-4 gap-y-2 text-xs">
        {cells.map(c => (
          <div key={c.label}>
            <dt className="text-zinc-400 uppercase tracking-wide text-[10px]">{c.label}</dt>
            <dd className="font-mono text-zinc-800 dark:text-zinc-200">{c.value ?? '—'}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function kindBadge(kind: 'normal' | 'spillover_info' | 'spillover_prorata') {
  if (kind === 'normal') return null;
  const label = kind === 'spillover_info' ? 'info' : 'prorata';
  const cls   = kind === 'spillover_info'
    ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'
    : 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400';
  return (
    <span className={`inline-block px-1 rounded text-[9px] uppercase font-bold tracking-wide ${cls}`}>
      {label}
    </span>
  );
}

function fmt(n: number | null): string { return n == null ? '—' : String(n); }
function rawH(h: { raw: string } | null): string { return h?.raw ?? '—'; }

function HorairePanel({
  rows, highlightedKeys,
}: {
  rows: Ep4PdfData['horaire']['rows'];
  highlightedKeys?: Set<string>;
}) {
  return (
    <section className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
      <h3 className="text-sm font-semibold mb-3">Feuille Horaire — {rows.length} lignes</h3>
      <div className="overflow-x-auto">
        <table className="min-w-full text-[11px] font-mono">
          <thead className="text-zinc-400 uppercase tracking-wide text-[9px]">
            <tr>
              <th className="text-left px-1 py-1">#</th>
              <th className="text-left px-1 py-1">N°</th>
              <th className="text-left px-1 py-1">Esc</th>
              <th className="text-left px-1 py-1">Réel dep</th>
              <th className="text-left px-1 py-1">Prog dep</th>
              <th className="text-left px-1 py-1">Esc</th>
              <th className="text-left px-1 py-1">Réel arr</th>
              <th className="text-left px-1 py-1">Prog arr</th>
              <th className="text-right px-1 py-1">Réel vol</th>
              <th className="text-right px-1 py-1">Prog vol</th>
              <th className="text-right px-1 py-1">V.ref</th>
              <th className="text-right px-1 py-1">TSV</th>
              <th className="text-right px-1 py-1">T.A</th>
              <th className="text-right px-1 py-1">V.Nuit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const day = r.reelDep?.day ?? r.progDep?.day ?? null;
              const k = diffKey(r.numLigne, day);
              const isDiff = r.kind === 'normal' && (highlightedKeys?.has(k) ?? false);
              return (
              <tr key={r.index} className={`${r.kind === 'spillover_info' ? 'italic text-zinc-400' : ''} ${isDiff ? DIFF_ROW_CLASS : ''}`}>
                <td className="px-1 py-0.5">{r.index} {kindBadge(r.kind)}</td>
                <td className="px-1 py-0.5">{r.numLigne}</td>
                <td className="px-1 py-0.5">{r.escDep}</td>
                <td className="px-1 py-0.5">{rawH(r.reelDep)}</td>
                <td className="px-1 py-0.5">{rawH(r.progDep)}</td>
                <td className="px-1 py-0.5">{r.escArr}</td>
                <td className="px-1 py-0.5">{rawH(r.reelArr)}</td>
                <td className="px-1 py-0.5">{rawH(r.progArr)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.reelVol)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.progVol)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.vref)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.tsv)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.ta)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.tpsVolNuit)}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ActivitePanel({
  rows, totaux, summary, highlightedKeys,
}: {
  rows:    Ep4PdfData['activite']['rows'];
  totaux:  Ep4PdfData['activite']['totaux'];
  summary: Ep4PdfData['activite']['summary'];
  highlightedKeys?: Set<string>;
}) {
  return (
    <section className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 space-y-4">
      <h3 className="text-sm font-semibold">Feuille Décompte d&apos;Activité — {rows.length} lignes</h3>
      <div className="overflow-x-auto">
        <table className="min-w-full text-[11px] font-mono">
          <thead className="text-zinc-400 uppercase tracking-wide text-[9px]">
            <tr>
              <th className="text-left px-1 py-1">#</th>
              <th className="text-left px-1 py-1">Date</th>
              <th className="text-left px-1 py-1">Vol</th>
              <th className="text-left px-1 py-1">Esc</th>
              <th className="text-right px-1 py-1">HV real</th>
              <th className="text-right px-1 py-1">HV 100%</th>
              <th className="text-right px-1 py-1">HCV</th>
              <th className="text-right px-1 py-1">HV 100%(r)</th>
              <th className="text-right px-1 py-1">HCV(r)</th>
              <th className="text-right px-1 py-1">H2/HC(r)</th>
              <th className="text-right px-1 py-1">Mt HC(r)</th>
              <th className="text-right px-1 py-1">Majo Nuit</th>
              <th className="text-right px-1 py-1">Mt Nuit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const dayStr = r.date?.split('/')[0];
              const day = dayStr ? parseInt(dayStr, 10) : null;
              const k = diffKey(r.numVol, day);
              const isDiff = r.kind === 'normal' && (highlightedKeys?.has(k) ?? false);
              return (
              <tr key={r.index} className={`${r.kind === 'spillover_info' ? 'italic text-zinc-400' : ''} ${isDiff ? DIFF_ROW_CLASS : ''}`}>
                <td className="px-1 py-0.5">{r.index} {kindBadge(r.kind)}</td>
                <td className="px-1 py-0.5">{r.date}</td>
                <td className="px-1 py-0.5">{r.numVol}</td>
                <td className="px-1 py-0.5">{r.depart}→{r.arrivee}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.hvReal)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.hv100)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.hcv)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.hv100r)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.hcvr)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.h2hcR)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.montantHcR)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.majoNuit)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.montantNuit)}</td>
              </tr>
              );
            })}
            <tr className="font-bold border-t border-zinc-300 dark:border-zinc-700">
              <td className="px-1 py-1" colSpan={9}>TOTAL</td>
              <td className="px-1 py-1 text-right">{fmt(totaux.h2hcR)}</td>
              <td className="px-1 py-1 text-right">{fmt(totaux.montantHcR)}</td>
              <td className="px-1 py-1 text-right">{fmt(totaux.majoNuit)}</td>
              <td className="px-1 py-1 text-right">{fmt(totaux.montantNuit)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div>
        <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">
          Récap HS / PVEI / KSP
        </h4>
        <dl className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-x-4 gap-y-2 text-xs">
          <SummaryCell label="HS Fixe (unit / total / majoNuit)"
            value={`${fmt(summary.hsFixe.unit)} / ${fmt(summary.hsFixe.total)} / ${fmt(summary.hsFixe.majoNuit)}`} />
          <SummaryCell label="HS Vol (unit / total / majoNuit)"
            value={`${fmt(summary.hsVol.unit)} / ${fmt(summary.hsVol.total)} / ${fmt(summary.hsVol.majoNuit)}`} />
          <SummaryCell label="HS CAC"           value={fmt(summary.hsCac)} />
          <SummaryCell label="KSP"              value={fmt(summary.ksp)} />
          <SummaryCell label="PVEI 1ère pér"    value={fmt(summary.pvei1)} />
          <SummaryCell label="PVEI 2ème pér"    value={fmt(summary.pvei2)} />
          <SummaryCell label="Tot HC(r)+Nuit"   value={fmt(summary.totHcrPlusNuit)} />
          <SummaryCell label="Calcul HS"        value={fmt(summary.calculHs)} />
          <SummaryCell label="Nb 30ème"         value={fmt(summary.nb30e)} />
          <SummaryCell label="Seuil HS"         value={fmt(summary.seuilHs)} />
        </dl>
      </div>
    </section>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-zinc-400 uppercase tracking-wide text-[9px]">{label}</dt>
      <dd className="font-mono text-zinc-800 dark:text-zinc-200">{value}</dd>
    </div>
  );
}

function FraisPanel({
  rows, totaux, highlightedKeys,
}: {
  rows:   Ep4PdfData['frais']['rows'];
  totaux: Ep4PdfData['frais']['totaux'];
  highlightedKeys?: Set<string>;
}) {
  return (
    <section className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
      <h3 className="text-sm font-semibold mb-3">Frais de Déplacement — {rows.length} lignes</h3>
      <div className="overflow-x-auto">
        <table className="min-w-full text-[11px] font-mono">
          <thead className="text-zinc-400 uppercase tracking-wide text-[9px]">
            <tr>
              <th className="text-left px-1 py-1">#</th>
              <th className="text-left px-1 py-1">Ligne</th>
              <th className="text-left px-1 py-1">Esc dep</th>
              <th className="text-left px-1 py-1">Hor. dep</th>
              <th className="text-right px-1 py-1">Dec</th>
              <th className="text-right px-1 py-1">Pdéj</th>
              <th className="text-right px-1 py-1">IR</th>
              <th className="text-right px-1 py-1">MF</th>
              <th className="text-left px-1 py-1">Esc arr</th>
              <th className="text-left px-1 py-1">Hor. arr</th>
              <th className="text-right px-1 py-1">Dec</th>
              <th className="text-right px-1 py-1">Pdéj</th>
              <th className="text-right px-1 py-1">IR</th>
              <th className="text-right px-1 py-1">MF</th>
              <th className="text-right px-1 py-1">Total</th>
              <th className="text-right px-1 py-1">PN Exo</th>
              <th className="text-right px-1 py-1">PN N.Exo</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const day = r.horaireDep?.day ?? r.horaireArr?.day ?? null;
              const k = diffKey(r.numLigne, day);
              const isDiff = r.kind !== 'spillover_info' && (highlightedKeys?.has(k) ?? false);
              return (
              <tr key={r.index} className={`${r.kind === 'spillover_info' ? 'italic text-zinc-400' : ''} ${isDiff ? DIFF_ROW_CLASS : ''}`}>
                <td className="px-1 py-0.5">{r.index} {kindBadge(r.kind)}</td>
                <td className="px-1 py-0.5">{r.numLigne}</td>
                <td className="px-1 py-0.5">{r.escDep}</td>
                <td className="px-1 py-0.5">{rawH(r.horaireDep)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.decDep)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.pdejDep)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.irDep)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.mfDep)}</td>
                <td className="px-1 py-0.5">{r.escArr}</td>
                <td className="px-1 py-0.5">{rawH(r.horaireArr)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.decArr)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.pdejArr)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.irArr)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.mfArr)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.totalIndem)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.pnExonere)}</td>
                <td className="px-1 py-0.5 text-right">{fmt(r.pnNonExonere)}</td>
              </tr>
              );
            })}
            <tr className="font-bold border-t border-zinc-300 dark:border-zinc-700">
              <td className="px-1 py-1" colSpan={6}>TOTAUX</td>
              <td className="px-1 py-1 text-right">{fmt(totaux.irDep)}</td>
              <td className="px-1 py-1 text-right">{fmt(totaux.mfDep)}</td>
              <td className="px-1 py-1" />
              <td className="px-1 py-1" />
              <td className="px-1 py-1 text-right">{fmt(totaux.decArr)}</td>
              <td className="px-1 py-1" />
              <td className="px-1 py-1 text-right">{fmt(totaux.irArr)}</td>
              <td className="px-1 py-1 text-right">{fmt(totaux.mfArr)}</td>
              <td className="px-1 py-1 text-right">{fmt(totaux.totalIndem)}</td>
              <td className="px-1 py-1 text-right">{fmt(totaux.pnExonere)}</td>
              <td className="px-1 py-1 text-right">{fmt(totaux.pnNonExonere)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
