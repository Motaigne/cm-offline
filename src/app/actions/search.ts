'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export type RotationInstance = {
  id: string;
  activity_id: string;
  depart_date: string;   // "YYYY-MM-DD"
  depart_at: string;     // ISO timestamptz (block-off)
  arrivee_at: string;    // ISO timestamptz (block-on)
};

export type RotationSignature = {
  id: string;
  rotation_code: string;
  nb_on_days: number;
  aircraft_code: string;
  zone: string | null;
  hc: number;
  hcr_crew: number;
  hdv: number;
  a81: boolean | null;
  heure_debut: string;   // "HH:MM:00"
  heure_fin: string;     // "HH:MM:00"
  temps_sej: number;
  legs_number: number;
  prime: number;
  rest_before_h: number;
  rest_after_h: number;
  tsv_nuit: number;
  dead_head: boolean;
  mep_flight: string | null;
  peq: number | null;
  first_layover: string | null;
  layovers: number;
  instances: RotationInstance[];
};

export async function getAvailableMonths(): Promise<string[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data } = await supabase
    .from('scrape_snapshot')
    .select('target_month')
    .eq('status', 'success')
    .order('target_month', { ascending: false });

  if (!data) return [];
  return [...new Set(data.map(d => (d.target_month as string).slice(0, 7)))];
}

export async function getRotationsForMonth(month: string): Promise<RotationSignature[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: snap } = await supabase
    .from('scrape_snapshot')
    .select('id')
    .eq('target_month', `${month}-01`)
    .eq('status', 'success')
    .order('started_at', { ascending: false })
    .limit(1)
    .single();

  if (!snap) return [];

  const { data: sigs } = await supabase
    .from('pairing_signature')
    .select('id, rotation_code, nb_on_days, aircraft_code, zone, hc, hcr_crew, hdv, a81, heure_debut, heure_fin, temps_sej, legs_number, prime, rest_before_h, rest_after_h, tsv_nuit, dead_head, mep_flight, peq, first_layover, layovers')
    .eq('snapshot_id', snap.id);

  if (!sigs?.length) return [];

  const { data: instances } = await supabase
    .from('pairing_instance')
    .select('id, activity_id, signature_id, depart_date, depart_at, arrivee_at')
    .in('signature_id', sigs.map(s => s.id))
    .order('depart_date');

  const sigMap = new Map<string, RotationSignature>();
  for (const s of sigs) {
    sigMap.set(s.id, {
      ...s,
      rotation_code:  s.rotation_code ?? '',
      hc:             Number(s.hc),
      hcr_crew:       Number(s.hcr_crew),
      hdv:            Number(s.hdv),
      temps_sej:      Number(s.temps_sej ?? 0),
      legs_number:    Number(s.legs_number),
      prime:          Number(s.prime ?? 0),
      rest_before_h:  Number(s.rest_before_h ?? 0),
      rest_after_h:   Number(s.rest_after_h ?? 0),
      tsv_nuit:       Number(s.tsv_nuit ?? 0),
      dead_head:      Boolean(s.dead_head),
      mep_flight:     s.mep_flight ?? null,
      peq:            s.peq != null ? Number(s.peq) : null,
      first_layover:  s.first_layover ?? null,
      layovers:       Number(s.layovers ?? 0),
      instances: [],
    });
  }
  for (const inst of instances ?? []) {
    sigMap.get(inst.signature_id)?.instances.push({
      id:          inst.id,
      activity_id: inst.activity_id,
      depart_date: inst.depart_date,
      depart_at:   inst.depart_at,
      arrivee_at:  inst.arrivee_at,
    });
  }

  // Deduplicate signatures that are identical except for activityId
  function dedupKey(s: RotationSignature): string {
    return [
      s.rotation_code,
      s.hc.toFixed(4),
      s.hcr_crew.toFixed(4),
      (s.tsv_nuit ?? 0).toFixed(4),
      (s.rest_before_h ?? 0).toFixed(2),
      (s.rest_after_h ?? 0).toFixed(2),
      s.prime.toFixed(2),
      s.nb_on_days,
      s.aircraft_code,
    ].join('|');
  }

  const deduped = new Map<string, RotationSignature>();
  for (const sig of sigMap.values()) {
    if (sig.instances.length === 0) continue;
    const key = dedupKey(sig);
    if (!deduped.has(key)) {
      deduped.set(key, { ...sig, instances: [...sig.instances] });
    } else {
      deduped.get(key)!.instances.push(...sig.instances);
    }
  }

  // Deduplicate instances by depart_at within each merged signature
  for (const sig of deduped.values()) {
    const seen = new Set<string>();
    sig.instances = sig.instances
      .filter(i => { if (seen.has(i.depart_at)) return false; seen.add(i.depart_at); return true; })
      .sort((a, b) => a.depart_at.localeCompare(b.depart_at));
  }

  return Array.from(deduped.values()).sort((a, b) => b.hc - a.hc);
}
