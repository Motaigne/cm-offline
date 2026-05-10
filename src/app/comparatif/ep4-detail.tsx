'use client';

import { useEffect, useState } from 'react';
import { buildEp4Rotation } from '@/lib/ep4';
import type { Ep4Rotation } from '@/lib/ep4';
import { getEp4Detail } from '@/app/actions/ep4';
import { Ep4Tables } from '@/app/components/ep4-tables';

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
        setEp4(buildEp4Rotation(res.raw_detail, rotationCode, zone, year, month, res.taux, res.irRates));
      })
      .catch(e => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sigId, rotationCode, zone, year, month]);

  if (loading) return <p className="px-4 py-6 text-sm text-zinc-400">Chargement EP4…</p>;
  if (error)   return <p className="px-4 py-6 text-sm text-red-500">Erreur EP4 : {error}</p>;
  if (!ep4)    return null;

  return <Ep4Tables ep4={ep4} year={year} month={month} />;
}
