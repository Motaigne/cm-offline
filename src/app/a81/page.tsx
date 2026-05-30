import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { NavBar } from '@/app/components/nav';
import { loadA81ForYear, getA81AvailableYears } from '@/app/actions/a81';
import { A81Client } from './a81-client';

export default async function A81Page({
  searchParams,
}: {
  searchParams: Promise<{ y?: string }>;
}) {
  const { y } = await searchParams;
  const currentYear = new Date().getUTCFullYear();
  const year = y && /^\d{4}$/.test(y) ? Number(y) : currentYear;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [data, availableYears] = await Promise.all([
    loadA81ForYear(year),
    getA81AvailableYears(),
  ]);

  return (
    <div className="flex flex-col h-screen bg-zinc-50 dark:bg-zinc-950 overflow-hidden">
      <NavBar />
      <div className="flex-1 overflow-y-auto">
        <A81Client data={data} availableYears={availableYears} currentYear={year} />
      </div>
    </div>
  );
}
