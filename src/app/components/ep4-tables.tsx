// Renderer pur des 2 tableaux EP4 (feuille horaire + feuille décompte).
// Consommé par /comparatif (1 rotation au clic) et /ep4 (toutes rotations
// du planning). Pas de fetch ici — l'objet Ep4Rotation est passé en prop.

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

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="px-4 py-2 bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-100 dark:border-zinc-800">
        <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide">{title}</p>
      </div>
      {children}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-2 py-1.5 text-left whitespace-nowrap font-medium uppercase tracking-wide text-[10px]">{children}</th>;
}
function Td({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <td className={`px-2 py-1 whitespace-nowrap text-zinc-700 dark:text-zinc-300 ${right ? 'text-right' : ''}`}>{children}</td>;
}

// ─── Types pour les vues consolidées ─────────────────────────────────────────

type ConsoFlight = { ep4: Ep4Rotation; is_spillover: boolean };

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
