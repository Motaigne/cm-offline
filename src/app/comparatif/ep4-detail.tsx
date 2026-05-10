'use client';

import { useEffect, useState } from 'react';
import { buildEp4Rotation } from '@/lib/ep4';
import type { Ep4Rotation } from '@/lib/ep4';
import { getEp4Detail } from '@/app/actions/ep4';

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

export function Ep4Detail({
  sigId, rotationCode, zone, year, month,
}: {
  sigId: string;
  rotationCode: string;
  zone: string | null;
  year: number;
  month: number;
}) {
  const [ep4, setEp4]         = useState<Ep4Rotation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setEp4(null);
    getEp4Detail(sigId)
      .then(res => {
        if (cancelled) return;
        if ('error' in res) { setError(res.error); return; }
        const built = buildEp4Rotation(res.raw_detail, rotationCode, zone, year, month, res.taux);
        setEp4(built);
      })
      .catch(e => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sigId, rotationCode, zone, year, month]);

  if (loading) return <Card title="EP4 — Feuille horaire + décompte"><p className="px-4 py-6 text-sm text-zinc-400">Chargement EP4…</p></Card>;
  if (error)   return <Card title="EP4 — Feuille horaire + décompte"><p className="px-4 py-6 text-sm text-red-500">Erreur EP4 : {error}</p></Card>;
  if (!ep4)    return null;

  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd   = month === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, month, 1);
  const flatLegs = ep4.services.flatMap(svc => svc.legs.map(leg => ({ leg, svc })));

  return (
    <div className="space-y-4">

      {/* Feuille horaire */}
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

      {/* Feuille décompte */}
      <Card title="Feuille de décompte d'activité PN EP4">
        <div className="overflow-x-auto">
          <table className="text-[11px] font-mono w-max border-collapse">
            <thead>
              <tr className="bg-zinc-50 dark:bg-zinc-800 text-zinc-500 border-b border-zinc-200 dark:border-zinc-700">
                {['Service','Tronçon','TME','CMT','HCV','HCVmoisM','HCT','HCA','H1','H2HC','rtHDV','HV100r','HCVr','H1r','H2HCr','Prime','deadHead','IR','tempsSej','Zone','tauxApp']
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

      {flatLegs.some(({ leg }) => leg.end_ms < monthStart || leg.begin_ms >= monthEnd) && (
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
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-2 py-1 whitespace-nowrap text-zinc-700 dark:text-zinc-300">{children}</td>;
}
