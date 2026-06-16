'use client';

// Page client : HTML statique précachable par le SW. Le check "déjà connecté"
// est fait côté client (getSession lit les cookies sans réseau), pour que la
// page reste fonctionnelle en mode offline / wifi captif.

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { LoginForm } from './login-form';

function LoginPageInner() {
  const router  = useRouter();
  const params  = useSearchParams();
  const error   = params.get('error') ?? undefined;
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    // Si déjà connecté → rebascule sur l'accueil. Lecture cookie synchrone,
    // ne touche pas Supabase Auth. Remplace l'ancien check Server Component
    // qui faisait un getUser() réseau (cassé sur wifi captif).
    let cancelled = false;
    void (async () => {
      try {
        const supabase = createClient();
        const { data: { session } } = await supabase.auth.getSession();
        if (cancelled) return;
        if (session) {
          router.replace('/');
          return;
        }
      } catch { /* offline / pas de cookies — on reste sur login */ }
      if (!cancelled) setChecked(true);
    })();
    return () => { cancelled = true; };
  }, [router]);

  if (!checked) {
    // Pas de spinner ici pour éviter le flash : le formulaire arrive en < 100ms.
    return null;
  }

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

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}
