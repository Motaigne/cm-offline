// Renderer pur des 2 tableaux EP4 (feuille horaire + feuille décompte).
// Consommé par /comparatif (1 rotation au clic) et /ep4 (toutes rotations
// du planning). Pas de fetch ici — l'objet Ep4Rotation est passé en prop.

import type { ReactNode } from 'react';
import type { Ep4Rotation } from '@/lib/ep4';

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

export function Ep4FraisEP4Consolidee({ flights }: { flights: ConsoFlight[] }) {
  // 18 colonnes de données
  const NCOLS = 18;

  let totIR = 0, totMF = 0, totTotalIndem = 0, totIREur = 0;

  const rotRows: ReactNode[][] = flights.map(({ ep4, is_spillover }) => {
    if (!is_spillover) {
      totIR        += ep4.IR;
      totMF        += ep4.MF;
      totTotalIndem += ep4.IR_eur + ep4.MF_eur;
      totIREur     += ep4.IR_eur;
    }

    return [
      <tr key={`sep-f-${ep4.rotation_code}-${ep4.debut_vol_ms}`}
          className="bg-zinc-100 dark:bg-zinc-800/60 border-t-2 border-zinc-300 dark:border-zinc-600">
        <td colSpan={NCOLS} className="px-2 py-0.5 text-[10px] font-semibold text-zinc-500 dark:text-zinc-300">
          {ep4.rotation_code || '—'}
          {is_spillover && <span className="ml-2 text-amber-500">↩ à cheval</span>}
        </td>
      </tr>,
      ...ep4.services.map((svc, si) => {
        const firstLeg = svc.legs[0];
        const lastLeg  = svc.legs[svc.legs.length - 1];
        const isFirstSvc = si === 0;
        const totalIndem = isFirstSvc ? ep4.IR_eur + ep4.MF_eur : null;
        return (
          <tr key={`f-${ep4.rotation_code}-${svc.service_index}`}
              className={`border-b border-zinc-100 dark:border-zinc-800 ${is_spillover ? 'italic text-zinc-400' : ''}`}>
            {/* Départ */}
            <Td>{firstLeg?.dep ?? ''}</Td>
            <Td>{firstLeg ? fmtEp4Time(firstLeg.begin_ms) : ''}</Td>
            <Td>{/* Dec dep — placeholder */}</Td>
            <Td>{/* Pdéj dep — placeholder */}</Td>
            <Td right>{isFirstSvc ? String(ep4.IR) : ''}</Td>
            <Td right>{isFirstSvc ? String(ep4.MF) : ''}</Td>
            {/* Arrivée */}
            <Td>{lastLeg?.arr ?? ''}</Td>
            <Td>{lastLeg ? fmtEp4Time(lastLeg.end_ms) : ''}</Td>
            <Td>{/* Dec arr — placeholder */}</Td>
            <Td>{/* Pdéj arr — placeholder */}</Td>
            <Td>{/* IR arr — vide (déjà côté départ) */}</Td>
            <Td>{/* MF arr — vide */}</Td>
            {/* Indemnités */}
            <Td right>{totalIndem != null ? fmt(totalIndem) : ''}</Td>
            <Td>{/* Type — placeholder */}</Td>
            <Td>{/* km — placeholder */}</Td>
            <Td>{/* Mt Dec — placeholder */}</Td>
            <Td right>{isFirstSvc ? fmt(ep4.IR_eur) : ''}</Td>
            <Td>{/* PN Non Exonéré — placeholder */}</Td>
          </tr>
        );
      }),
    ];
  });

  return (
    <Card title="Frais de Déplacement EP4">
      <div className="overflow-x-auto">
        <table className="text-[11px] font-mono w-full border-collapse">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-800 text-zinc-500 border-b border-zinc-100 dark:border-zinc-700">
              <th colSpan={6} className="px-2 py-1 text-center text-[10px] font-medium uppercase tracking-wide border-b border-zinc-200 dark:border-zinc-700">Départ</th>
              <th colSpan={6} className="px-2 py-1 text-center text-[10px] font-medium uppercase tracking-wide border-b border-zinc-200 dark:border-zinc-700">Arrivée</th>
              <th rowSpan={2} className="px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide border-b border-zinc-200 dark:border-zinc-700 whitespace-nowrap">Total Indem</th>
              <th rowSpan={2} className="px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide border-b border-zinc-200 dark:border-zinc-700">Type</th>
              <th rowSpan={2} className="px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide border-b border-zinc-200 dark:border-zinc-700">km</th>
              <th rowSpan={2} className="px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide border-b border-zinc-200 dark:border-zinc-700 whitespace-nowrap">Mt Dec</th>
              <th rowSpan={2} className="px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide border-b border-zinc-200 dark:border-zinc-700 whitespace-nowrap">PN Exonéré</th>
              <th rowSpan={2} className="px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide border-b border-zinc-200 dark:border-zinc-700 whitespace-nowrap">PN Non Exonéré</th>
            </tr>
            <tr className="bg-zinc-50 dark:bg-zinc-800 text-zinc-500 border-b border-zinc-200 dark:border-zinc-700">
              <Th>Esc.</Th>
              <Th>Horaires loc.</Th>
              <Th>Dec</Th>
              <Th>Pdéj</Th>
              <Th>IR</Th>
              <Th>MF</Th>
              <Th>Esc.</Th>
              <Th>Horaires loc.</Th>
              <Th>Dec</Th>
              <Th>Pdéj</Th>
              <Th>IR</Th>
              <Th>MF</Th>
            </tr>
          </thead>
          <tbody>{rotRows}</tbody>
          {flights.length > 1 && (
            <tfoot>
              <tr className="border-t-2 border-zinc-400 dark:border-zinc-500 bg-zinc-50 dark:bg-zinc-800/40 font-semibold">
                <td colSpan={4} className="px-2 py-1 text-[10px] text-zinc-500 uppercase">Total</td>
                <Td right>{totIR > 0 ? String(totIR) : '—'}</Td>
                <Td right>{totMF > 0 ? String(totMF) : '—'}</Td>
                <td colSpan={6} />
                <Td right>{fmt(totTotalIndem)}</Td>
                <td colSpan={3} />
                <Td right>{fmt(totIREur)}</Td>
                <Td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </Card>
  );
}

// ─── Frais de Déplacement consolidés ─────────────────────────────────────────

export function Ep4FraisDeplacementConsolidee({ flights }: { flights: ConsoFlight[] }) {
  let totHDV = 0, totHC = 0, totHCVm = 0, totH2HCr = 0;
  let totPrime = 0, totIR = 0, totIREur = 0, totMF = 0, totMFEur = 0;

  const rows = flights.map(({ ep4, is_spillover }) => {
    const hcvMoisM = ep4.services.flatMap(s => s.legs).reduce((s, l) => s + l.hcv_mois_m, 0);
    totHDV   += ep4.HDV;    totHC    += ep4.HC;     totHCVm  += hcvMoisM;
    totH2HCr += ep4.H2HCr; totPrime += ep4.Prime;   totIR    += ep4.IR;
    totIREur += ep4.IR_eur; totMF    += ep4.MF;      totMFEur += ep4.MF_eur;
    return { ep4, is_spillover, hcvMoisM };
  });

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

export function Ep4HoraireEP4Consolidee({ flights, year, month }: {
  flights: ConsoFlight[];
  year: number;
  month: number;
}) {
  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd   = month === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, month, 1);
  // 12 columns: N° Ligne | Esc. | Réal dep | Prog dep | Esc. | Réal arr | Prog arr | Tps Vol | V.ref | TSV | T.A | Tps Vol Nuit
  const NCOLS = 12;

  return (
    <Card title="Feuille Horaire d'Activité du Personnel Navigant EP4">
      <div className="overflow-x-auto">
        <table className="text-[11px] font-mono w-full table-fixed border-collapse min-w-[600px]">
          <colgroup>
            <col style={{ width: '8%' }} />
            <col style={{ width: '5%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '5%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '10%' }} />
          </colgroup>
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-800 text-zinc-500 border-b border-zinc-100 dark:border-zinc-700">
              <th rowSpan={2} className="px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide whitespace-nowrap border-b border-zinc-200 dark:border-zinc-700">N° Ligne</th>
              <th rowSpan={2} className="px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide whitespace-nowrap border-b border-zinc-200 dark:border-zinc-700">Esc.</th>
              <th colSpan={2} className="px-2 py-1 text-center text-[10px] font-medium uppercase tracking-wide whitespace-nowrap border-b border-zinc-200 dark:border-zinc-700">Départ TU</th>
              <th rowSpan={2} className="px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide whitespace-nowrap border-b border-zinc-200 dark:border-zinc-700">Esc.</th>
              <th colSpan={2} className="px-2 py-1 text-center text-[10px] font-medium uppercase tracking-wide whitespace-nowrap border-b border-zinc-200 dark:border-zinc-700">Arrivée TU</th>
              <th rowSpan={2} className="px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide whitespace-nowrap border-b border-zinc-200 dark:border-zinc-700">Tps Vol</th>
              <th rowSpan={2} className="px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide whitespace-nowrap border-b border-zinc-200 dark:border-zinc-700">V.ref</th>
              <th rowSpan={2} className="px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide whitespace-nowrap border-b border-zinc-200 dark:border-zinc-700">TSV</th>
              <th rowSpan={2} className="px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide whitespace-nowrap border-b border-zinc-200 dark:border-zinc-700">T.A</th>
              <th rowSpan={2} className="px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide whitespace-nowrap border-b border-zinc-200 dark:border-zinc-700">Tps Vol Nuit</th>
            </tr>
            <tr className="bg-zinc-50 dark:bg-zinc-800 text-zinc-500 border-b border-zinc-200 dark:border-zinc-700">
              <Th>Réal</Th>
              <Th>Prog</Th>
              <Th>Réal</Th>
              <Th>Prog</Th>
            </tr>
          </thead>
          <tbody>
            {flights.map(({ ep4, is_spillover }) => {
              const allLegs = ep4.services.flatMap((svc, si) =>
                svc.legs.map((leg, li) => ({ leg, svc, si, li, isLastLegOfSvc: li === svc.legs.length - 1 }))
              );
              const isLastSvcIdx = ep4.services.length - 1;

              return [
                // Ligne séparateur rotation
                <tr key={`sep-h-${ep4.rotation_code}-${ep4.debut_vol_ms}`}
                    className="bg-zinc-100 dark:bg-zinc-800/60 border-t-2 border-zinc-300 dark:border-zinc-600">
                  <td colSpan={NCOLS} className="px-2 py-0.5 text-[10px] font-semibold text-zinc-500 dark:text-zinc-300">
                    {ep4.rotation_code || '—'}
                    {is_spillover && <span className="ml-2 text-amber-500">↩ à cheval</span>}
                  </td>
                </tr>,
                ...allLegs.map(({ leg, svc, si, li, isLastLegOfSvc }) => {
                  const isSpillover = is_spillover || leg.end_ms < monthStart || leg.begin_ms >= monthEnd;
                  const isFirstLegOfSvc = li === 0;
                  return (
                    <tr key={`h-${leg.flightNumber}-${leg.begin_ms}`}
                        className={`border-b border-zinc-100 dark:border-zinc-800 ${isSpillover ? 'italic text-zinc-400' : ''}`}>
                      <Td>{isFirstLegOfSvc ? leg.flightNumber : ''}</Td>
                      <Td>{leg.dep}</Td>
                      <Td>{fmtEp4Time(leg.begin_ms)}</Td>
                      <Td>{''}</Td>
                      <Td>{leg.arr}</Td>
                      <Td>{fmtEp4Time(leg.end_ms)}</Td>
                      <Td>{''}</Td>
                      <Td right>{fmt(leg.tdv_troncon)}</Td>
                      <Td right>{fmt(leg.tdv_troncon * svc.CMT)}</Td>
                      <Td right>{isLastLegOfSvc ? fmt(svc.tsv) : ''}</Td>
                      <Td right>{isLastLegOfSvc && si === isLastSvcIdx ? fmt(ep4.TA) : ''}</Td>
                      <Td right>{isLastLegOfSvc ? fmt(svc.tsv_nuit) : ''}</Td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─── Feuille Décompte EP4 (format document officiel) ─────────────────────────

const PVEI = 120.65;
const KSP  = 1.07;

export function Ep4DecompteEP4Consolidee({ flights, year, month }: {
  flights: ConsoFlight[];
  year: number;
  month: number;
}) {
  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd   = month === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, month, 1);

  // Totaux — 19 colonnes de données
  let totHVReal = 0, totHCV = 0, totHCT = 0, totHCA = 0;
  let totH1 = 0, totH2HC = 0, totHCVr = 0, totH1r = 0, totH2HCr = 0;
  let totMontantHCr = 0, totNuit = 0;

  const rotRows: ReactNode[][] = flights.map(({ ep4, is_spillover }) => {
    const allLegs = ep4.services.flatMap((svc, si) =>
      svc.legs.map((leg, li) => ({ leg, svc, si, li }))
    );
    const isSpilloverRot = is_spillover;

    // Accumulation totaux (non-spillover uniquement)
    if (!isSpilloverRot) {
      ep4.services.forEach(svc => {
        totHVReal += svc.block_block;
        totHCV    += svc.HCV;
        totHCT    += svc.HCT;
        totH1     += svc.H1;
        totHCVr   += svc.HCVr;
        totH1r    += svc.H1r;
        totNuit   += svc.tsv_nuit;
      });
      totHCA       += ep4.HCA;
      totH2HC      += ep4.H2HC;
      totH2HCr     += ep4.H2HCr;
      totMontantHCr += ep4.H2HCr * PVEI * KSP;
    }

    // separator colSpan = 20 columns
    return [
      <tr key={`sep-d-${ep4.rotation_code}-${ep4.debut_vol_ms}`}
          className="bg-zinc-100 dark:bg-zinc-800/60 border-t-2 border-zinc-300 dark:border-zinc-600">
        <td colSpan={20} className="px-2 py-0.5 text-[10px] font-semibold text-zinc-500 dark:text-zinc-300">
          {ep4.rotation_code || '—'}
          {isSpilloverRot && <span className="ml-2 text-amber-500">↩ à cheval</span>}
        </td>
      </tr>,
      ...allLegs.map(({ leg, svc, si, li }) => {
        const isSpillover = isSpilloverRot || leg.end_ms < monthStart || leg.begin_ms >= monthEnd;
        const isFirstLegOfSvc = li === 0;
        const isFirstLegOfRot = si === 0 && li === 0;
        const montantHCr = isFirstLegOfRot ? ep4.H2HCr * PVEI * KSP : null;
        return (
          <tr key={`d2-${leg.flightNumber}-${leg.begin_ms}`}
              className={`border-b border-zinc-100 dark:border-zinc-800 ${isSpillover ? 'italic text-zinc-400' : ''}`}>
            <Td>{fmtDateCourt(leg.begin_ms)}</Td>
            <Td>{isFirstLegOfSvc ? leg.flightNumber : ''}</Td>
            <Td>{leg.dep}</Td>
            <Td>{leg.arr}</Td>
            <Td right>{fmt(leg.tdv_troncon)}</Td>
            <Td>{/* TME — placeholder */}</Td>
            <Td>{/* HV 100% — placeholder */}</Td>
            <Td right>{isFirstLegOfSvc ? fmt(svc.CMT, 4) : ''}</Td>
            <Td right>{isFirstLegOfSvc ? fmt(svc.HCV) : ''}</Td>
            <Td right>{isFirstLegOfSvc ? fmt(svc.HCT) : ''}</Td>
            <Td right>{isFirstLegOfRot ? fmt(ep4.HCA) : ''}</Td>
            <Td right>{isFirstLegOfSvc ? fmt(svc.H1) : ''}</Td>
            <Td right>{isFirstLegOfRot ? fmt(ep4.H2HC) : ''}</Td>
            <Td right>{isFirstLegOfSvc ? fmt(svc.HCVr) : ''}</Td>
            <Td right>{isFirstLegOfSvc ? fmt(svc.H1r) : ''}</Td>
            <Td right>{isFirstLegOfRot ? fmt(ep4.H2HCr) : ''}</Td>
            <Td right>{montantHCr != null ? fmt(montantHCr) : ''}</Td>
            <Td right>{isFirstLegOfSvc && svc.tsv_nuit > 0 ? fmt(svc.tsv_nuit) : ''}</Td>
            <Td>{/* Majo 10% — placeholder */}</Td>
            <Td>{/* Prime CDB — placeholder */}</Td>
          </tr>
        );
      }),
    ];
  });

  return (
    <Card title="Feuille de Décompte d'Activité du Personnel Navigant EP4">
      <div className="overflow-x-auto">
        <table className="text-[11px] font-mono w-full border-collapse">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-800 text-zinc-500 border-b border-zinc-200 dark:border-zinc-700">
              <Th>Date</Th>
              <Th>N° Vol</Th>
              <Th>Dép.</Th>
              <Th>Arr.</Th>
              <Th>HV réal</Th>
              <Th>TME</Th>
              <Th>HV 100%</Th>
              <Th>CMT</Th>
              <Th>HCV</Th>
              <Th>HCT</Th>
              <Th>HCA</Th>
              <Th>H1</Th>
              <Th>H2/HC</Th>
              <Th>HCV(r)</Th>
              <Th>H1(r)</Th>
              <Th>H2/HC(r)</Th>
              <Th>Montant HC(r)</Th>
              <Th>Majo Nuit</Th>
              <Th>Majo 10%</Th>
              <Th>Prime CDB</Th>
            </tr>
          </thead>
          <tbody>{rotRows}</tbody>
          {flights.length > 1 && (
            <tfoot>
              <tr className="border-t-2 border-zinc-400 dark:border-zinc-500 bg-zinc-50 dark:bg-zinc-800/40 font-semibold">
                <td colSpan={4} className="px-2 py-1 text-[10px] text-zinc-500 uppercase">Total</td>
                <Td right>{fmt(totHVReal)}</Td>
                <Td />{/* TME */}
                <Td />{/* HV 100% */}
                <Td />{/* CMT */}
                <Td right>{fmt(totHCV)}</Td>
                <Td right>{fmt(totHCT)}</Td>
                <Td right>{fmt(totHCA)}</Td>
                <Td right>{fmt(totH1)}</Td>
                <Td right>{fmt(totH2HC)}</Td>
                <Td right>{fmt(totHCVr)}</Td>
                <Td right>{fmt(totH1r)}</Td>
                <Td right>{fmt(totH2HCr)}</Td>
                <Td right>{fmt(totMontantHCr)}</Td>
                <Td right>{fmt(totNuit)}</Td>
                <Td />{/* Majo 10% */}
                <Td />{/* Prime CDB */}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </Card>
  );
}
