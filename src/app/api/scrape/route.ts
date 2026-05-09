import { createClient } from '@/lib/supabase/server';
import { runScrape } from '@/lib/scraper/pipeline';

/**
 * Lance la phase Téléchargement du scrape.
 *
 * Le pipeline est désormais additif : il get-or-create LE snapshot du mois,
 * compare avec ce qui est déjà en DB, et ne fetch les détails que pour les
 * activityNumbers absents. Donc :
 *  - Pas de mode "resume" séparé : tout scrape interrompu est reprenable
 *    en relançant le bouton (les rotations déjà téléchargées sont sautées).
 *  - windowFrom/windowTo permettent de cibler une plage de dates pour un
 *    backfill ciblé sans re-scanner tout le mois côté CrewBidd.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const { data: profile } = await supabase
    .from('user_profile')
    .select('is_admin')
    .eq('user_id', user.id)
    .single();

  if (!profile?.is_admin) {
    return new Response('Profil non autorisé à scraper', { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const { month, cookie, sn, userId, windowFrom, windowTo } = body ?? {};

  if (!month || !cookie || !sn || !userId) {
    return new Response('Champs manquants : month, cookie, sn, userId', { status: 400 });
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return new Response('Format de mois invalide (YYYY-MM)', { status: 400 });
  }
  if ((windowFrom && !windowTo) || (!windowFrom && windowTo)) {
    return new Response('windowFrom et windowTo doivent être fournis ensemble', { status: 400 });
  }
  if (windowFrom && !/^\d{4}-\d{2}-\d{2}$/.test(windowFrom)) {
    return new Response('Format de windowFrom invalide (YYYY-MM-DD)', { status: 400 });
  }
  if (windowTo && !/^\d{4}-\d{2}-\d{2}$/.test(windowTo)) {
    return new Response('Format de windowTo invalide (YYYY-MM-DD)', { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream  = new ReadableStream({
    async start(controller) {
      function emit(data: object) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      try {
        for await (const event of runScrape({
          month,
          cookie,
          sn,
          userId,
          supabaseUserId: user.id,
          windowFrom,
          windowTo,
        })) {
          emit(event);
        }
      } catch (err) {
        emit({ type: 'error', message: String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}
