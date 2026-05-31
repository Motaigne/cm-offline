'use server';

import { createClient } from '@/lib/supabase/server';
import { fetchAllPaginated } from '@/lib/supabase/paginate';
import { redirect } from 'next/navigation';
import { computeIRandMF, type IrMfResult } from '@/lib/ep4/ir';
import type { IrMfRate } from '@/lib/ir-rates';
import type { PairingDetail } from '@/lib/scraper/types';
import { getPlanPrestation } from '@/lib/plan-prestation';
import { loadAnnexeRowForMonth } from '@/app/actions/annexe';
import { computeSejourOffsetsFromDetail, type SejourOffsets } from '@/lib/article81';

export type RotationInstance = {
  id: string;
  activity_id: string;
  depart_date: string;   // "YYYY-MM-DD"
  depart_at: string;     // ISO timestamptz (block-off / scheduledBeginBlockDate)
  arrivee_at: string;    // ISO timestamptz (block-on  / scheduledEndBlockDate)
  /** Repos avant la rotation (h), spécifique à cette instance. */
  rest_before_h: number | null;
  /** Repos après la rotation (h), spécifique à cette instance. */
  rest_after_h: number | null;
  /** scheduledBeginActivityDate — début d'activité (briefing). Null si pas backfilled. */
  scheduled_begin_activity_at: string | null;
  /** scheduledEndActivityDate — fin d'activité (closeout). Null si pas backfilled. */
  scheduled_end_activity_at: string | null;
  /** Début / fin séjour A81 calculés PAR INSTANCE (depart_at + offsets de la
   *  signature). Null si raw_detail absent ou flightDuty < 2. Doivent être
   *  utilisés à la place de signature.debut_sejour_at, qui est l'absolu d'UNE
   *  seule instance capturée (= faux pour toutes les autres). */
  debut_sejour_at: string | null;
  fin_sejour_at:   string | null;
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
  /** Pré-calculés au scrape (migration 0031) — utilisés par la page A81 pour le
   *  compute offline. Null si raw_detail manquait ou flightDuty < 2. */
  debut_sejour_at: string | null;
  fin_sejour_at:   string | null;
  escale_debut:    string | null;
  escale_fin:      string | null;
  instances: RotationInstance[];
  /** IR + MF par rotation (entiers de comptage). Pré-calculé serveur depuis
   *  raw_detail pour permettre l'agrégation offline côté client. */
  ir: number;
  mf: number;
  /** IR + MF convertis en € via la table annexe ir_mf_rates. */
  ir_eur: number;
  mf_eur: number;
  /** Escales pour lesquelles aucun taux n'a été trouvé. */
  missing_rate_escales: string[];
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

export type RotationLoadMode = 'full' | 'planning_only';

export async function getRotationsForMonth(
  month: string,
  mode: RotationLoadMode = 'full',
): Promise<RotationSignature[]> {
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

  // Mode planning_only : ne télécharge que les signatures référencées par
  // au moins un planning_item kind=flight du user pour ce mois (drafts
  // A/B/C). Utilisé pour les mois antérieurs au mois courant en sync Lite.
  let sigIdsWhitelist: Set<string> | null = null;
  if (mode === 'planning_only') {
    const { data: drafts } = await supabase
      .from('planning_draft')
      .select('id')
      .eq('user_id', user.id)
      .eq('target_month', `${month}-01`);
    const draftIds = (drafts ?? []).map(d => d.id);
    if (draftIds.length === 0) return [];
    const { data: items } = await supabase
      .from('planning_item')
      .select('pairing_instance_id')
      .in('draft_id', draftIds)
      .eq('kind', 'flight')
      .not('pairing_instance_id', 'is', null);
    const plannedInstanceIds = Array.from(new Set(
      (items ?? []).map(i => i.pairing_instance_id).filter(Boolean) as string[],
    ));
    if (plannedInstanceIds.length === 0) return [];
    // Récupère les signature_id correspondants
    const plannedInstances = await fetchAllPaginated<{ signature_id: string }>((from, to) =>
      supabase.from('pairing_instance')
        .select('signature_id')
        .in('id', plannedInstanceIds)
        .range(from, to),
    );
    sigIdsWhitelist = new Set(plannedInstances.map(i => i.signature_id));
    if (sigIdsWhitelist.size === 0) return [];
  }

  let sigsQuery = supabase
    .from('pairing_signature')
    .select('id, rotation_code, nb_on_days, aircraft_code, zone, hc, hcr_crew, hdv, a81, heure_debut, heure_fin, temps_sej, legs_number, prime, rest_before_h, rest_after_h, tsv_nuit, dead_head, mep_flight, peq, first_layover, layovers, debut_sejour_at, fin_sejour_at, escale_debut, escale_fin, raw_detail')
    .eq('snapshot_id', snap.id);
  if (sigIdsWhitelist) {
    sigsQuery = sigsQuery.in('id', Array.from(sigIdsWhitelist));
  }
  const { data: sigs } = await sigsQuery;

  if (!sigs?.length) return [];

  // Pré-calcul IR/MF par signature (besoin pour l'agrégation offline côté client).
  const irRowData = await loadAnnexeRowForMonth('ir_mf_rates', month);
  const irRates = (irRowData ?? []) as unknown as IrMfRate[];
  const irMfBySig = new Map<string, IrMfResult>();
  const sejourOffsetsBySig = new Map<string, SejourOffsets>();
  for (const s of sigs) {
    if (!s.raw_detail) continue;
    const detail = s.raw_detail as unknown as PairingDetail;
    try {
      irMfBySig.set(s.id, computeIRandMF(detail, irRates, getPlanPrestation));
    } catch { /* skip — raw_detail invalide */ }
    const off = computeSejourOffsetsFromDetail(detail);
    if (off) sejourOffsetsBySig.set(s.id, off);
  }

  const sigIds = sigs.map(s => s.id);
  const instances = await fetchAllPaginated<{
    id: string; activity_id: string; signature_id: string;
    depart_date: string; depart_at: string; arrivee_at: string;
    rest_before_h: number | null; rest_after_h: number | null;
    scheduled_begin_activity_at: string | null; scheduled_end_activity_at: string | null;
  }>((from, to) =>
    supabase
      .from('pairing_instance')
      .select('id, activity_id, signature_id, depart_date, depart_at, arrivee_at, rest_before_h, rest_after_h, scheduled_begin_activity_at, scheduled_end_activity_at')
      .in('signature_id', sigIds)
      .order('depart_date')
      .range(from, to),
  );

  const sigMap = new Map<string, RotationSignature>();
  for (const s of sigs) {
    const irMf = irMfBySig.get(s.id);
    // raw_detail n'est pas exposé au client (lourd) — on ne garde que l'IR/MF calculé.
    const { raw_detail: _rd, ...rest } = s;
    void _rd;
    sigMap.set(s.id, {
      ...rest,
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
      ir:                   irMf?.ir     ?? 0,
      mf:                   irMf?.mf     ?? 0,
      ir_eur:               irMf?.ir_eur ?? 0,
      mf_eur:               irMf?.mf_eur ?? 0,
      missing_rate_escales: irMf?.missingRateEscales ?? [],
    });
  }
  for (const inst of instances) {
    const off = sejourOffsetsBySig.get(inst.signature_id);
    const departMs = off ? new Date(inst.depart_at).getTime() : 0;
    sigMap.get(inst.signature_id)?.instances.push({
      id:            inst.id,
      activity_id:   inst.activity_id,
      depart_date:   inst.depart_date,
      depart_at:     inst.depart_at,
      arrivee_at:    inst.arrivee_at,
      rest_before_h: inst.rest_before_h,
      rest_after_h:  inst.rest_after_h,
      scheduled_begin_activity_at: inst.scheduled_begin_activity_at,
      scheduled_end_activity_at:   inst.scheduled_end_activity_at,
      debut_sejour_at: off ? new Date(departMs + off.debutSejourOffsetMs).toISOString() : null,
      fin_sejour_at:   off ? new Date(departMs + off.finSejourOffsetMs).toISOString()   : null,
    });
  }

  // Split par durée + recompute nb_on_days/rotation_code.
  //
  // CrewBidd peut regrouper sous un même activity_number des instances de
  // durées calendaires différentes (vérifié sur JFK : un sig contient à la fois
  // des 4ON, 5ON et 6ON). Le scraper, qui prend instance[0] pour fixer le
  // nb_on_days du sig, n'en voit qu'une — d'où des cartes "4ON JFK" qui mêlent
  // des chips de 4/5/6 jours. On scinde donc ici par durée réelle d'instance
  // (= la seule à laquelle on puisse se fier), une signature d'affichage par
  // groupe. Id synthétique `${sig.id}_${dur}` pour la PK Dexie après cache.
  function instanceDuration(depart_at: string, arrivee_at: string): number {
    const beginMs = new Date(depart_at).getTime();
    const endMs   = new Date(arrivee_at).getTime();
    if (!Number.isFinite(beginMs) || !Number.isFinite(endMs) || endMs < beginMs) return 0;
    const begin = new Date(beginMs);
    const end   = new Date(endMs);
    const beginDay = Date.UTC(begin.getUTCFullYear(), begin.getUTCMonth(), begin.getUTCDate());
    const endDay   = Date.UTC(end.getUTCFullYear(),   end.getUTCMonth(),   end.getUTCDate());
    return Math.round((endDay - beginDay) / 86_400_000) + 1;
  }

  const splitSigs: RotationSignature[] = [];
  for (const sig of sigMap.values()) {
    if (sig.instances.length === 0) continue;
    const byDur = new Map<number, RotationInstance[]>();
    for (const inst of sig.instances) {
      const dur = instanceDuration(inst.depart_at, inst.arrivee_at);
      if (dur <= 0) continue;
      let arr = byDur.get(dur);
      if (!arr) { arr = []; byDur.set(dur, arr); }
      arr.push(inst);
    }
    if (byDur.size === 0) continue;
    for (const [dur, insts] of byDur) {
      // Regex insensible à la casse : rattrape d'éventuels rotation_code
      // historiques en minuscules ("4on JFK") qu'on réémet en majuscules.
      const m = sig.rotation_code.match(/^\d+ON\s+(.*)$/i);
      const newRot = m ? `${dur}ON ${m[1]}` : sig.rotation_code;
      splitSigs.push({
        ...sig,
        id:            byDur.size === 1 ? sig.id : `${sig.id}_${dur}`,
        rotation_code: newRot,
        nb_on_days:    dur,
        instances:     insts,
      });
    }
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
  for (const sig of splitSigs) {
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
