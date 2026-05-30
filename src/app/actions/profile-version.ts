'use server';

import { createClient } from '@/lib/supabase/server';
import type { Database } from '@/types/supabase';

export type ProfileVersion = Database['public']['Tables']['user_profile_version']['Row'];

/**
 * Normalise un mois (`YYYY-MM` ou `YYYY-MM-DD`) vers la date `YYYY-MM-01`.
 */
function monthStart(month: string): string {
  if (/^\d{4}-\d{2}$/.test(month)) return `${month}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(month)) return month.slice(0, 8) + '01';
  return month;
}

/**
 * Version du profil applicable au mois cible (valid_from <= 1er du mois, la
 * plus récente). Renvoie null si aucune version. Si userId est omis, utilise
 * l'utilisateur authentifié.
 */
export async function loadProfileForMonth(
  month: string,
  userId?: string,
): Promise<ProfileVersion | null> {
  const supabase = await createClient();
  let uid = userId;
  if (!uid) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    uid = user.id;
  }
  const cutoff = monthStart(month);
  const { data } = await supabase
    .from('user_profile_version')
    .select('*')
    .eq('user_id', uid)
    .lte('valid_from', cutoff)
    .order('valid_from', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/**
 * Toutes les versions du profil pour un user, triées (plus récente d'abord).
 * Si userId est omis, utilise l'utilisateur authentifié.
 */
export async function loadAllProfileVersions(userId?: string): Promise<ProfileVersion[]> {
  const supabase = await createClient();
  let uid = userId;
  if (!uid) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return [];
    uid = user.id;
  }
  const { data } = await supabase
    .from('user_profile_version')
    .select('*')
    .eq('user_id', uid)
    .order('valid_from', { ascending: false });
  return data ?? [];
}

/**
 * Upsert une version du profil. validFrom doit être au 1er du mois (YYYY-MM-01).
 * Sécurité : RLS contrôle qu'on n'écrit que sur son propre user_id (sauf admin).
 */
export async function saveProfileVersion(
  validFrom: string,
  fields: Partial<Omit<ProfileVersion, 'user_id' | 'valid_from' | 'created_at' | 'updated_at'>>,
  userId?: string,
): Promise<{ ok: true } | { error: string }> {
  if (!/^\d{4}-\d{2}-01$/.test(validFrom)) return { error: 'valid_from doit être YYYY-MM-01' };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Non authentifié' };
  const uid = userId ?? user.id;

  // Tente update d'abord ; si 0 rows touchées → insert.
  const { data: updated, error: updateErr } = await supabase
    .from('user_profile_version')
    .update(fields)
    .eq('user_id', uid)
    .eq('valid_from', validFrom)
    .select('user_id');
  if (updateErr) return { error: updateErr.message };
  if (updated && updated.length > 0) return { ok: true };

  // Insert : besoin des NOT NULL (fonction, regime) → la version précédente
  // ou les fields fournis doivent les contenir. Si pas dans fields, on copie
  // depuis la version la plus récente (ou échoue si aucune).
  const requiredFields = ['fonction', 'regime'] as const;
  const missing = requiredFields.filter(k => fields[k] == null);
  let toInsert = { ...fields };
  if (missing.length > 0) {
    const { data: prev } = await supabase
      .from('user_profile_version')
      .select('*')
      .eq('user_id', uid)
      .order('valid_from', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!prev) return { error: `Champs manquants à l'insert : ${missing.join(', ')}` };
    toInsert = { ...prev, ...fields };
  }

  const { error: insertErr } = await supabase
    .from('user_profile_version')
    .insert({ user_id: uid, valid_from: validFrom, ...toInsert } as never);
  if (insertErr) return { error: insertErr.message };
  return { ok: true };
}

/**
 * Supprime une version du profil. RLS contrôle l'autorisation.
 */
export async function deleteProfileVersion(
  validFrom: string,
  userId?: string,
): Promise<{ ok: true } | { error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Non authentifié' };
  const uid = userId ?? user.id;
  const { error } = await supabase
    .from('user_profile_version')
    .delete()
    .eq('user_id', uid)
    .eq('valid_from', validFrom);
  if (error) return { error: error.message };
  return { ok: true };
}
