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
/** Flag localStorage : on a deja eu une session valide au moins une fois.
 *  Set au 1er getSession ok+session, removed sur SIGNED_OUT/401. Sert au
 *  fast path offline : on skip getSession (qui hang 3s) et on entre direct
 *  sur le shell — la session reste lisible cote SW et utilisable pour
 *  consulter le cache Dexie. */
const HAS_SESSION_KEY = 'cm-has-session';

export function useAuthGuard(): AuthState {
  const router = useRouter();
  const [state, setState] = useState<AuthState>({ status: 'loading', session: null });

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    // Fast path offline : si on a deja eu une session validee precedemment
    // (flag set au dernier successful getSession online), on skip getSession()
    // qui hang 3s offline (Supabase essaie un refresh token reseau). Sans ca,
    // chaque mount d'un composant utilisant useAuthGuard paie 3s. Le shell
    // tolere session=null (cf gantt-shell-client commentaire).
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem(HAS_SESSION_KEY) === '1') {
          console.warn('[auth-guard] offline fast path (cached session flag)');
          setState({ status: 'authed', session: null });
          return () => { cancelled = true; };
        }
      } catch { /* localStorage indispo (mode prive ?) → fall through */ }
    }

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
      // Marque le fast path offline pour les prochains mounts. On le fait
      // uniquement quand on a vraiment une session (pas sur timeout, qui pourrait
      // venir d'une session inexistante mais juste lente à résoudre).
      if (sessionRes.kind === 'ok' && session) {
        try { localStorage.setItem(HAS_SESSION_KEY, '1'); } catch { /* quota */ }
      }

      // Revalidation background avec timeout — ne bloque pas le rendu.
      // Si online + 401 confirme → log + redirect login.
      // Si offline / captif / erreur reseau : trust la session locale.
      void (async () => {
        // Gate offline : sans ça, `getUser()` lance un POST qui hang puis
        // échoue silencieusement, polluant DevTools console et le diagnostic
        // offline (4g captif AF). La session locale est déjà rendue OK
        // au-dessus — pas besoin de revalider tant qu'on n'a pas de réseau.
        if (typeof navigator !== 'undefined' && !navigator.onLine) return;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), GETUSER_TIMEOUT_MS);
        try {
          const { data, error } = await supabase.auth.getUser();
          clearTimeout(timer);
          if (cancelled) return;
          if (!error && data.user) return;
          // Anti-boucle offline : si pas de signal reseau, ne pas rediriger.
          if (typeof navigator !== 'undefined' && !navigator.onLine) return;
          // 4g/wifi captif : navigator.onLine peut etre true alors que les
          // requetes Supabase sont droppees par le firewall du reseau pro.
          // On ne redirige que si l'erreur est un vrai 401 (status explicite).
          // Toute autre erreur (network, timeout, fetch failed, captif HTML)
          // est traitee comme "transient" → on garde la session locale.
          const status = (error as { status?: number } | null)?.status;
          if (status !== 401) return;
          try { localStorage.removeItem(HAS_SESSION_KEY); } catch { /* */ }
          await logSessionLostClient(supabase, session?.user.email, '401');
          router.replace('/login');
        } catch {
          // timeout / réseau coupé / portail captif : trust local session
        }
      })();
    })();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, newSession) => {
        if (cancelled) return;
        if (event === 'SIGNED_OUT') {
          // Anti-boucle offline : Supabase peut fire SIGNED_OUT quand le
          // refresh silencieux d'un token échoue (réseau coupé). Si offline,
          // on ignore et on garde la session locale telle quelle.
          if (typeof navigator !== 'undefined' && !navigator.onLine) {
            console.warn('[auth-guard] SIGNED_OUT ignored (offline)');
            return;
          }
          // 4g/wifi captif au travail : navigator.onLine === true mais les
          // requetes Supabase sont droppees par le firewall, ce qui fait
          // hang le refresh token et Supabase fire SIGNED_OUT en faux positif.
          // Sans gate, router.replace('/login') part dans le vide (RSC fetch
          // hang sur captif) → shell coince sur SkeletonShell. On confirme
          // via getUser avec timeout court : timeout = captif → ignore.
          const probe = await Promise.race([
            supabase.auth.getUser()
              .then(r => ({ kind: 'resolved' as const, status: (r.error as { status?: number } | null)?.status, hasUser: !r.error && !!r.data?.user }))
              .catch(() => ({ kind: 'resolved' as const, status: undefined, hasUser: false })),
            new Promise<{ kind: 'timeout' }>(r => setTimeout(() => r({ kind: 'timeout' as const }), 3000)),
          ]);
          if (cancelled) return;
          if (probe.kind === 'timeout') {
            console.warn('[auth-guard] SIGNED_OUT not confirmed (probe timeout — captif ?) → ignore');
            return;
          }
          if (probe.hasUser) {
            console.warn('[auth-guard] SIGNED_OUT false alarm — getUser returned a user → ignore');
            return;
          }
          // Sur 4g captif, Supabase peut renvoyer une erreur non-401 (fetch
          // failed, parse JSON sur HTML de portail). On ne redirige que sur
          // un vrai 401 explicite. Sinon → suppose transient → garde session.
          if (probe.status !== 401) {
            console.warn('[auth-guard] SIGNED_OUT not confirmed by 401 → ignore (status=' + String(probe.status) + ')');
            return;
          }
          try { localStorage.removeItem(HAS_SESSION_KEY); } catch { /* */ }
          router.replace('/login');
        } else if (newSession) {
          setState({ status: 'authed', session: newSession });
          try { localStorage.setItem(HAS_SESSION_KEY, '1'); } catch { /* */ }
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
