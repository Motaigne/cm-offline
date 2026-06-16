import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from '@/types/supabase';

// Equivalent du "updateSession" de la doc Supabase, adapté Next.js 16 (proxy.ts).
// Rafraîchit le token auth à chaque requête et propage les cookies.

/** Cookie throttle : on ne logge un session_lost que toutes les 5min pour
 *  éviter le spam si un user est en boucle reload sur /login. */
const SESSION_LOST_THROTTLE_COOKIE = 'cm-session-lost-ts';
const SESSION_LOST_THROTTLE_MS = 5 * 60 * 1000;

// Routes "client-shell" : leur HTML est statique et précachée par le SW.
// L'auth est vérifiée côté client (useAuthGuard). On ne fait plus de
// getUser() serveur sur ces routes — économie d'un RTT Supabase au boot ET
// suppression d'une dépendance réseau qui fait écran blanc sur wifi captif
// quand le SW n'a pas encore intercepté la requête (premier visit post-deploy).
const SHELL_ROUTES = new Set(['/', '/login', '/onboarding', '/setup-password']);

export async function updateSession(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Court-circuit pour les routes shell : pas de getUser(), pass-through total.
  if (SHELL_ROUTES.has(pathname)) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT : ne pas faire d'autre logique entre createServerClient et getUser
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Redirection : si pas connecté et route non publique → /login
  const isPublic =
    pathname.startsWith('/auth') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api/public');

  if (!user && !isPublic) {
    // Instrumentation : log session_lost dans auth_log (throttle 5min via cookie)
    // pour mesurer la fréquence des reconnexions involontaires.
    const logged = await logSessionLost(request, supabase);

    const url = request.nextUrl.clone();
    url.pathname = '/login';
    const redirect = NextResponse.redirect(url);
    if (logged) {
      redirect.cookies.set(SESSION_LOST_THROTTLE_COOKIE, String(Date.now()), {
        maxAge: 60 * 60, sameSite: 'lax', secure: true, httpOnly: true, path: '/',
      });
    }
    return redirect;
  }

  return supabaseResponse;
}

/** Insert auth_log row avec kind='session_lost'. Throttle via cookie : si un
 *  log a été émis < 5min auparavant, skip (un user en boucle /login génèrerait
 *  sinon des dizaines d'événements identiques). L'email vient du cookie
 *  cm-last-email posé après chaque signin réussi — peut être absent (premier
 *  visiteur jamais loggé, ou cookies wipés).
 *
 *  Retourne true si un log a été émis (le caller pose le throttle cookie). */
async function logSessionLost(
  request: NextRequest,
  supabase: ReturnType<typeof createServerClient<Database>>,
): Promise<boolean> {
  const lastTs = request.cookies.get(SESSION_LOST_THROTTLE_COOKIE)?.value;
  if (lastTs && Number(lastTs) + SESSION_LOST_THROTTLE_MS > Date.now()) return false;

  const email = request.cookies.get('cm-last-email')?.value ?? '(unknown)';
  const userAgent = request.headers.get('user-agent') ?? '';
  // `sb-*` = cookies de session Supabase. Si vides au moment du session_lost,
  // c'est probablement ITP/wipe cookie. Si présents, c'est plus louche (token
  // refusé par getUser : token corrompu ? refresh échoué ?).
  const sbCookies = request.cookies.getAll()
    .filter(c => c.name.startsWith('sb-'))
    .map(c => c.name);
  const meta = {
    user_agent:      userAgent,
    path:            request.nextUrl.pathname,
    sb_cookies:      sbCookies,
    sb_cookies_count: sbCookies.length,
  };
  try {
    await supabase.from('auth_log').insert({
      email,
      kind:    'session_lost',
      user_id: null,
      meta:    meta as never,
    });
    return true;
  } catch {
    /* best-effort : ne jamais bloquer le redirect */
    return false;
  }
}
