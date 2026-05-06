import { createClient } from '@/lib/supabase/server';
import { computeTsvNuit } from '@/lib/scraper/tsv-nuit';
import type { PairingDetail } from '@/lib/scraper/types';

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const { data: profile } = await supabase
    .from('user_profile').select('is_scraper').eq('user_id', user.id).single();
  if (!profile?.is_scraper) return new Response('Forbidden', { status: 403 });

  const { data: rows } = await supabase
    .from('pairing_signature')
    .select('id, raw_detail')
    .is('tsv_nuit', null)
    .not('raw_detail', 'is', null)
    .limit(500);

  if (!rows?.length) return Response.json({ updated: 0 });

  let updated = 0;
  for (const row of rows) {
    try {
      const detail = row.raw_detail as unknown as PairingDetail;
      const tsvNuit = computeTsvNuit(detail);
      await supabase
        .from('pairing_signature')
        .update({ tsv_nuit: tsvNuit })
        .eq('id', row.id);
      updated++;
    } catch { /* skip malformed rows */ }
  }

  return Response.json({ updated, remaining: rows.length === 500 ? 'more' : 0 });
}
