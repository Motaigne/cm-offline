import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getScenariosWithItems } from '@/app/actions/planning';
import { GanttView } from '@/app/components/gantt/gantt-view';
import type { ActivityKind, BidCategory } from '@/lib/activity-meta';
import type { ScenarioName } from '@/app/actions/planning';

export type CalendarItem = {
  id: string;
  kind: ActivityKind;
  start_date: string;
  end_date: string;
  bid_category: BidCategory | null;
  meta: import('@/types/supabase').Json | null;
  /** Flag runtime (non persisté) — vol à cheval issu du mois précédent. */
  _isSpillover?: boolean;
};

export type Scenario = {
  name: ScenarioName;
  id: string;
  items: CalendarItem[];
};

export default async function Home({
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
    .select('display_name, fonction, regime, cng_pv, cng_hs')
    .eq('user_id', user.id)
    .single();
  if (!profile) redirect('/profil');

  const scenarios: Scenario[] = await getScenariosWithItems(month);

  return (
    <GanttView
      month={month}
      scenarios={scenarios}
      userName={profile.display_name ?? user.email ?? ''}
      userRegime={profile.regime}
      cngPv={profile.cng_pv ?? 0}
      cngHs={profile.cng_hs ?? 0}
    />
  );
}
