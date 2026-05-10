'use server';

import { createClient } from '@/lib/supabase/server';
import type { PairingDetail } from '@/lib/scraper/types';
import type { TauxAppRow } from '@/lib/ep4';

export type Ep4DetailResponse =
  | { raw_detail: PairingDetail; taux: TauxAppRow[] }
  | { error: string };

/** Charge le raw_detail JSONB d'une signature + la table taux_app pour
 *  alimenter buildEp4Rotation côté client. Auth user requis. */
export async function getEp4Detail(sigId: string): Promise<Ep4DetailResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Non authentifié' };

  const [{ data: sig, error: sigErr }, { data: taux, error: tauxErr }] = await Promise.all([
    supabase.from('pairing_signature').select('raw_detail').eq('id', sigId).single(),
    supabase.from('taux_app').select('rot_code, duree_min_h, duree_max_h, taux'),
  ]);

  if (sigErr || !sig)         return { error: sigErr?.message ?? 'Signature introuvable' };
  if (!sig.raw_detail)        return { error: 'raw_detail absent en DB pour cette signature' };
  if (tauxErr)                return { error: tauxErr.message };

  return {
    raw_detail: sig.raw_detail as unknown as PairingDetail,
    taux: (taux ?? []) as TauxAppRow[],
  };
}
