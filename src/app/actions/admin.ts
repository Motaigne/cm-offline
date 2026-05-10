'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { fetchAllPaginated } from '@/lib/supabase/paginate';
import { computeTsvNuit } from '@/lib/scraper/tsv-nuit';
import type { PairingDetail } from '@/lib/scraper/types';

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

/** Recompute signature.tsv_nuit pour toutes les signatures avec raw_detail
 *  en utilisant la nouvelle formule per-service alignée EP4 (tsv-nuit.ts).
 *  Évite un re-scrape complet — read+write DB only. */
export async function backfillTsvNuit() {
  const supabase = await ensureAdmin();
  const sigs = await fetchAllPaginated<{ id: string; raw_detail: unknown; tsv_nuit: number | null }>((from, to) =>
    supabase
      .from('pairing_signature')
      .select('id, raw_detail, tsv_nuit')
      .not('raw_detail', 'is', null)
      .range(from, to),
  );

  let updated = 0, unchanged = 0, errors = 0;
  for (const s of sigs) {
    if (!s.raw_detail) continue;
    let newVal: number;
    try {
      newVal = computeTsvNuit(s.raw_detail as unknown as PairingDetail);
    } catch {
      errors++;
      continue;
    }
    const oldVal = Number(s.tsv_nuit ?? 0);
    if (Math.abs(newVal - oldVal) < 0.01) { unchanged++; continue; }
    const { error } = await supabase
      .from('pairing_signature')
      .update({ tsv_nuit: newVal })
      .eq('id', s.id);
    if (error) errors++;
    else      updated++;
  }
  return { total: sigs.length, updated, unchanged, errors };
}
