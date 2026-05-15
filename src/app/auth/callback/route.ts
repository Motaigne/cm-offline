import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/';

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      if (data?.user?.email) {
        await supabase.from('auth_log').insert({
          email:   data.user.email.toLowerCase(),
          kind:    'signin_success',
          user_id: data.user.id,
          meta:    { method: 'magic_link' },
        });
      }
      // Nouveau compte : pas encore de profil → créer un mot de passe
      const { data: profile } = await supabase
        .from('user_profile')
        .select('user_id')
        .eq('user_id', data.user.id)
        .maybeSingle();
      if (!profile) {
        const setupUrl = new URL('/setup-password', request.url);
        if (next !== '/') setupUrl.searchParams.set('next', next);
        return NextResponse.redirect(setupUrl);
      }
      return NextResponse.redirect(new URL(next, request.url));
    }
  }

  return NextResponse.redirect(new URL('/login?error=lien-invalide', request.url));
}
