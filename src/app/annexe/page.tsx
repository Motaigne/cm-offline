import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { NavBar } from '@/app/components/nav';
import { AnnexeClient } from './annexe-client';

export default async function AnnexePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('user_profile')
    .select('is_admin')
    .eq('user_id', user.id)
    .single();

  const { data: tables } = await supabase
    .from('annexe_table')
    .select('slug, name, description, data, updated_at')
    .order('slug');

  return (
    <div className="flex flex-col h-screen bg-zinc-50 dark:bg-zinc-950 overflow-hidden">
      <NavBar />
      <div className="flex-1 overflow-y-auto">
        <AnnexeClient
          tables={tables ?? []}
          canEdit={profile?.is_admin ?? false}
        />
      </div>
    </div>
  );
}
