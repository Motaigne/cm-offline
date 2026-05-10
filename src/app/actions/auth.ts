'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';

async function siteUrl() {
  const h = await headers();
  const host = h.get('host') ?? 'localhost:3000';
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  return `${proto}://${host}`;
}

const NOT_ALLOWED_MSG = "Cet email n'est pas autorisé à accéder au site. Contactez l'administrateur.";

async function isEmailAllowed(email: string): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('is_email_allowed', { check_email: email });
  if (error) {
    console.error('[auth] is_email_allowed RPC failed:', error.message);
    return false;
  }
  return Boolean(data);
}

async function logAuthEvent(
  email: string,
  kind: 'signin_denied' | 'signin_requested' | 'signin_success' | 'signout',
  userId: string | null = null,
  meta: Record<string, unknown> | null = null,
): Promise<void> {
  const supabase = await createClient();
  await supabase.from('auth_log').insert({
    email: email.toLowerCase(),
    kind,
    user_id: userId,
    meta: meta as never,
  });
}

export async function signInWithMagicLink(email: string) {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return { error: 'Email requis' };

  if (!(await isEmailAllowed(trimmed))) {
    await logAuthEvent(trimmed, 'signin_denied');
    return { error: NOT_ALLOWED_MSG };
  }

  const supabase = await createClient();
  const base = await siteUrl();
  const { error } = await supabase.auth.signInWithOtp({
    email: trimmed,
    options: { emailRedirectTo: `${base}/auth/callback` },
  });
  if (error) return { error: error.message };

  await logAuthEvent(trimmed, 'signin_requested', null, { method: 'magic_link' });
  return { success: true };
}

export async function signInWithPassword(email: string, password: string) {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return { error: 'Email requis' };

  if (!(await isEmailAllowed(trimmed))) {
    await logAuthEvent(trimmed, 'signin_denied');
    return { error: NOT_ALLOWED_MSG };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email: trimmed, password });
  if (error) return { error: error.message };

  await logAuthEvent(trimmed, 'signin_success', data.user?.id ?? null, { method: 'password' });
  redirect('/');
}

/** Renvoie true si l'utilisateur connecté a is_admin = true. Lue par la NavBar côté client. */
export async function getCurrentUserIsAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase
    .from('user_profile')
    .select('is_admin')
    .eq('user_id', user.id)
    .single();
  return Boolean(data?.is_admin);
}

/** Renvoie { is_admin, is_scraper } pour l'utilisateur connecté. Utilisé pour
 *  ouvrir le bouton Importer aux scrapers non-admin. */
export async function getCurrentUserScrapeRights(): Promise<{ is_admin: boolean; is_scraper: boolean }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { is_admin: false, is_scraper: false };
  const { data } = await supabase
    .from('user_profile')
    .select('is_admin, is_scraper')
    .eq('user_id', user.id)
    .single();
  return {
    is_admin:   Boolean(data?.is_admin),
    is_scraper: Boolean(data?.is_scraper),
  };
}

export async function signOut() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user?.email) {
    await logAuthEvent(user.email, 'signout', user.id);
  }
  await supabase.auth.signOut();
  redirect('/login');
}
