// Renderer pur des 2 tableaux EP4 (feuille horaire + feuille décompte).
// Consommé par /comparatif (1 rotation au clic) et /ep4 (toutes rotations
// du planning). Pas de fetch ici — l'objet Ep4Rotation est passé en prop.

import type { ReactNode, Ref } from 'react';
import type { Ep4Rotation } from '@/lib/ep4';
import { getPlanPrestation } from '@/lib/plan-prestation';
import { diffKey } from '@/lib/ep4-diff';

/** Classe Tailwind appliquée à une row qui diverge entre calc et PDF importé.
 *  Couleur volontairement TRÈS légère (cf. demande user 2026-06-17 PM). */
const DIFF_ROW_CLASS = 'bg-amber-50/60 dark:bg-amber-950/30';

function fmt(n: number | null | undefined, dec = 2): string {
  if (n == null || isNaN(n)) return '';
  return n.toFixed(dec).replace('.', ',');
}

function fmtInt(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '';
  return String(Math.round(n));
}

function dateFr(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC',
  });
}

export function Ep4Tables({ ep4, year, month }: {
  ep4: Ep4Rotation;
  year: number;
  month: number;
}) {
  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd   = month === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, month, 1);
  const flatLegs = ep4.services.flatMap(svc => svc.legs.map(leg => ({ leg, svc })));
  const hasSpillover = flatLegs.some(({ leg }) => leg.end_ms < monthStart || leg.begin_ms >= monthEnd);

  return (
    <div className="space-y-4">

      <Card title="Feuille horaire d'activité PN EP4">
        <div className="overflow-x-auto">
          <table className="text-[11px] font-mono w-max border-collapse">
            <thead>
              <tr className="bg-zinc-50 dark:bg-zinc-800 text-zinc-500 border-b border-zinc-200 dark:border-zinc-700">
                {['N° Vol','Avion','DEP','ARR','DEP/UTC','ARR/UTC','DebutVol','FinVol','HDV','HC','TSV','ON','TDV Total','Service','Tronçon','TDV/troncon','BLOCK/BLOCK','TA','TSV nuit J','TSV nuit J+1','TSV nuit','TSVnSerM','TSVnRotM']
                  .map(h => <Th key={h}>{h}</Th>)}
              </tr>
            </thead>
            <tbody>
              {flatLegs.map(({ leg, svc }, idx) => {
                const isSpillover     = leg.end_ms < monthStart || leg.begin_ms >= monthEnd;
                const isFirstLegOfRot = idx === 0;
                const isFirstLegOfSvc = leg.troncon_index === 1;
                return (
                  <tr key={`${leg.flightNumber}-${leg.begin_ms}`}
                      className={`border-b border-zinc-100 dark:border-zinc-800 ${isSpillover ? 'italic text-zinc-400' : ''}`}>
                    <Td>{leg.flightNumber}</Td>
                    <Td>{leg.aircraft}</Td>
                    <Td>{leg.dep}</Td>
                    <Td>{leg.arr}</Td>
                    <Td>{fmt(leg.dep_utc_h)}</Td>
                    <Td>{fmt(leg.arr_utc_h)}</Td>
                    <Td>{isFirstLegOfRot ? dateFr(ep4.debut_vol_ms) : ''}</Td>
                    <Td>{isFirstLegOfRot ? dateFr(ep4.fin_vol_ms)   : ''}</Td>
                    <Td>{isFirstLegOfRot ? fmt(ep4.HDV)             : ''}</Td>
                    <Td>{isFirstLegOfRot ? fmt(ep4.HC)              : ''}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.tsv)             : ''}</Td>
                    <Td>{isFirstLegOfRot ? fmtInt(ep4.ON)           : ''}</Td>
                    <Td>{isFirstLegOfRot ? fmt(ep4.TDV_total)       : ''}</Td>
                    <Td>{isFirstLegOfSvc ? svc.service_index        : ''}</Td>
                    <Td>{leg.troncon_index}</Td>
                    <Td>{fmt(leg.tdv_troncon)}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.block_block)     : ''}</Td>
                    <Td>{isFirstLegOfRot ? fmt(ep4.TA)              : ''}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.tsv_nuit_j)      : ''}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.tsv_nuit_j1)     : ''}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.tsv_nuit)        : ''}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.tsv_n_ser_m)     : ''}</Td>
                    <Td>{isFirstLegOfRot ? fmt(ep4.tsv_n_rot_m)     : ''}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Feuille de décompte d'activité PN EP4">
        <div className="overflow-x-auto">
          <table className="text-[11px] font-mono w-max border-collapse">
            <thead>
              <tr className="bg-zinc-50 dark:bg-zinc-800 text-zinc-500 border-b border-zinc-200 dark:border-zinc-700">
                {['Service','Tronçon','TME','CMT','HCV','HCVmoisM','HCT','HCA','H1','H2HC','rtHDV','HV100r','HCVr','H1r','H2HCr','Prime','deadHead','IR','IR €','MF','MF €','tempsSej','Zone','tauxApp']
                  .map(h => <Th key={h}>{h}</Th>)}
              </tr>
            </thead>
            <tbody>
              {flatLegs.map(({ leg, svc }, idx) => {
                const isSpillover     = leg.end_ms < monthStart || leg.begin_ms >= monthEnd;
                const isFirstLegOfRot = idx === 0;
                const isFirstLegOfSvc = leg.troncon_index === 1;
                return (
                  <tr key={`d-${leg.flightNumber}-${leg.begin_ms}`}
                      className={`border-b border-zinc-100 dark:border-zinc-800 ${isSpillover ? 'italic text-zinc-400' : ''}`}>
                    <Td>{isFirstLegOfSvc ? svc.service_index : ''}</Td>
                    <Td>{leg.troncon_index}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.TME)               : ''}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.CMT)               : ''}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.HCV)               : ''}</Td>
                    <Td>{fmt(leg.hcv_mois_m)}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.HCT)               : ''}</Td>
                    <Td>{isFirstLegOfRot ? fmt(ep4.HCA)               : ''}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.H1)                : ''}</Td>
                    <Td>{isFirstLegOfRot ? fmt(ep4.H2HC)              : ''}</Td>
                    <Td>{isFirstLegOfRot ? fmt(ep4.rtHDV)             : ''}</Td>
                    <Td>{fmt(leg.hv100r)}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.HCVr)              : ''}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.H1r)               : ''}</Td>
                    <Td>{isFirstLegOfRot ? fmt(ep4.H2HCr)             : ''}</Td>
                    <Td>{isFirstLegOfRot ? String(ep4.Prime)          : ''}</Td>
                    <Td>{leg.dead_head ? '1' : ''}</Td>
                    <Td>{isFirstLegOfRot ? String(ep4.IR)             : ''}</Td>
                    <Td>{isFirstLegOfRot ? fmt(ep4.IR_eur)            : ''}</Td>
                    <Td>{isFirstLegOfRot ? String(ep4.MF)             : ''}</Td>
                    <Td>{isFirstLegOfRot ? fmt(ep4.MF_eur)            : ''}</Td>
                    <Td>{isFirstLegOfRot ? fmt(ep4.tempsSej)          : ''}</Td>
                    <Td>{isFirstLegOfRot ? (ep4.zone ?? '')           : ''}</Td>
                    <Td>{isFirstLegOfRot && ep4.tauxApp != null ? fmt(ep4.tauxApp) : ''}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {hasSpillover && (
        <p className="text-[10px] text-zinc-400 px-1">
          <span className="italic">Lignes en italique</span> : legs hors du mois courant (vol à cheval).
        </p>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="px-4 py-2 bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-100 dark:border-zinc-800">
        <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide">{title}</p>
      </div>
      {children}
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th className="px-2 py-1.5 text-left whitespace-nowrap font-medium uppercase tracking-wide text-[10px]">{children}</th>;
}
function Td({ children, right }: { children?: ReactNode; right?: boolean }) {
  return <td className={`px-2 py-1 whitespace-nowrap text-zinc-700 dark:text-zinc-300 ${right ? 'text-right' : ''}`}>{children}</td>;
}

// ─── Types pour les vues consolidées ─────────────────────────────────────────

type ConsoFlight = { ep4: Ep4Rotation; is_spillover: boolean };

/** day | HH.MM UTC (heures et minutes, pas décimal) */
function fmtEp4Time(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} | ${String(d.getUTCHours()).padStart(2, '0')}.${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** DD | HH.cc UTC où cc = centièmes industriels (MM/60 × 100). Format des
 *  horaires sur l'EP4 PDF d'AF (ex: 21h06 le 1er → "01 | 21.10"). Le jour
 *  est paddé sur 2 chiffres comme dans le PDF (cf. demande user). */
function fmtEp4TimeCentiemes(ms: number): string {
  const d = new Date(ms);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hour = String(d.getUTCHours()).padStart(2, '0');
  const cents = String(Math.round((d.getUTCMinutes() / 60) * 100)).padStart(2, '0');
  return `${day} | ${hour}.${cents}`;
}

/** day | HH.MM en local (UTC + offset en heures de l'escale) */
function fmtEp4TimeLocal(ms: number, offsetH: number): string {
  return fmtEp4Time(ms + offsetH * 3_600_000);
}

/** DD | HH.cc en local (heures locales en centièmes industriels). Utilisé
 *  par la Feuille Frais qui affiche les horaires locaux du document AF. */
function fmtEp4TimeCentiemesLocal(ms: number, offsetH: number): string {
  return fmtEp4TimeCentiemes(ms + offsetH * 3_600_000);
}

/** DD/MM/YY UTC */
function fmtDateCourt(ms: number): string {
  const d = new Date(ms);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

// ─── Feuille Horaire consolidée ───────────────────────────────────────────────

export function Ep4HoraireConsolidee({ flights, year, month }: {
  flights: ConsoFlight[];
  year: number;
  month: number;
}) {
  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd   = month === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, month, 1);
  const COLS = ['N° Vol','Avion','DEP','ARR','DEP/UTC','ARR/UTC','DebutVol','FinVol','HDV','HC','TSV','ON','TDV Total','Service','Tronçon','TDV/troncon','BLOCK/BLOCK','TA','TSV nuit J','TSV nuit J+1','TSV nuit','TSVnSerM','TSVnRotM'];
  return (
    <Card title="Feuille horaire d'activité PN EP4">
      <div className="overflow-x-auto">
        <table className="text-[11px] font-mono w-max border-collapse">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-800 text-zinc-500 border-b border-zinc-200 dark:border-zinc-700">
              {COLS.map(h => <Th key={h}>{h}</Th>)}
            </tr>
          </thead>
          <tbody>
            {flights.map(({ ep4, is_spillover }) => {
              const flatLegs = ep4.services.flatMap(svc => svc.legs.map(leg => ({ leg, svc })));
              return flatLegs.map(({ leg, svc }, idx) => {
                const isSpillover = is_spillover || leg.end_ms < monthStart || leg.begin_ms >= monthEnd;
                const isFirstLegOfRot = idx === 0;
                const isFirstLegOfSvc = leg.troncon_index === 1;
                if (isFirstLegOfRot) {
                  return [
                    <tr key={`sep-${ep4.rotation_code}-${ep4.debut_vol_ms}`}
                        className="bg-zinc-100 dark:bg-zinc-800/60 border-t-2 border-zinc-300 dark:border-zinc-600">
                      <td colSpan={COLS.length} className="px-2 py-0.5 text-[10px] font-semibold text-zinc-500 dark:text-zinc-300">
                        {ep4.rotation_code || '—'}
                        {is_spillover && <span className="ml-2 text-amber-500">↩ à cheval</span>}
                      </td>
                    </tr>,
                    <tr key={`${leg.flightNumber}-${leg.begin_ms}`}
                        className={`border-b border-zinc-100 dark:border-zinc-800 ${isSpillover ? 'italic text-zinc-400' : ''}`}>
                      <Td>{leg.flightNumber}</Td><Td>{leg.aircraft}</Td><Td>{leg.dep}</Td><Td>{leg.arr}</Td>
                      <Td>{fmt(leg.dep_utc_h)}</Td><Td>{fmt(leg.arr_utc_h)}</Td>
                      <Td>{dateFr(ep4.debut_vol_ms)}</Td><Td>{dateFr(ep4.fin_vol_ms)}</Td>
                      <Td>{fmt(ep4.HDV)}</Td><Td>{fmt(ep4.HC)}</Td>
                      <Td>{isFirstLegOfSvc ? fmt(svc.tsv) : ''}</Td>
                      <Td>{fmtInt(ep4.ON)}</Td><Td>{fmt(ep4.TDV_total)}</Td>
                      <Td>{isFirstLegOfSvc ? svc.service_index : ''}</Td><Td>{leg.troncon_index}</Td>
                      <Td>{fmt(leg.tdv_troncon)}</Td>
                      <Td>{isFirstLegOfSvc ? fmt(svc.block_block) : ''}</Td>
                      <Td>{fmt(ep4.TA)}</Td>
                      <Td>{isFirstLegOfSvc ? fmt(svc.tsv_nuit_j) : ''}</Td>
                      <Td>{isFirstLegOfSvc ? fmt(svc.tsv_nuit_j1) : ''}</Td>
                      <Td>{isFirstLegOfSvc ? fmt(svc.tsv_nuit) : ''}</Td>
                      <Td>{isFirstLegOfSvc ? fmt(svc.tsv_n_ser_m) : ''}</Td>
                      <Td>{fmt(ep4.tsv_n_rot_m)}</Td>
                    </tr>,
                  ];
                }
                return (
                  <tr key={`${leg.flightNumber}-${leg.begin_ms}`}
                      className={`border-b border-zinc-100 dark:border-zinc-800 ${isSpillover ? 'italic text-zinc-400' : ''}`}>
                    <Td>{leg.flightNumber}</Td><Td>{leg.aircraft}</Td><Td>{leg.dep}</Td><Td>{leg.arr}</Td>
                    <Td>{fmt(leg.dep_utc_h)}</Td><Td>{fmt(leg.arr_utc_h)}</Td>
                    <Td /><Td /><Td /><Td />
                    <Td>{isFirstLegOfSvc ? fmt(svc.tsv) : ''}</Td>
                    <Td /><Td />
                    <Td>{isFirstLegOfSvc ? svc.service_index : ''}</Td><Td>{leg.troncon_index}</Td>
                    <Td>{fmt(leg.tdv_troncon)}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.block_block) : ''}</Td>
                    <Td />
                    <Td>{isFirstLegOfSvc ? fmt(svc.tsv_nuit_j) : ''}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.tsv_nuit_j1) : ''}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.tsv_nuit) : ''}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.tsv_n_ser_m) : ''}</Td>
                    <Td />
                  </tr>
                );
              });
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─── Feuille Décompte consolidée ─────────────────────────────────────────────

export function Ep4DecompteConsolidee({ flights, year, month }: {
  flights: ConsoFlight[];
  year: number;
  month: number;
}) {
  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd   = month === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, month, 1);
  const COLS = ['Service','Tronçon','TME','CMT','HCV','HCVmoisM','HCT','HCA','H1','H2HC','rtHDV','HV100r','HCVr','H1r','H2HCr','Prime','deadHead','IR','IR €','MF','MF €','tempsSej','Zone','tauxApp'];
  return (
    <Card title="Feuille de décompte d'activité PN EP4">
      <div className="overflow-x-auto">
        <table className="text-[11px] font-mono w-max border-collapse">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-800 text-zinc-500 border-b border-zinc-200 dark:border-zinc-700">
              {COLS.map(h => <Th key={h}>{h}</Th>)}
            </tr>
          </thead>
          <tbody>
            {flights.map(({ ep4, is_spillover }) => {
              const flatLegs = ep4.services.flatMap(svc => svc.legs.map(leg => ({ leg, svc })));
              return flatLegs.map(({ leg, svc }, idx) => {
                const isSpillover = is_spillover || leg.end_ms < monthStart || leg.begin_ms >= monthEnd;
                const isFirstLegOfRot = idx === 0;
                const isFirstLegOfSvc = leg.troncon_index === 1;
                if (isFirstLegOfRot) {
                  return [
                    <tr key={`sep-${ep4.rotation_code}-${ep4.debut_vol_ms}`}
                        className="bg-zinc-100 dark:bg-zinc-800/60 border-t-2 border-zinc-300 dark:border-zinc-600">
                      <td colSpan={COLS.length} className="px-2 py-0.5 text-[10px] font-semibold text-zinc-500 dark:text-zinc-300">
                        {ep4.rotation_code || '—'}
                        {is_spillover && <span className="ml-2 text-amber-500">↩ à cheval</span>}
                      </td>
                    </tr>,
                    <tr key={`d-${leg.flightNumber}-${leg.begin_ms}`}
                        className={`border-b border-zinc-100 dark:border-zinc-800 ${isSpillover ? 'italic text-zinc-400' : ''}`}>
                      <Td>{isFirstLegOfSvc ? svc.service_index : ''}</Td><Td>{leg.troncon_index}</Td>
                      <Td>{isFirstLegOfSvc ? fmt(svc.TME) : ''}</Td>
                      <Td>{isFirstLegOfSvc ? fmt(svc.CMT) : ''}</Td>
                      <Td>{isFirstLegOfSvc ? fmt(svc.HCV) : ''}</Td>
                      <Td>{fmt(leg.hcv_mois_m)}</Td>
                      <Td>{isFirstLegOfSvc ? fmt(svc.HCT) : ''}</Td>
                      <Td>{fmt(ep4.HCA)}</Td>
                      <Td>{isFirstLegOfSvc ? fmt(svc.H1) : ''}</Td>
                      <Td>{fmt(ep4.H2HC)}</Td><Td>{fmt(ep4.rtHDV)}</Td>
                      <Td>{fmt(leg.hv100r)}</Td>
                      <Td>{isFirstLegOfSvc ? fmt(svc.HCVr) : ''}</Td>
                      <Td>{isFirstLegOfSvc ? fmt(svc.H1r) : ''}</Td>
                      <Td>{fmt(ep4.H2HCr)}</Td>
                      <Td>{String(ep4.Prime)}</Td>
                      <Td>{leg.dead_head ? '1' : ''}</Td>
                      <Td>{String(ep4.IR)}</Td><Td>{fmt(ep4.IR_eur)}</Td>
                      <Td>{String(ep4.MF)}</Td><Td>{fmt(ep4.MF_eur)}</Td>
                      <Td>{fmt(ep4.tempsSej)}</Td>
                      <Td>{ep4.zone ?? ''}</Td>
                      <Td>{ep4.tauxApp != null ? fmt(ep4.tauxApp) : ''}</Td>
                    </tr>,
                  ];
                }
                return (
                  <tr key={`d-${leg.flightNumber}-${leg.begin_ms}`}
                      className={`border-b border-zinc-100 dark:border-zinc-800 ${isSpillover ? 'italic text-zinc-400' : ''}`}>
                    <Td>{isFirstLegOfSvc ? svc.service_index : ''}</Td><Td>{leg.troncon_index}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.TME) : ''}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.CMT) : ''}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.HCV) : ''}</Td>
                    <Td>{fmt(leg.hcv_mois_m)}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.HCT) : ''}</Td>
                    <Td /><Td>{isFirstLegOfSvc ? fmt(svc.H1) : ''}</Td>
                    <Td /><Td />
                    <Td>{fmt(leg.hv100r)}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.HCVr) : ''}</Td>
                    <Td>{isFirstLegOfSvc ? fmt(svc.H1r) : ''}</Td>
                    <Td /><Td /><Td>{leg.dead_head ? '1' : ''}</Td>
                    <Td /><Td /><Td /><Td /><Td /><Td /><Td />
                  </tr>
                );
              });
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─── Frais de Déplacement EP4 (format document officiel) ─────────────────────

/** Largeurs colonnes Frais (en px). DOIVENT être identiques cote panel PDF
 *  importé (Ep4ImportFraisPanel) — sinon désalignement visuel entre les 2
 *  tableaux empilés. 20 colonnes, total ~1370px → la table déborde, scroll
 *  horizontal sync via Ep4PageClient (decompteFraisCalcScrollRef etc.). */
export const FRAIS_COL_WIDTHS_PX = [
  36,  // #
  60,  // Ligne
  60,  // Esc dep
  100, // Hor. dep
  60,  // Dec
  60,  // Pdéj
  60,  // IR
  60,  // MF
  60,  // Esc arr
  100, // Hor. arr
  60,  // Dec
  60,  // Pdéj
  60,  // IR
  60,  // MF
  90,  // Total
  60,  // Type
  60,  // km
  80,  // Mt Dec
  100, // PN Exo
  100, // PN N.Exo
];

export function Ep4FraisEP4Consolidee({ flights, highlightedKeys, scrollRef }: {
  flights: ConsoFlight[];
  highlightedKeys?: Set<string>;
  scrollRef?: Ref<HTMLDivElement>;
}) {
  // 1 row par service (comme l'EP4 PDF officiel). Aplatissement pour la
  // numérotation # globale et le rendu sequentiel.
  const flatRows = flights.flatMap(({ ep4, is_spillover }, ri) =>
    ep4.services.map((svc, si) => ({
      ep4, svc, si, is_spillover,
      isFirstSvc:  si === 0,
      isFirstOfRotation: si === 0,
      rotKey: `${ep4.rotation_code ?? 'rot'}-${ep4.debut_vol_ms}-${ri}`,
    })),
  );

  // Totaux annulés (calculés sur les rows non-spillover). PN 70/30 idem.
  const totals = flights.reduce(
    (acc, { ep4, is_spillover }) => {
      if (is_spillover) return acc;
      const decs = ep4.services.reduce((d, s) => {
        const m = getPlanPrestation(s.legs[0]?.flightNumber ?? '', s.legs[0]?.dep ?? '');
        return d + (m ? (m.dej ? 1 : 0) + (m.din ? 1 : 0) : 0);
      }, 0);
      const tIndem = ep4.IR_eur + ep4.MF_eur;
      return {
        IR:         acc.IR + ep4.IR,
        MF:         acc.MF + ep4.MF,
        totalIndem: acc.totalIndem + tIndem,
        pnExo:      acc.pnExo + tIndem * 0.7,
        pnNonExo:   acc.pnNonExo + tIndem * 0.3,
        dec:        acc.dec + decs,
      };
    },
    { IR: 0, MF: 0, totalIndem: 0, pnExo: 0, pnNonExo: 0, dec: 0 },
  );

  const fmtVol = (n: string) => String(parseInt(n, 10) || 0).padStart(4, '0');
  const dash = '—';

  return (
    <section className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
      <h3 className="text-sm font-semibold mb-3">Frais de Déplacement — {flatRows.length} lignes</h3>
      <div ref={scrollRef} className="overflow-x-auto">
        {/* table-fixed + colgroup px → largeurs identiques au panel PDF importé
            (Ep4ImportFraisPanel) → alignement vertical parfait des 2 tableaux
            empilés, et scroll horizontal sync par Ep4PageClient. */}
        <table className="table-fixed text-[11px] font-mono whitespace-nowrap [&_th]:px-3 [&_td]:px-3">
          <colgroup>
            {FRAIS_COL_WIDTHS_PX.map((w, i) => <col key={i} style={{ width: `${w}px` }} />)}
          </colgroup>
          <thead className="text-zinc-400 uppercase tracking-wide text-[9px]">
            <tr>
              <th className="text-left  py-1">#</th>
              <th className="text-left  py-1">Ligne</th>
              <th className="text-left  py-1">Esc dep</th>
              <th className="text-left  py-1">Hor. dep</th>
              <th className="text-right py-1">Dec</th>
              <th className="text-right py-1">Pdéj</th>
              <th className="text-right py-1">IR</th>
              <th className="text-right py-1">MF</th>
              <th className="text-left  py-1">Esc arr</th>
              <th className="text-left  py-1">Hor. arr</th>
              <th className="text-right py-1">Dec</th>
              <th className="text-right py-1">Pdéj</th>
              <th className="text-right py-1">IR</th>
              <th className="text-right py-1">MF</th>
              <th className="text-right py-1">Total</th>
              <th className="text-left  py-1">Type</th>
              <th className="text-right py-1">km</th>
              <th className="text-right py-1">Mt Dec</th>
              <th className="text-right py-1">PN Exo</th>
              <th className="text-right py-1">PN N.Exo</th>
            </tr>
          </thead>
          <tbody>
            {flatRows.map((r, idx) => {
              const { ep4, svc, is_spillover, isFirstSvc, isFirstOfRotation } = r;
              const firstLeg = svc.legs[0];
              const lastLeg  = svc.legs[svc.legs.length - 1];

              const irDep      = is_spillover && isFirstSvc ? ep4.IR : 0;
              const mfDep      = is_spillover && isFirstSvc ? ep4.MF : 0;
              const irArr      = !is_spillover && isFirstSvc ? ep4.IR : 0;
              const mfArr      = !is_spillover && isFirstSvc ? ep4.MF : 0;
              const totalIndem = isFirstSvc ? ep4.IR_eur + ep4.MF_eur : null;
              const pnExo      = totalIndem != null ? totalIndem * 0.7 : null;
              const pnNonExo   = totalIndem != null ? totalIndem * 0.3 : null;

              const meal = getPlanPrestation(firstLeg?.flightNumber ?? '', firstLeg?.dep ?? '');
              const dec  = meal ? (meal.dej ? 1 : 0) + (meal.din ? 1 : 0) : 0;

              const k = firstLeg ? diffKey(firstLeg.flightNumber, new Date(firstLeg.begin_ms).getUTCDate()) : '';
              const isDiff = isFirstSvc && (highlightedKeys?.has(k) ?? false);

              const rowClass = [
                is_spillover ? 'italic text-zinc-400' : '',
                isDiff ? DIFF_ROW_CLASS : '',
                isFirstOfRotation && idx > 0 ? 'border-t border-zinc-200 dark:border-zinc-700' : '',
              ].filter(Boolean).join(' ');

              return (
                <tr key={`f-${r.rotKey}-${svc.service_index}-${idx}`} className={rowClass}>
                  <td className="py-0.5">{idx}</td>
                  <td className="py-0.5">{firstLeg ? fmtVol(firstLeg.flightNumber) : ''}</td>
                  <td className="py-0.5">{firstLeg?.dep ?? ''}</td>
                  <td className="py-0.5">{firstLeg ? fmtEp4TimeCentiemesLocal(firstLeg.begin_ms, firstLeg.dep_utc_offset) : ''}</td>
                  <td className="py-0.5 text-right">{dec > 0 ? dec : ''}</td>
                  <td className="py-0.5 text-right">{dash}</td>
                  <td className="py-0.5 text-right">{irDep > 0 ? irDep : ''}</td>
                  <td className="py-0.5 text-right">{mfDep > 0 ? mfDep : ''}</td>
                  <td className="py-0.5">{lastLeg?.arr ?? ''}</td>
                  <td className="py-0.5">{lastLeg ? fmtEp4TimeCentiemesLocal(lastLeg.end_ms, lastLeg.arr_utc_offset) : ''}</td>
                  <td className="py-0.5 text-right">{dash}</td>
                  <td className="py-0.5 text-right">{dash}</td>
                  <td className="py-0.5 text-right">{irArr > 0 ? irArr : ''}</td>
                  <td className="py-0.5 text-right">{mfArr > 0 ? mfArr : ''}</td>
                  <td className="py-0.5 text-right">{totalIndem != null ? fmt(totalIndem) : ''}</td>
                  <td className="py-0.5">{dash}</td>
                  <td className="py-0.5 text-right">{dash}</td>
                  <td className="py-0.5 text-right">{dash}</td>
                  <td className="py-0.5 text-right">{pnExo != null ? fmt(pnExo) : ''}</td>
                  <td className="py-0.5 text-right">{pnNonExo != null ? fmt(pnNonExo) : ''}</td>
                </tr>
              );
            })}
            {flights.length > 1 && (
              <tr className="font-bold border-t border-zinc-300 dark:border-zinc-700">
                <td className="py-1" colSpan={4}>TOTAUX</td>
                <td className="py-1 text-right">{totals.dec > 0 ? totals.dec : ''}</td>
                <td className="py-1 text-right" />
                <td className="py-1 text-right">{totals.IR > 0 ? totals.IR : ''}</td>
                <td className="py-1 text-right">{totals.MF > 0 ? totals.MF : ''}</td>
                <td className="py-1" colSpan={2} />
                <td className="py-1 text-right" />
                <td className="py-1 text-right" />
                <td className="py-1 text-right">{totals.IR > 0 ? totals.IR : ''}</td>
                <td className="py-1 text-right">{totals.MF > 0 ? totals.MF : ''}</td>
                <td className="py-1 text-right">{fmt(totals.totalIndem)}</td>
                <td className="py-1" />
                <td className="py-1 text-right" />
                <td className="py-1 text-right" />
                <td className="py-1 text-right">{fmt(totals.pnExo)}</td>
                <td className="py-1 text-right">{fmt(totals.pnNonExo)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {flights.some(f => f.ep4.IR_missingRateEscales.length > 0) && (
        <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-2">
          Taux IR manquants : {[...new Set(flights.flatMap(f => f.ep4.IR_missingRateEscales))].join(', ')}
        </p>
      )}
    </section>
  );
}

// ─── Frais de Déplacement consolidés ─────────────────────────────────────────

export function Ep4FraisDeplacementConsolidee({ flights }: { flights: ConsoFlight[] }) {
  // Précompute les hcvMoisM (1 par flight) — utilisés par le rendu ET les totaux.
  const rows = flights.map(({ ep4, is_spillover }) => ({
    ep4, is_spillover,
    hcvMoisM: ep4.services.flatMap(s => s.legs).reduce((s, l) => s + l.hcv_mois_m, 0),
  }));

  // Totaux en reduce : accumulateur object, pas de mutation de let externes.
  const totals = rows.reduce(
    (a, { ep4, hcvMoisM }) => ({
      HDV: a.HDV + ep4.HDV, HC: a.HC + ep4.HC, HCVm: a.HCVm + hcvMoisM,
      H2HCr: a.H2HCr + ep4.H2HCr, Prime: a.Prime + ep4.Prime,
      IR: a.IR + ep4.IR, IREur: a.IREur + ep4.IR_eur,
      MF: a.MF + ep4.MF, MFEur: a.MFEur + ep4.MF_eur,
    }),
    { HDV: 0, HC: 0, HCVm: 0, H2HCr: 0, Prime: 0, IR: 0, IREur: 0, MF: 0, MFEur: 0 },
  );
  const totHDV = totals.HDV, totHC = totals.HC, totHCVm = totals.HCVm;
  const totH2HCr = totals.H2HCr, totPrime = totals.Prime, totIR = totals.IR;
  const totIREur = totals.IREur, totMF = totals.MF, totMFEur = totals.MFEur;

  return (
    <Card title="Frais de déplacement EP4">
      <div className="overflow-x-auto">
        <table className="text-[11px] font-mono w-max border-collapse">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-800 text-zinc-500 border-b border-zinc-200 dark:border-zinc-700">
              {['Rotation','Début','Fin','ON','ONm','HDV','HC','HCVmoisM','H2HCr','Prime','IR','IR €','MF','MF €','TSéjour','Zone','TauxApp'].map(h => <Th key={h}>{h}</Th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ ep4, is_spillover, hcvMoisM }) => (
              <tr key={`fd-${ep4.rotation_code}-${ep4.debut_vol_ms}`}
                  className={`border-b border-zinc-100 dark:border-zinc-800 ${is_spillover ? 'italic text-zinc-400' : ''}`}>
                <Td>
                  <span className="font-semibold">{ep4.rotation_code || '—'}</span>
                  {is_spillover && <span className="ml-1 text-[9px] text-amber-500">↩</span>}
                </Td>
                <Td>{dateFr(ep4.debut_vol_ms)}</Td>
                <Td>{dateFr(ep4.fin_vol_ms)}</Td>
                <Td right>{fmtInt(ep4.ON)}</Td>
                <Td right>{fmt(ep4.ONm)}</Td>
                <Td right>{fmt(ep4.HDV)}</Td>
                <Td right>{fmt(ep4.HC)}</Td>
                <Td right>{fmt(hcvMoisM)}</Td>
                <Td right>{fmt(ep4.H2HCr)}</Td>
                <Td right>{ep4.Prime > 0 ? String(ep4.Prime) : '—'}</Td>
                <Td right>{ep4.IR > 0 ? String(ep4.IR) : '—'}</Td>
                <Td right>{ep4.IR_eur > 0 ? fmt(ep4.IR_eur) : '—'}</Td>
                <Td right>{ep4.MF > 0 ? String(ep4.MF) : '—'}</Td>
                <Td right>{ep4.MF_eur > 0 ? fmt(ep4.MF_eur) : '—'}</Td>
                <Td right>{fmt(ep4.tempsSej)}</Td>
                <Td>{ep4.zone ?? '—'}</Td>
                <Td right>{ep4.tauxApp != null ? fmt(ep4.tauxApp) : '—'}</Td>
              </tr>
            ))}
          </tbody>
          {rows.length > 1 && (
            <tfoot>
              <tr className="border-t-2 border-zinc-400 dark:border-zinc-500 bg-zinc-50 dark:bg-zinc-800/40 font-semibold">
                <td colSpan={5} className="px-2 py-1 text-[10px] text-zinc-500 uppercase">Total</td>
                <Td right>{fmt(totHDV)}</Td>
                <Td right>{fmt(totHC)}</Td>
                <Td right>{fmt(totHCVm)}</Td>
                <Td right>{fmt(totH2HCr)}</Td>
                <Td right>{totPrime > 0 ? String(totPrime) : '—'}</Td>
                <Td right>{totIR > 0 ? String(totIR) : '—'}</Td>
                <Td right>{totIREur > 0 ? fmt(totIREur) : '—'}</Td>
                <Td right>{totMF > 0 ? String(totMF) : '—'}</Td>
                <Td right>{totMFEur > 0 ? fmt(totMFEur) : '—'}</Td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {rows.some(r => r.ep4.IR_missingRateEscales.length > 0) && (
        <p className="px-4 py-2 text-[10px] text-amber-600 dark:text-amber-400">
          Taux IR manquants : {[...new Set(rows.flatMap(r => r.ep4.IR_missingRateEscales))].join(', ')}
        </p>
      )}
    </Card>
  );
}

// ─── Feuille Horaire EP4 (format document officiel) ───────────────────────────

export function Ep4HoraireEP4Consolidee({ flights, year, month, highlightedKeys }: {
  flights: ConsoFlight[];
  year: number;
  month: number;
  /** Clés de leg (diffKey) dont une valeur diverge avec l'EP4 PDF importé. */
  highlightedKeys?: Set<string>;
}) {
  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd   = month === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, month, 1);

  // Aplatit tous les legs en compteur global # (= ordre d'apparition), pour
  // matcher visuellement le panel PDF. On garde un flag isFirstOfRotation
  // pour pouvoir tracer une légère séparation top entre rotations sans
  // ajouter de ligne label dédiée.
  const flatRows = flights.flatMap(({ ep4, is_spillover }, ri) =>
    ep4.services.flatMap((svc, si) =>
      svc.legs.map((leg, li) => ({
        leg, svc, ep4, is_spillover,
        isFirstOfRotation:        si === 0 && li === 0,
        isLastLegOfSvc:           li === svc.legs.length - 1,
        isLastSvcOfRot:           si === ep4.services.length - 1,
        rotKey:                   `${ep4.rotation_code ?? 'rot'}-${ep4.debut_vol_ms}-${ri}`,
      })),
    ),
  );

  const totalRows = flatRows.length;

  return (
    <section className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
      <h3 className="text-sm font-semibold mb-3">Feuille Horaire — {totalRows} lignes</h3>
      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-[11px] font-mono">
          {/* colgroup : largeurs en % alignees IDENTIQUES dans Ep4ImportHorairePanel.
              Permet aux 2 tableaux empiles d'avoir leurs colonnes parfaitement
              alignees verticalement, malgre des contenus differents. Total = 100%.
              6 valeurs numeriques a droite uniformes a 8% chacune (avant: V.Nuit
              monopolisait 18% → grosse marge vide apres T.A). */}
          <colgroup>
            <col style={{ width:  '3%' }} /><col style={{ width:  '5%' }} /><col style={{ width: '4%' }} />
            <col style={{ width:  '9%' }} /><col style={{ width:  '9%' }} /><col style={{ width: '4%' }} />
            <col style={{ width:  '9%' }} /><col style={{ width:  '9%' }} />
            <col style={{ width:  '8%' }} /><col style={{ width:  '8%' }} /><col style={{ width: '8%' }} />
            <col style={{ width:  '8%' }} /><col style={{ width:  '8%' }} /><col style={{ width: '8%' }} />
          </colgroup>
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
            {flatRows.map((r, idx) => {
              const { leg, svc, ep4, is_spillover, isFirstOfRotation, isLastLegOfSvc, isLastSvcOfRot } = r;
              const isSpillover = is_spillover || leg.end_ms < monthStart || leg.begin_ms >= monthEnd;
              const k = diffKey(leg.flightNumber, new Date(leg.begin_ms).getUTCDate());
              const isDiff = !isSpillover && (highlightedKeys?.has(k) ?? false);
              const rowClass = [
                isSpillover ? 'italic text-zinc-400' : '',
                isDiff ? DIFF_ROW_CLASS : '',
                isFirstOfRotation && idx > 0 ? 'border-t border-zinc-200 dark:border-zinc-700' : '',
              ].filter(Boolean).join(' ');
              return (
                <tr key={`h-${leg.flightNumber}-${leg.begin_ms}-${idx}`} className={rowClass}>
                  <td className="px-1 py-0.5">{idx}</td>
                  <td className="px-1 py-0.5">{String(parseInt(leg.flightNumber, 10) || 0).padStart(3, '0')}</td>
                  <td className="px-1 py-0.5">{leg.dep}</td>
                  <td className="px-1 py-0.5">—</td>
                  <td className="px-1 py-0.5">{fmtEp4TimeCentiemes(leg.begin_ms)}</td>
                  <td className="px-1 py-0.5">{leg.arr}</td>
                  <td className="px-1 py-0.5">—</td>
                  <td className="px-1 py-0.5">{fmtEp4TimeCentiemes(leg.end_ms)}</td>
                  <td className="px-1 py-0.5 text-right">—</td>
                  <td className="px-1 py-0.5 text-right">{fmt(leg.tdv_troncon)}</td>
                  <td className="px-1 py-0.5 text-right">{fmt(leg.tdv_troncon)}</td>
                  <td className="px-1 py-0.5 text-right">0</td>
                  <td className="px-1 py-0.5 text-right">{isLastLegOfSvc && isLastSvcOfRot ? fmt(ep4.TA) : ''}</td>
                  <td className="px-1 py-0.5 text-right">{isLastLegOfSvc ? fmt(svc.tsv_nuit) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Feuille Décompte EP4 (format document officiel) ─────────────────────────

const PVEI = 120.65;
const KSP  = 1.07;

export function Ep4DecompteEP4Consolidee({ flights, year, month, highlightedKeys, scrollRef }: {
  flights: ConsoFlight[];
  year: number;
  month: number;
  highlightedKeys?: Set<string>;
  /** Ref optionnel sur le conteneur scrollable horizontal — permet à un
   *  parent de synchroniser le scroll avec un autre tableau jumeau (ex:
   *  le panel PDF importé sur l'onglet Décompte). */
  scrollRef?: Ref<HTMLDivElement>;
}) {
  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd   = month === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, month, 1);

  // Totaux en reduce — accumulateur object pour respecter l'immutabilité du render.
  const totals = flights.reduce(
    (a, { ep4, is_spillover }) => {
      if (is_spillover) return a;
      const svcAgg = ep4.services.reduce(
        (sa, svc) => {
          const legSum = svc.legs.reduce(
            (la, l) => ({ Hv100: la.Hv100 + l.hv100, Hv100r: la.Hv100r + l.hv100r }),
            { Hv100: 0, Hv100r: 0 },
          );
          return {
            HVReal: sa.HVReal + svc.block_block,
            TME:    sa.TME    + (svc.TME ?? 0),
            HCV:    sa.HCV    + svc.HCV,
            HCT:    sa.HCT    + svc.HCT,
            H1:     sa.H1     + svc.H1,
            HCVr:   sa.HCVr   + svc.HCVr,
            H1r:    sa.H1r    + svc.H1r,
            Nuit:   sa.Nuit   + svc.tsv_nuit,
            MontantNuit: sa.MontantNuit + svc.tsv_nuit * PVEI,
            Hv100:  sa.Hv100  + legSum.Hv100,
            Hv100r: sa.Hv100r + legSum.Hv100r,
          };
        },
        { HVReal: 0, TME: 0, HCV: 0, HCT: 0, H1: 0, HCVr: 0, H1r: 0, Nuit: 0, MontantNuit: 0, Hv100: 0, Hv100r: 0 },
      );
      return {
        HVReal: a.HVReal + svcAgg.HVReal,
        TME:    a.TME    + svcAgg.TME,
        HCV:    a.HCV    + svcAgg.HCV,
        HCT:    a.HCT    + svcAgg.HCT,
        H1:     a.H1     + svcAgg.H1,
        HCVr:   a.HCVr   + svcAgg.HCVr,
        H1r:    a.H1r    + svcAgg.H1r,
        Nuit:   a.Nuit   + svcAgg.Nuit,
        MontantNuit: a.MontantNuit + svcAgg.MontantNuit,
        Hv100:  a.Hv100  + svcAgg.Hv100,
        Hv100r: a.Hv100r + svcAgg.Hv100r,
        HCA:    a.HCA    + ep4.HCA,
        H2HC:   a.H2HC   + ep4.H2HC,
        H2HCr:  a.H2HCr  + ep4.H2HCr,
        MontantHCr: a.MontantHCr + ep4.H2HCr * PVEI * KSP,
      };
    },
    {
      HVReal: 0, TME: 0, HCV: 0, HCT: 0, H1: 0, HCVr: 0, H1r: 0, Nuit: 0,
      MontantNuit: 0, Hv100: 0, Hv100r: 0, HCA: 0, H2HC: 0, H2HCr: 0, MontantHCr: 0,
    },
  );
  const totHVReal = totals.HVReal, totTME = totals.TME, totHCV = totals.HCV;
  const totHCT = totals.HCT, totHCA = totals.HCA;
  const totH1 = totals.H1, totH2HC = totals.H2HC, totHCVr = totals.HCVr;
  const totH1r = totals.H1r, totH2HCr = totals.H2HCr;
  const totMontantHCr = totals.MontantHCr, totNuit = totals.Nuit, totMontantNuit = totals.MontantNuit;
  const totHv100 = totals.Hv100, totHv100r = totals.Hv100r;

  // Aplatit les legs avec leur svc parent + flags (1er leg du svc/rot) pour
  // savoir où afficher les valeurs agrégées (HCV/H1/HCA…) qui n'apparaissent
  // qu'une fois par svc ou rot dans l'EP4 officiel.
  const flatRows = flights.flatMap(({ ep4, is_spillover }, ri) =>
    ep4.services.flatMap((svc, si) =>
      svc.legs.map((leg, li) => ({
        leg, svc, ep4, is_spillover,
        isFirstOfRot:    si === 0 && li === 0,
        isFirstOfSvc:    li === 0,
        rotKey:          `${ep4.rotation_code ?? 'rot'}-${ep4.debut_vol_ms}-${ri}`,
      })),
    ),
  );

  // Format vol : zfill à 4 chiffres (ex "972" → "0972"), cohérent avec le PDF.
  const fmtVol = (n: string) => String(parseInt(n, 10) || 0).padStart(4, '0');

  return (
    <section className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
      <h3 className="text-sm font-semibold mb-3">Feuille Décompte d&apos;Activité — {flatRows.length} lignes</h3>
      <div ref={scrollRef} className="overflow-x-auto">
        {/* Sélecteurs enfants : impose px-3 + nowrap sur tous les th/td à
            l'intérieur (specificity > px-1 inline). 23 colonnes → la table
            dépasse l'écran, le scroll horizontal est attendu (cf. user). */}
        <table className="min-w-full text-[11px] font-mono whitespace-nowrap [&_th]:px-3 [&_td]:px-3">
          <thead className="text-zinc-400 uppercase tracking-wide text-[9px]">
            <tr>
              <th className="text-left  px-1 py-1">#</th>
              <th className="text-left  px-1 py-1">Date</th>
              <th className="text-left  px-1 py-1">Vol</th>
              <th className="text-left  px-1 py-1">Esc</th>
              <th className="text-right px-1 py-1">HV real</th>
              <th className="text-right px-1 py-1">TME</th>
              <th className="text-right px-1 py-1">CMT</th>
              <th className="text-right px-1 py-1">HV 100%</th>
              <th className="text-right px-1 py-1">HCV</th>
              <th className="text-right px-1 py-1">HCT</th>
              <th className="text-right px-1 py-1">HCA</th>
              <th className="text-right px-1 py-1">H1</th>
              <th className="text-right px-1 py-1">H2/HC</th>
              <th className="text-right px-1 py-1">HV 100%(r)</th>
              <th className="text-right px-1 py-1">HCV(r)</th>
              <th className="text-right px-1 py-1">H1(r)</th>
              <th className="text-right px-1 py-1">H2(r)/HC(r)</th>
              <th className="text-right px-1 py-1">Montant HC(r)</th>
              <th className="text-right px-1 py-1">Majo Nuit</th>
              <th className="text-right px-1 py-1">Mt Nuit</th>
              <th className="text-right px-1 py-1">Majo 10%</th>
              <th className="text-right px-1 py-1">Prime CDB</th>
            </tr>
          </thead>
          <tbody>
            {flatRows.map((r, idx) => {
              const { leg, svc, ep4, is_spillover, isFirstOfRot, isFirstOfSvc } = r;
              const isSpillover = is_spillover || leg.end_ms < monthStart || leg.begin_ms >= monthEnd;
              const k = diffKey(leg.flightNumber, new Date(leg.begin_ms).getUTCDate());
              const isDiff = !isSpillover && (highlightedKeys?.has(k) ?? false);
              const rowClass = [
                isSpillover ? 'italic text-zinc-400' : '',
                isDiff ? DIFF_ROW_CLASS : '',
                isFirstOfRot && idx > 0 ? 'border-t border-zinc-200 dark:border-zinc-700' : '',
              ].filter(Boolean).join(' ');
              const montantHCr  = isFirstOfRot ? ep4.H2HCr * PVEI * KSP : null;
              const montantNuit = isFirstOfSvc && svc.tsv_nuit > 0 ? svc.tsv_nuit * PVEI : null;
              return (
                <tr key={`d-${leg.flightNumber}-${leg.begin_ms}-${idx}`} className={rowClass}>
                  <td className="px-1 py-0.5">{idx}</td>
                  <td className="px-1 py-0.5">{fmtDateCourt(leg.begin_ms)}</td>
                  <td className="px-1 py-0.5">{fmtVol(leg.flightNumber)}</td>
                  <td className="px-1 py-0.5">{leg.dep}→{leg.arr}</td>
                  <td className="px-1 py-0.5 text-right">{fmt(leg.hv100)}</td>
                  <td className="px-1 py-0.5 text-right">{isFirstOfSvc ? fmt(svc.TME) : ''}</td>
                  <td className="px-1 py-0.5 text-right">{isFirstOfSvc ? fmt(svc.CMT, 4) : ''}</td>
                  <td className="px-1 py-0.5 text-right">{fmt(leg.hv100)}</td>
                  <td className="px-1 py-0.5 text-right">{isFirstOfSvc ? fmt(svc.HCV) : ''}</td>
                  <td className="px-1 py-0.5 text-right">{isFirstOfSvc ? fmt(svc.HCT) : ''}</td>
                  <td className="px-1 py-0.5 text-right">{isFirstOfRot ? fmt(ep4.HCA) : ''}</td>
                  <td className="px-1 py-0.5 text-right">{isFirstOfSvc ? fmt(svc.H1)  : ''}</td>
                  <td className="px-1 py-0.5 text-right">{isFirstOfRot ? fmt(ep4.H2HC) : ''}</td>
                  <td className="px-1 py-0.5 text-right">{fmt(leg.hv100r)}</td>
                  <td className="px-1 py-0.5 text-right">{isFirstOfSvc ? fmt(svc.HCVr) : ''}</td>
                  <td className="px-1 py-0.5 text-right">{isFirstOfSvc ? fmt(svc.H1r)  : ''}</td>
                  <td className="px-1 py-0.5 text-right">{isFirstOfRot ? fmt(ep4.H2HCr) : ''}</td>
                  <td className="px-1 py-0.5 text-right">{montantHCr  != null ? fmt(montantHCr)  : ''}</td>
                  <td className="px-1 py-0.5 text-right">{isFirstOfSvc && svc.tsv_nuit > 0 ? fmt(svc.tsv_nuit) : ''}</td>
                  <td className="px-1 py-0.5 text-right">{montantNuit != null ? fmt(montantNuit) : ''}</td>
                  <td className="px-1 py-0.5 text-right" />
                  <td className="px-1 py-0.5 text-right" />
                </tr>
              );
            })}
            {flights.length > 1 && (
              <tr className="font-bold border-t border-zinc-300 dark:border-zinc-700">
                <td className="px-1 py-1" colSpan={4}>TOTAL</td>
                <td className="px-1 py-1 text-right">{fmt(totHVReal)}</td>
                <td className="px-1 py-1 text-right">{fmt(totTME)}</td>
                <td className="px-1 py-1 text-right" />
                <td className="px-1 py-1 text-right">{fmt(totHv100)}</td>
                <td className="px-1 py-1 text-right">{fmt(totHCV)}</td>
                <td className="px-1 py-1 text-right">{fmt(totHCT)}</td>
                <td className="px-1 py-1 text-right">{fmt(totHCA)}</td>
                <td className="px-1 py-1 text-right">{fmt(totH1)}</td>
                <td className="px-1 py-1 text-right">{fmt(totH2HC)}</td>
                <td className="px-1 py-1 text-right">{fmt(totHv100r)}</td>
                <td className="px-1 py-1 text-right">{fmt(totHCVr)}</td>
                <td className="px-1 py-1 text-right">{fmt(totH1r)}</td>
                <td className="px-1 py-1 text-right">{fmt(totH2HCr)}</td>
                <td className="px-1 py-1 text-right">{fmt(totMontantHCr)}</td>
                <td className="px-1 py-1 text-right">{fmt(totNuit)}</td>
                <td className="px-1 py-1 text-right">{fmt(totMontantNuit)}</td>
                <td className="px-1 py-1 text-right" />
                <td className="px-1 py-1 text-right" />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
