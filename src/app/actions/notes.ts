'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

export type UserNote = {
  id: string;
  start_date: string;  // YYYY-MM-DD
  end_date: string;
  text: string;
  color: string | null;
};

/** Charge les notes overlappant le mois M (= dont [start, end] croise le mois).
 *  Inclut les notes qui débordent sur M-1/M+1 pour gérer les notes à cheval. */
export async function listNotesForMonth(month: string): Promise<UserNote[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // month = YYYY-MM. On charge [M, M+1) côté start ET end pour attraper les chevauchements.
  const [y, m] = month.split('-').map(Number);
  const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
  const next = new Date(Date.UTC(y, m, 1));
  const monthEnd = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`;

  const { data, error } = await supabase
    .from('user_note')
    .select('id, start_date, end_date, text, color')
    .eq('user_id', user.id)
    .lt('start_date', monthEnd)
    .gte('end_date', monthStart)
    .order('start_date');
  if (error) return [];
  return (data ?? []) as UserNote[];
}

export async function addNote(data: {
  id?: string;
  start_date: string;
  end_date: string;
  text: string;
  color?: string | null;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Non authentifié' };
  const { error } = await supabase.from('user_note').insert({
    id: data.id,
    user_id: user.id,
    start_date: data.start_date,
    end_date: data.end_date,
    text: data.text,
    color: data.color ?? null,
  });
  if (error) return { error: error.message };
  revalidatePath('/');
}

export async function updateNote(
  id: string,
  patch: { start_date?: string; end_date?: string; text?: string; color?: string | null },
) {
  const supabase = await createClient();
  const { error } = await supabase.from('user_note').update(patch).eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/');
}

export async function deleteNote(id: string) {
  const supabase = await createClient();
  const { error } = await supabase.from('user_note').delete().eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/');
}
