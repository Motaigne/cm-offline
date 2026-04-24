import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  return (
    <main className="flex-1 flex flex-col items-center justify-center p-8">
      <h1 className="text-3xl font-semibold">CM-offline</h1>
      <p className="mt-2 text-zinc-500">
        Connecté en tant que <span className="font-mono">{user.email}</span>
      </p>
      <p className="mt-8 text-sm text-zinc-400">
        Le calendrier de planification sera ici.
      </p>
    </main>
  );
}
