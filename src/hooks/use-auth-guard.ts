'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import type { Session } from '@supabase/supabase-js';

// `getSession()` lit les cookies (offline-safe). `getUser()` fait un appel
// réseau — on l'utilise uniquement en revalidation background avec timeout
// pour ne JAMAIS bloquer le rendu du shell.
//
// Sur portail captif : getSession() OK (cookie présent) → on rend Dexie.
// getUser() hang/timeout → on garde la session locale. Exactement le but.

type Status = 'loading' | 'authed' | 'redirecting';

interface AuthState {
  status: Status;
  session: Session | null;
}

const SESSION_LOST_KEY = 'cm-session-lost-ts-client';
const SESSION_LOST_THROTTLE_MS = 5 * 60 * 1000;
const GETUSER_TIMEOUT_MS = 5000;

export function useAuthGuard(): AuthState {
  const router = useRouter();
  const [state, setState] = useState<AuthState>({ status: 'loading', session: null });

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (cancelled) return;

      if (!session) {
        setState({ status: 'redirecting', session: null });
        router.replace('/login');
        return;
      }

      setState({ status: 'authed', session });

      // Revalidation background avec timeout — ne bloque pas le rendu.
      // Si online + session expirée → log + redirect login.
      // Si offline/captif → timeout silencieux, on garde la session locale.
      void (async () => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), GETUSER_TIMEOUT_MS);
        try {
          const { data, error } = await supabase.auth.getUser();
          clearTimeout(timer);
          if (cancelled) return;
          if (error || !data.user) {
            await logSessionLostClient(supabase, session.user.email, '401');
            router.replace('/login');
          }
        } catch {
          // timeout / réseau coupé / portail captif : trust local session
        }
      })();
    })();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, newSession) => {
        if (cancelled) return;
        if (event === 'SIGNED_OUT') {
          router.replace('/login');
        } else if (newSession) {
          setState({ status: 'authed', session: newSession });
        }
      },
    );

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [router]);

  return state;
}

async function logSessionLostClient(
  supabase: ReturnType<typeof createClient>,
  email: string | undefined,
  reason: 'timeout' | '401',
): Promise<void> {
  try {
    const last = localStorage.getItem(SESSION_LOST_KEY);
    if (last && Number(last) + SESSION_LOST_THROTTLE_MS > Date.now()) return;
    await supabase.from('auth_log').insert({
      email:   email ?? '(unknown)',
      kind:    'session_lost',
      user_id: null,
      meta:    {
        user_agent:      navigator.userAgent,
        path:            window.location.pathname,
        source:          'client',
        reason,
        sw_controller:   !!navigator.serviceWorker?.controller,
      } as never,
    });
    localStorage.setItem(SESSION_LOST_KEY, String(Date.now()));
  } catch {
    // offline : on n'écrit rien, normal
  }
}
