import { createClient } from '@/lib/supabase/server';
import { fetchAllPaginated } from '@/lib/supabase/paginate';
import { redirect } from 'next/navigation';
import { NavBar } from '@/app/components/nav';
import { ComparatifClient } from './comparatif-client';
import { loadAnnexeRowForMonth, loadAllAnnexeRows } from '@/app/actions/annexe';
import { loadAllProfileVersions } from '@/app/actions/profile-version';
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

  // Article 81 : matrice annexe + versions complètes (profil + annexe) pour
  // permettre au client de dériver PVEI/KSP et Valeur Jour du profil
  // utilisateur quand il navigue entre mois.
  const [a81RowData, profileVersions, annexeRows] = await Promise.all([
    loadAnnexeRowForMonth('article_81', month),
    loadAllProfileVersions(user.id),
    loadAllAnnexeRows(),
  ]);
  const article81Data: Article81Data | null = (a81RowData as Article81Data | null) ?? null;

  // Snapshots disponibles (exclu fictifs : projection seulement accessible via
  // calendrier + A81)
  const { data: snapshots } = await supabase
    .from('scrape_snapshot')
    .select('target_month, id')
    .eq('status', 'success')
    .eq('is_fictive', false)
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

  // Instances pour toutes les signatures (dates + timestamps + activity dates pour debug)
  const sigIds = (sigs ?? []).map(s => s.id);
  const instances = sigIds.length
    ? await fetchAllPaginated<{
        id: string; signature_id: string;
        depart_date: string; depart_at: string; arrivee_at: string;
        rest_before_h: number | null; rest_after_h: number | null;
        scheduled_begin_activity_at: string | null; scheduled_end_activity_at: string | null;
      }>((from, to) =>
        supabase
          .from('pairing_instance')
          .select('id, signature_id, depart_date, depart_at, arrivee_at, rest_before_h, rest_after_h, scheduled_begin_activity_at, scheduled_end_activity_at')
          .in('signature_id', sigIds)
          .order('depart_date')
          .range(from, to),
      )
    : [];

  const instMap = new Map<string, typeof instances>();
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
          profileVersions={profileVersions}
          annexeRows={annexeRows}
        />
      </div>
    </div>
  );
}
