import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { loadAnnexe } from '@/app/actions/annexe';
import { NavBar } from '@/app/components/nav';
import { ProfilForm } from './profil-form';

export default async function ProfilPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('user_profile')
    .select('*')
    .eq('user_id', user.id)
    .single();

  const annexe = await loadAnnexe();

  return (
    <div className="flex flex-col h-screen bg-zinc-50 dark:bg-zinc-950 overflow-hidden">
      <NavBar />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto p-6 space-y-6">
          <div>
            <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
              {!profile ? 'Créer mon profil' : 'Mon profil'}
            </h1>
            <p className="text-sm text-zinc-400 mt-0.5">
              Les éléments de paie se recalculent automatiquement à chaque modification.
            </p>
          </div>
          <ProfilForm initialData={profile ?? undefined} isNew={!profile} annexe={annexe} />
        </div>
      </div>
    </div>
  );
}
