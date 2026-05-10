'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import type { Database } from '@/types/supabase';

type FonctionEnum = Database['public']['Enums']['fonction_enum'];
type RegimeEnum   = Database['public']['Enums']['regime_enum'];

export interface ProfileData {
  fonction:      FonctionEnum;
  regime:        RegimeEnum;
  qualifs_avion: string[];
  classe:        number | null;
  categorie:     string | null;
  echelon:       number | null;
  bonus_atpl:    boolean;
  transport:     string | null;
  aircraft_principal: string;
  cng_pv:        number;
  cng_hs:        number;
  tri_niveau:       number | null;
  prime_330_count:  number | null;
  valeur_jour:      number;
  tmi:              number;
}

export async function saveProfile(data: ProfileData) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  // En cas de session perdue (cookie expiré côté tunnel/PWA) on retourne une
  // erreur lisible plutôt qu'un redirect — un redirect depuis une server
  // action force une navigation iPad vers /login qui peut elle-même échouer.
  if (!user) return { error: 'Session expirée — recharge la page.' };

  const { error } = await supabase.from('user_profile').upsert({
    user_id: user.id,
    base:    'CDG',
    ...data,
  });

  if (error) return { error: error.message };
  return { ok: true };
}

export async function updateProfileFinancials(data: {
  aircraft_principal: string;
  cng_pv: number;
  cng_hs: number;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Non authentifié' };
  const { error } = await supabase.from('user_profile').update(data).eq('user_id', user.id);
  return error ? { error: error.message } : { ok: true };
}

// Kept for backwards-compat (onboarding redirect)
export async function createProfile(data: {
  display_name?: string;
  base?: string;
  fonction: FonctionEnum;
  regime: RegimeEnum;
  qualifs_avion: string[];
  classe: number | null;
  categorie: string | null;
  echelon: number | null;
  bonus_atpl: boolean;
  transport: string | null;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { error } = await supabase.from('user_profile').upsert({
    user_id: user.id,
    base: data.base ?? 'CDG',
    ...data,
  });

  if (error) return { error: error.message };
  redirect('/');
}
