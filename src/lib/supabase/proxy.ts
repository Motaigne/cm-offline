import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from '@/types/supabase';

// Equivalent du "updateSession" de la doc Supabase, adapté Next.js 16 (proxy.ts).
// Rafraîchit le token auth à chaque requête et propage les cookies.

/** Cookie throttle : on ne logge un session_lost que toutes les 5min pour
 *  éviter le spam si un user est en boucle reload sur /login. */
const SESSION_LOST_THROTTLE_COOKIE = 'cm-session-lost-ts';
const SESSION_LOST_THROTTLE_MS = 5 * 60 * 1000;

export async function updateSession(request: NextRequest) {
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
  const pathname = request.nextUrl.pathname;
  const isPublic =
    pathname === '/login' ||
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
