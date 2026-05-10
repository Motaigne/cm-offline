import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { Ep4PageClient } from './ep4-page-client';

export default async function Ep4Page({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const { m } = await searchParams;
  const month = m && /^\d{4}-\d{2}$/.test(m) ? m : new Date().toISOString().slice(0, 7);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return <Ep4PageClient month={month} />;
}
