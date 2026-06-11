'use client';

import { useEffect, useState } from 'react';
import { buildEp4Rotation } from '@/lib/ep4';
import type { Ep4Rotation } from '@/lib/ep4';
import { getEp4Detail } from '@/app/actions/ep4';
import { Ep4Tables } from '@/app/components/ep4-tables';

export function Ep4Detail({
  sigId, rotationCode, zone, year, month,
  instanceDepartAt, instanceArriveeAt,
}: {
  sigId: string;
  rotationCode: string;
  zone: string | null;
  year: number;
  month: number;
  /** Bornes block de l'instance (block-off 1er leg / block-on dernier leg).
   *  Manex : briefing = block-off −1h45, closeout = block-on +30min. Override
   *  les bornes du raw_detail (potentiellement issu d'une autre durée pour
   *  les sigs splittées). */
  instanceDepartAt?:  string | null;
  instanceArriveeAt?: string | null;
}) {
  const [ep4, setEp4]         = useState<Ep4Rotation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setEp4(null);
    const BRIEFING_MS = 1.75 * 3_600_000;
    const CLOSEOUT_MS = 0.5  * 3_600_000;
    const override = (instanceDepartAt && instanceArriveeAt)
      ? {
          beginActivityMs: new Date(instanceDepartAt).getTime()  - BRIEFING_MS,
          endActivityMs:   new Date(instanceArriveeAt).getTime() + CLOSEOUT_MS,
        }
      : undefined;
    getEp4Detail(sigId)
      .then(res => {
        if (cancelled) return;
        if ('error' in res) { setError(res.error); return; }
        setEp4(buildEp4Rotation(res.raw_detail, rotationCode, zone, year, month, res.taux, res.irRates, override));
      })
      .catch(e => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sigId, rotationCode, zone, year, month, instanceDepartAt, instanceArriveeAt]);

  if (loading) return <p className="px-4 py-6 text-sm text-zinc-400">Chargement EP4…</p>;
  if (error)   return <p className="px-4 py-6 text-sm text-red-500">Erreur EP4 : {error}</p>;
  if (!ep4)    return null;

  return <Ep4Tables ep4={ep4} year={year} month={month} />;
}
