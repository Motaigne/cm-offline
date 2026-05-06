import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { NavBar } from '@/app/components/nav';
import { WhitelistClient } from './whitelist-client';

export default async function WhitelistAdminPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('user_profile')
    .select('is_admin, display_name')
    .eq('user_id', user.id)
    .single();

  if (!profile?.is_admin) redirect('/');

  const { data: emails } = await supabase
    .from('allowed_email')
    .select('email, added_at, note')
    .order('added_at', { ascending: false });

  const { data: logs } = await supabase
    .from('auth_log')
    .select('id, email, kind, created_at, meta')
    .order('created_at', { ascending: false })
    .limit(100);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <NavBar />
      <main className="flex-1 max-w-4xl mx-auto w-full p-6 space-y-6">
        <div>
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
            Administration · Whitelist
          </h1>
          <p className="text-xs text-zinc-400 mt-1">
            Seuls les emails ci-dessous peuvent se connecter au site.
          </p>
        </div>

        <WhitelistClient emails={emails ?? []} logs={logs ?? []} />
      </main>
    </div>
  );
}
