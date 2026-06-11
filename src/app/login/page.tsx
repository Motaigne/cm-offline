import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { LoginForm } from './login-form';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  // Si déjà connecté → rebascule sur l'accueil. Sans ce check, un user qui a
  // installé la PWA depuis /login (Safari iOS bookmark l'URL courante, pas le
  // start_url du manifest sur iOS < 16.4) voit le formulaire à chaque
  // ouverture même si sa session est valide → impression d'être déconnecté.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) redirect('/');

  return (
    <main className="flex-1 flex flex-col items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Connexion</h1>
          <p className="mt-1 text-sm text-zinc-500">Accès sur invitation uniquement.</p>
        </div>
        <LoginForm urlError={error} />
      </div>
    </main>
  );
}
