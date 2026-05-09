'use server';

import { createClient } from '@/lib/supabase/server';
import type { AnnexeData } from '@/lib/annexe';
import type { Json } from '@/types/supabase';

export async function loadAnnexe(): Promise<Partial<AnnexeData>> {
  const supabase = await createClient();
  const { data } = await supabase.from('annexe_table').select('slug, data');
  if (!data) return {};
  const map: Record<string, Json> = {};
  for (const row of data) map[row.slug] = row.data;
  const u = map as unknown as Record<string, unknown>;
  return {
    cat_anciennete:        (u.cat_anciennete        ?? []) as AnnexeData['cat_anciennete'],
    coef_classe:           (u.coef_classe           ?? []) as AnnexeData['coef_classe'],
    taux_avion:            (u.taux_avion            ?? []) as AnnexeData['taux_avion'],
    prime_incitation:      (u.prime_incitation      ?? []) as AnnexeData['prime_incitation'],
    prime_incitation_330:  (u.prime_incitation_330  ?? []) as AnnexeData['prime_incitation_330'],
    prime_instruction:     (u.prime_instruction     ?? []) as AnnexeData['prime_instruction'],
    traitement_base:       (u.traitement_base       ?? { base_cdb_a1: 2559.19, coef_opl: 0.665 }) as AnnexeData['traitement_base'],
  };
}

export async function saveAnnexeTable(slug: string, data: Json) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Non authentifié' };
  const { data: profile } = await supabase.from('user_profile').select('is_admin').eq('user_id', user.id).single();
  if (!profile?.is_admin) return { error: 'Accès refusé' };
  const { error } = await supabase.from('annexe_table')
    .update({ data, updated_at: new Date().toISOString() })
    .eq('slug', slug);
  return error ? { error: error.message } : { ok: true };
}
