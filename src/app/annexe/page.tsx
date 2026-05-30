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

  // Plusieurs versions par slug depuis 0028 : on garde ici la plus récente
  // par slug (un dropdown de sélection viendra à l'étape 2).
  const { data: allRows } = await supabase
    .from('annexe_table')
    .select('slug, valid_from, name, description, data, updated_at')
    .order('slug')
    .order('valid_from', { ascending: false });
  const tables: Array<{ slug: string; name: string; description: string | null; data: import('@/types/supabase').Json; updated_at: string }> = [];
  const seen = new Set<string>();
  for (const row of allRows ?? []) {
    if (seen.has(row.slug)) continue;
    seen.add(row.slug);
    tables.push({ slug: row.slug, name: row.name, description: row.description, data: row.data, updated_at: row.updated_at });
  }

  return (
    <div className="flex flex-col h-screen bg-zinc-50 dark:bg-zinc-950 overflow-hidden">
      <NavBar />
      <div className="flex-1 overflow-y-auto">
        <AnnexeClient
          tables={tables}
          canEdit={profile?.is_admin ?? false}
        />
      </div>
    </div>
  );
}
