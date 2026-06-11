'use client';

import { useEffect, useState } from 'react';
import { buildEp4Rotation } from '@/lib/ep4';
import type { Ep4Rotation } from '@/lib/ep4';
import { getEp4Detail } from '@/app/actions/ep4';
import { Ep4Tables } from '@/app/components/ep4-tables';

export function Ep4Detail({
  sigId, rotationCode, zone, year, month,
  instanceDepartAt, instanceArriveeAt,
  instanceBriefingAt, instanceCloseoutAt,
}: {
  sigId: string;
  rotationCode: string;
  zone: string | null;
  year: number;
  month: number;
  /** Bornes block de l'instance (block-off 1er leg / block-on dernier leg).
   *  Fallback pour Manex (briefing = block-off −1h45 / closeout = block-on +30min)
   *  quand briefing/closeout exacts non disponibles. */
  instanceDepartAt?:  string | null;
  instanceArriveeAt?: string | null;
  /** Briefing / closeout AF exacts (mig 0039). Si présents, prioritaires sur Manex. */
  instanceBriefingAt?: string | null;
  instanceCloseoutAt?: string | null;
}) {
  const [ep4, setEp4]         = useState<Ep4Rotation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setEp4(null);
    const MANEX_BRIEF_MS = 1.75 * 3_600_000;
    const MANEX_CLOSE_MS = 0.5  * 3_600_000;
    const briefMs = instanceBriefingAt ? new Date(instanceBriefingAt).getTime()
                   : instanceDepartAt   ? new Date(instanceDepartAt).getTime()  - MANEX_BRIEF_MS : null;
    const closeMs = instanceCloseoutAt ? new Date(instanceCloseoutAt).getTime()
                   : instanceArriveeAt  ? new Date(instanceArriveeAt).getTime() + MANEX_CLOSE_MS : null;
    const blockOffMs = instanceDepartAt  ? new Date(instanceDepartAt).getTime()  : undefined;
    const blockOnMs  = instanceArriveeAt ? new Date(instanceArriveeAt).getTime() : undefined;
    const override = (briefMs != null && closeMs != null)
      ? { beginActivityMs: briefMs, endActivityMs: closeMs, beginBlockMs: blockOffMs, endBlockMs: blockOnMs }
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
  }, [sigId, rotationCode, zone, year, month, instanceDepartAt, instanceArriveeAt, instanceBriefingAt, instanceCloseoutAt]);

  if (loading) return <p className="px-4 py-6 text-sm text-zinc-400">Chargement EP4…</p>;
  if (error)   return <p className="px-4 py-6 text-sm text-red-500">Erreur EP4 : {error}</p>;
  if (!ep4)    return null;

  return <Ep4Tables ep4={ep4} year={year} month={month} />;
}
