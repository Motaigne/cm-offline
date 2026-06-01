import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { NavBar } from '@/app/components/nav';
import { WhitelistClient } from './whitelist/whitelist-client';
import { OutilsClient } from './outils/outils-client';
import { listFictiveSnapshots } from '@/app/actions/admin-projection';

export default async function AdminPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('user_profile')
    .select('is_admin')
    .eq('user_id', user.id)
    .single();
  if (!profile?.is_admin) redirect('/');

  // Data Whitelist
  const [{ data: emails }, { data: logs }, { data: profiles }] = await Promise.all([
    supabase.from('allowed_email').select('email, added_at, note').order('added_at', { ascending: false }),
    supabase.from('auth_log').select('id, email, kind, created_at, meta').order('created_at', { ascending: false }).limit(100),
    supabase.from('user_profile').select('user_id, display_name, is_admin, is_scraper').order('display_name'),
  ]);

  // Data Outils (projection)
  const { data: latestReal } = await supabase
    .from('scrape_snapshot')
    .select('target_month')
    .eq('status', 'success')
    .eq('is_fictive', false)
    .order('target_month', { ascending: false })
    .limit(1)
    .maybeSingle();
  const fictives = await listFictiveSnapshots();

  return (
    <div className="flex flex-col min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <NavBar />
      <main className="flex-1 max-w-4xl mx-auto w-full p-6 space-y-8">
        <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">Administration</h1>

        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Outils · Projection (snapshots fictifs)</h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Matérialise des plannings synthétiques sur les mois non encore déployés.
              Source = intersection des rotations apparaissant dans les 3 derniers
              mois réels. Effacé automatiquement quand le vrai scrape AF arrive
              sur le même mois.
            </p>
          </div>
          <OutilsClient
            latestRealMonth={latestReal?.target_month?.slice(0, 7) ?? null}
            fictives={fictives}
          />
        </section>

        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Whitelist</h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Seuls les emails ci-dessous peuvent se connecter au site.
            </p>
          </div>
          <WhitelistClient emails={emails ?? []} logs={logs ?? []} profiles={profiles ?? []} />
        </section>
      </main>
    </div>
  );
}
