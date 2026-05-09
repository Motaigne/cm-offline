import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { NavBar } from '@/app/components/nav';
import { CatalogueTable } from './catalogue-table';

export default async function CataloguePage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const { m } = await searchParams;
  const month = m && /^\d{4}-\d{2}$/.test(m)
    ? m
    : new Date().toISOString().slice(0, 7);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('user_profile')
    .select('is_admin')
    .eq('user_id', user.id)
    .single();
  const isAdmin = profile?.is_admin === true;

  // Load available months from snapshots
  const { data: snapshots } = await supabase
    .from('scrape_snapshot')
    .select('target_month, id')
    .eq('status', 'success')
    .order('target_month', { ascending: false });

  const months = [...new Set((snapshots ?? []).map(s => s.target_month.slice(0, 7)))];

  // Find snapshot for selected month
  const snapshot = (snapshots ?? []).find(s => s.target_month.startsWith(month));

  // Load signatures for that snapshot
  const { data: rawSigs } = snapshot
    ? await supabase
        .from('pairing_signature')
        .select('id, rotation_code, zone, aircraft_code, hc, hcr_crew, tsv_nuit, prime, nb_on_days, first_layover, layovers, rest_before_h, rest_after_h, a81, heure_debut, heure_fin')
        .eq('snapshot_id', snapshot.id)
        .order('hcr_crew', { ascending: false })
    : { data: null };

  // Deduplicate signatures identical except for internal id
  type RawSig = NonNullable<typeof rawSigs>[0];
  function dedupKey(s: RawSig): string {
    return [
      s.rotation_code,
      Number(s.hc).toFixed(4),
      Number(s.hcr_crew).toFixed(4),
      Number(s.tsv_nuit ?? 0).toFixed(4),
      Number(s.rest_before_h ?? 0).toFixed(2),
      Number(s.rest_after_h ?? 0).toFixed(2),
      Number(s.prime ?? 0).toFixed(2),
      s.nb_on_days,
      s.aircraft_code,
    ].join('|');
  }
  const dedupMap = new Map<string, RawSig>();
  for (const s of rawSigs ?? []) {
    const key = dedupKey(s);
    if (!dedupMap.has(key)) dedupMap.set(key, s);
  }
  const sigs = Array.from(dedupMap.values());

  return (
    <div className="flex flex-col h-screen bg-zinc-50 dark:bg-zinc-950 overflow-hidden">
      <NavBar />
      <div className="flex-1 overflow-hidden flex flex-col">
        <CatalogueTable
          signatures={sigs}
          months={months}
          currentMonth={month}
          isAdmin={isAdmin}
        />
      </div>
    </div>
  );
}
