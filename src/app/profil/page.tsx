import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { loadAllAnnexeRows } from '@/app/actions/annexe';
import { loadAllProfileVersions } from '@/app/actions/profile-version';
import { NavBar } from '@/app/components/nav';
import { ProfilForm } from './profil-form';

export default async function ProfilPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [{ data: profile }, allVersions, annexeRows] = await Promise.all([
    supabase.from('user_profile').select('*').eq('user_id', user.id).single(),
    loadAllProfileVersions(user.id),
    // Toutes les rows versionnées → on slice client-side selon la version
    // de profil sélectionnée (Jan vs Avr peut tomber sur 2 annexes différentes).
    loadAllAnnexeRows(),
  ]);

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
              Les éléments de paie sont versionnés par date d&apos;application. Le calendrier
              utilise la version applicable au mois affiché.
            </p>
          </div>
          <ProfilForm
            initialData={profile ?? undefined}
            isNew={!profile}
            annexeRows={annexeRows}
            allVersions={allVersions}
          />
        </div>
      </div>
    </div>
  );
}
