'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

async function ensureAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('user_profile')
    .select('is_admin')
    .eq('user_id', user.id)
    .single();

  if (!profile?.is_admin) redirect('/');
  return supabase;
}

export async function addAllowedEmail(email: string, note: string | null) {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { error: 'Email invalide' };
  }
  const supabase = await ensureAdmin();
  const { data: { user } } = await supabase.auth.getUser();

  const { error } = await supabase.from('allowed_email').insert({
    email:    trimmed,
    note:     note?.trim() || null,
    added_by: user!.id,
  });

  if (error) return { error: error.message };
  revalidatePath('/admin/whitelist');
  return { success: true };
}

export async function removeAllowedEmail(email: string) {
  const supabase = await ensureAdmin();
  const { error } = await supabase
    .from('allowed_email')
    .delete()
    .eq('email', email.toLowerCase());

  if (error) return { error: error.message };
  revalidatePath('/admin/whitelist');
  return { success: true };
}

/** Liste tous les profils inscrits avec leurs droits — pour l'admin de
 *  gestion des scrapers. */
export async function listUserProfiles() {
  const supabase = await ensureAdmin();
  const { data, error } = await supabase
    .from('user_profile')
    .select('user_id, display_name, is_admin, is_scraper')
    .order('display_name');
  if (error) return { error: error.message };
  return { profiles: data ?? [] };
}

/** Active/désactive le rôle is_scraper sur un profil utilisateur. */
export async function setUserScraperRole(userId: string, isScraper: boolean) {
  const supabase = await ensureAdmin();
  const { error } = await supabase
    .from('user_profile')
    .update({ is_scraper: isScraper })
    .eq('user_id', userId);
  if (error) return { error: error.message };
  revalidatePath('/admin/whitelist');
  return { success: true };
}
