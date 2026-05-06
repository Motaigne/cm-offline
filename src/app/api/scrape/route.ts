import { createClient } from '@/lib/supabase/server';
import { runScrape } from '@/lib/scraper/pipeline';

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const body = await req.json().catch(() => null);
  const { month, cookie, sn, userId, resume } = body ?? {};

  if (!month || !cookie || !sn || !userId) {
    return new Response('Champs manquants : month, cookie, sn, userId', { status: 400 });
  }

  if (!/^\d{4}-\d{2}$/.test(month)) {
    return new Response('Format de mois invalide (YYYY-MM)', { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function emit(data: object) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      try {
        for await (const event of runScrape({ month, cookie, sn, userId, supabaseUserId: user.id, resume: !!resume })) {
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
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}
