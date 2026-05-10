import { createClient } from '@/lib/supabase/server';
import { fetchAllPaginated } from '@/lib/supabase/paginate';
import { redirect } from 'next/navigation';
import { NavBar } from '@/app/components/nav';
import { ComparatifClient } from './comparatif-client';
import type { Article81Data } from '@/lib/article81';

export default async function ComparatifPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const { m } = await searchParams;
  const month = m && /^\d{4}-\d{2}$/.test(m)
    ? m
    : new Date().toISOString().slice(0, 7);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Article 81 : matrice annexe + valeur_jour profil (en parallèle)
  const [{ data: a81Row }, { data: profileRow }] = await Promise.all([
    supabase.from('annexe_table').select('data').eq('slug', 'article_81').single(),
    supabase.from('user_profile').select('valeur_jour').eq('user_id', user.id).single(),
  ]);
  const article81Data: Article81Data | null = (a81Row?.data as Article81Data | null) ?? null;
  const valeurJour = Number(profileRow?.valeur_jour ?? 600);

  // Snapshots disponibles
  const { data: snapshots } = await supabase
    .from('scrape_snapshot')
    .select('target_month, id')
    .eq('status', 'success')
    .order('target_month', { ascending: false });

  const months = [...new Set((snapshots ?? []).map(s => s.target_month.slice(0, 7)))];
  const snapshot = (snapshots ?? []).find(s => s.target_month.startsWith(month));

  // Toutes les signatures du mois
  const { data: sigs } = snapshot
    ? await supabase
        .from('pairing_signature')
        .select('id, rotation_code, zone, aircraft_code, hc, hcr_crew, tsv_nuit, prime, nb_on_days, first_layover, layovers, rest_before_h, rest_after_h, a81, temps_sej, dead_head, mep_flight, peq')
        .eq('snapshot_id', snapshot.id)
        .order('rotation_code')
    : { data: null };

  // Instances pour toutes les signatures (dates + timestamps)
  const sigIds = (sigs ?? []).map(s => s.id);
  const instances = sigIds.length
    ? await fetchAllPaginated<{
        id: string; signature_id: string;
        depart_date: string; depart_at: string; arrivee_at: string;
      }>((from, to) =>
        supabase
          .from('pairing_instance')
          .select('id, signature_id, depart_date, depart_at, arrivee_at')
          .in('signature_id', sigIds)
          .order('depart_date')
          .range(from, to),
      )
    : [];

  const instMap = new Map<string, { id: string; depart_date: string; depart_at: string; arrivee_at: string }[]>();
  for (const inst of instances) {
    if (!instMap.has(inst.signature_id)) instMap.set(inst.signature_id, []);
    instMap.get(inst.signature_id)!.push(inst);
  }

  const sigsWithInstances = (sigs ?? []).map(s => ({ ...s, instances: instMap.get(s.id) ?? [] }));

  // Deduplicate signatures identical except for activityId
  type SigWithInst = typeof sigsWithInstances[0];
  function dedupKey(s: SigWithInst): string {
    return [
      s.rotation_code,
      Number(s.hc).toFixed(4),
      Number(s.hcr_crew).toFixed(4),
      Number(s.tsv_nuit ?? 0).toFixed(4),
      Number(s.rest_before_h ?? 0).toFixed(2),
      Number(s.rest_after_h ?? 0).toFixed(2),
      Number(s.prime ?? 0).toFixed(2),
      s.nb_on_days,
      s.aircraft_code,
    ].join('|');
  }
  const dedupMap = new Map<string, SigWithInst>();
  for (const s of sigsWithInstances) {
    const key = dedupKey(s);
    if (!dedupMap.has(key)) {
      dedupMap.set(key, { ...s, instances: [...s.instances] });
    } else {
      dedupMap.get(key)!.instances.push(...s.instances);
    }
  }
  for (const s of dedupMap.values()) {
    const seen = new Set<string>();
    s.instances = s.instances
      .filter(i => { if (seen.has(i.depart_at)) return false; seen.add(i.depart_at); return true; })
      .sort((a, b) => a.depart_at.localeCompare(b.depart_at));
  }
  const dedupedSigs = Array.from(dedupMap.values()).filter(s => s.instances.length > 0);

  return (
    <div className="flex flex-col h-screen bg-zinc-50 dark:bg-zinc-950 overflow-hidden">
      <NavBar />
      <div className="flex-1 overflow-y-auto">
        <ComparatifClient
          signatures={dedupedSigs}
          months={months}
          currentMonth={month}
          article81Data={article81Data}
          valeurJour={valeurJour}
        />
      </div>
    </div>
  );
}
