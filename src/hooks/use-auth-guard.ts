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
      console.warn('[auth-guard] getSession start');
      // getSession() lit les cookies en théorie offline-safe, MAIS si l'access
      // token est expiré, supabase-js tente un refresh via réseau qui hang sur
      // wifi captif / offline. Timeout 3s : si on ne sait pas en 3s, on suppose
      // authed (cookies sont là, sinon supabase-js ne tenterait pas un refresh).
      // Le background getUser ci-dessous va revalider proprement.
      const sessionRes = await Promise.race([
        supabase.auth.getSession().then(r => ({ kind: 'ok' as const, session: r.data.session })),
        new Promise<{ kind: 'timeout' }>(r => setTimeout(() => r({ kind: 'timeout' }), 3000)),
      ]);
      console.warn('[auth-guard] getSession resolved', sessionRes.kind);
      if (cancelled) return;

      const session = sessionRes.kind === 'ok' ? sessionRes.session : null;
      if (!session && sessionRes.kind === 'ok') {
        // getSession a résolu et dit "pas de session" → en théorie redirect login.
        // MAIS si on est offline, ça boucle : /login redirigerait probablement
        // vers / une fois la session reconstituée, mais sans réseau on ne
        // peut rien faire. Sur offline cold-cold (kill + wifi off + open),
        // getSession peut renvoyer null même avec un cookie présent si le
        // refresh silencieux a échoué. On reste sur le shell (status=authed,
        // session=null) — toléré par gantt-shell-client.
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          console.warn('[auth-guard] getSession=null offline → reste sur le shell');
          setState({ status: 'authed', session: null });
          return;
        }
        setState({ status: 'redirecting', session: null });
        router.replace('/login');
        return;
      }
      // session valide OU timeout : on rend le shell. setState passe ici même si
      // session=null (cas timeout) — useAuthGuard.session sera null mais le
      // shell-client n'a besoin que de status='authed' pour démarrer.
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
            // Anti-boucle offline : Supabase peut renvoyer error/user=null
            // sans throw quand le réseau est coupé. Si on est offline, on
            // trust la session locale au lieu de rediriger vers /login.
            if (typeof navigator !== 'undefined' && !navigator.onLine) {
              return;
            }
            await logSessionLostClient(supabase, session?.user.email, '401');
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
          // Anti-boucle offline : Supabase peut fire SIGNED_OUT quand le
          // refresh silencieux d'un token échoue (réseau coupé). Si offline,
          // on ignore et on garde la session locale telle quelle.
          if (typeof navigator !== 'undefined' && !navigator.onLine) {
            console.warn('[auth-guard] SIGNED_OUT ignored (offline)');
            return;
          }
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
