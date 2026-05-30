'use server';

import { createClient } from '@/lib/supabase/server';
import type { AnnexeData } from '@/lib/annexe';
import type { Json } from '@/types/supabase';

/**
 * Normalise un mois (`YYYY-MM` ou `YYYY-MM-DD`) vers la date `YYYY-MM-01`
 * utilisée pour le filtrage `valid_from <= mois`.
 */
function monthStart(month: string): string {
  if (/^\d{4}-\d{2}$/.test(month)) return `${month}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(month)) return month.slice(0, 8) + '01';
  return month;
}

/**
 * Charge toutes les rows annexe_table et garde, pour chaque slug, la version
 * applicable au mois cible (la plus récente parmi celles dont
 * `valid_from <= 1er du mois`). Retourne un map `slug → data`.
 */
async function loadAnnexeMapForMonth(month: string): Promise<Record<string, Json>> {
  const supabase = await createClient();
  const cutoff = monthStart(month);
  const { data } = await supabase
    .from('annexe_table')
    .select('slug, valid_from, data')
    .lte('valid_from', cutoff)
    .order('valid_from', { ascending: false });
  if (!data) return {};
  const map: Record<string, Json> = {};
  for (const row of data) {
    if (!(row.slug in map)) map[row.slug] = row.data; // 1er hit = plus récent
  }
  return map;
}

/**
 * Version applicable au mois cible des 7 tableaux nécessaires aux calculs de
 * rémunération (PVEI, fixe, primes…).
 */
export async function loadAnnexeForMonth(month: string): Promise<Partial<AnnexeData>> {
  const map = await loadAnnexeMapForMonth(month);
  const u = map as unknown as Record<string, unknown>;
  return {
    cat_anciennete:        (u.cat_anciennete        ?? []) as AnnexeData['cat_anciennete'],
    coef_classe:           (u.coef_classe           ?? []) as AnnexeData['coef_classe'],
    taux_avion:            (u.taux_avion            ?? []) as AnnexeData['taux_avion'],
    prime_incitation:      (u.prime_incitation      ?? []) as AnnexeData['prime_incitation'],
    prime_incitation_330:  (u.prime_incitation_330  ?? []) as AnnexeData['prime_incitation_330'],
    prime_instruction:     (u.prime_instruction     ?? { icpl_a1: 0, tri_opl_b1: 0, multiplier: 1, max_annee: 5 }) as AnnexeData['prime_instruction'],
    traitement_base:       (u.traitement_base       ?? { base_cdb_a1: 2559.19, coef_opl: 0.665 }) as AnnexeData['traitement_base'],
  };
}

/**
 * Récupère la `data` d'un slug pour le mois cible (plus récente dont
 * `valid_from <= 1er du mois`). Renvoie `null` si aucune version applicable.
 */
export async function loadAnnexeRowForMonth(slug: string, month: string): Promise<Json | null> {
  const supabase = await createClient();
  const cutoff = monthStart(month);
  const { data } = await supabase
    .from('annexe_table')
    .select('data')
    .eq('slug', slug)
    .lte('valid_from', cutoff)
    .order('valid_from', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.data ?? null;
}

export async function saveAnnexeTable(slug: string, data: Json, validFrom?: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Non authentifié' };
  const { data: profile } = await supabase.from('user_profile').select('is_admin').eq('user_id', user.id).single();
  if (!profile?.is_admin) return { error: 'Accès refusé' };

  // Si validFrom n'est pas précisé, on update la version la plus récente du slug.
  let target = validFrom ?? null;
  if (!target) {
    const { data: latest } = await supabase
      .from('annexe_table')
      .select('valid_from')
      .eq('slug', slug)
      .order('valid_from', { ascending: false })
      .limit(1)
      .maybeSingle();
    target = latest?.valid_from ?? '2025-04-01';
  }

  const { error: updateErr, data: updated } = await supabase.from('annexe_table')
    .update({ data })
    .eq('slug', slug)
    .eq('valid_from', target)
    .select('slug');
  if (updateErr) return { error: updateErr.message };
  if (!updated || updated.length === 0) {
    const { error: insertErr } = await supabase.from('annexe_table')
      .insert({ slug, valid_from: target, name: slug, data });
    if (insertErr) return { error: insertErr.message };
  }
  return { ok: true };
}
