'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type { Database } from '@/types/supabase';

type SignatureRow = Database['public']['Tables']['pairing_signature']['Row'];
type InstanceRow  = Database['public']['Tables']['pairing_instance']['Row'];

async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: profile } = await supabase
    .from('user_profile').select('is_admin').eq('user_id', user.id).single();
  if (!profile?.is_admin) throw new Error('Forbidden — admin only');
  return { supabase, user };
}

function toMonthDate(month: string): string {
  return /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : month;
}

function shiftMonthStr(month: string, n: number): string {
  const [y, mo] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthRange(startMonth: string, endMonth: string): string[] {
  const out: string[] = [];
  let cur = startMonth;
  while (cur <= endMonth) {
    out.push(cur);
    cur = shiftMonthStr(cur, 1);
  }
  return out;
}

function monthDiff(from: string, to: string): number {
  const [yf, mf] = from.split('-').map(Number);
  const [yt, mt] = to.split('-').map(Number);
  return (yt - yf) * 12 + (mt - mf);
}

/** Décale 'YYYY-MM-DD' de n mois en clampant le jour au dernier jour du mois cible
 *  (évite Aug 31 → Sep 31 = Oct 1 via le rollover JS). */
function shiftDateByMonths(dateStr: string, n: number): string {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const targetY = y + Math.floor((mo - 1 + n) / 12);
  const targetM = ((mo - 1 + n) % 12 + 12) % 12;            // 0..11
  const lastDay = new Date(Date.UTC(targetY, targetM + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${targetY}-${String(targetM + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Décale un timestamp ISO de n mois en clampant le jour. */
function shiftIsoByMonths(iso: string, n: number): string {
  const dt = new Date(iso);
  const targetY = dt.getUTCFullYear();
  const targetM = dt.getUTCMonth() + n;
  // Construit la date cible en clampant le jour
  const lastDay = new Date(Date.UTC(targetY, targetM + 1, 0)).getUTCDate();
  const day = Math.min(dt.getUTCDate(), lastDay);
  return new Date(Date.UTC(
    targetY, targetM, day,
    dt.getUTCHours(), dt.getUTCMinutes(), dt.getUTCSeconds(), dt.getUTCMilliseconds(),
  )).toISOString();
}

export interface FictiveGenResult {
  created: number;
  months: string[];
  yearRoundCount: number;
  sourceMonths: string[];
}

/**
 * Matérialise des snapshots fictifs pour chaque mois de [startMonth, endMonth].
 * Source : intersection des `rotation_code` présents dans les 3 derniers
 * snapshots réels (status=success, is_fictive=false). Signature canonique +
 * instances clonées depuis le mois le plus récent, dates shiftées.
 *
 * Idempotent : si un fictif existe déjà sur un mois cible, il est remplacé
 * (avec cleanup des planning_item qui le référençaient).
 *
 * Refuse de générer sur un mois qui a déjà un snapshot RÉEL.
 */
export async function generateFictiveSnapshots(args: {
  startMonth: string;
  endMonth: string;
}): Promise<FictiveGenResult | { error: string }> {
  const { supabase } = await requireAdmin();

  if (!/^\d{4}-\d{2}$/.test(args.startMonth) || !/^\d{4}-\d{2}$/.test(args.endMonth)) {
    return { error: 'Format de mois invalide (attendu YYYY-MM)' };
  }
  if (args.startMonth > args.endMonth) {
    return { error: 'Mois de début > mois de fin' };
  }
  const targets = monthRange(args.startMonth, args.endMonth);
  if (targets.length > 13) {
    return { error: 'Plage trop large (max 13 mois)' };
  }

  // 1) Les 3 derniers snapshots RÉELS (success + !is_fictive)
  const { data: realSnaps, error: e1 } = await supabase
    .from('scrape_snapshot')
    .select('id, target_month')
    .eq('status', 'success')
    .eq('is_fictive', false)
    .order('target_month', { ascending: false })
    .limit(3);
  if (e1) return { error: `loadRealSnapshots: ${e1.message}` };
  if (!realSnaps || realSnaps.length < 3) {
    return { error: 'Il faut au moins 3 snapshots réels pour générer une projection' };
  }
  const refSnapIds = realSnaps.map(s => s.id);
  const canonicalSnap = realSnaps[0]; // le plus récent
  const canonicalMonth = canonicalSnap.target_month.slice(0, 7);

  // Refuse si un target ≤ canonicalMonth ou collision avec un mois réel
  const realMonths = new Set(realSnaps.map(s => s.target_month.slice(0, 7)));
  for (const t of targets) {
    if (realMonths.has(t)) {
      return { error: `Un snapshot réel existe déjà pour ${t}` };
    }
    if (t <= canonicalMonth) {
      return { error: `Le mois ${t} ne peut pas être projeté (≤ dernier mois réel ${canonicalMonth})` };
    }
  }

  // 2) Identifier les rotation_code présents dans les 3 mois (intersection)
  const { data: refSigs, error: e2 } = await supabase
    .from('pairing_signature')
    .select('id, snapshot_id, rotation_code')
    .in('snapshot_id', refSnapIds)
    .not('rotation_code', 'is', null);
  if (e2) return { error: `loadRefSigs: ${e2.message}` };

  const codeBySnap = new Map<string, Set<string>>();
  for (const s of refSigs ?? []) {
    if (!s.rotation_code) continue;
    if (!codeBySnap.has(s.rotation_code)) codeBySnap.set(s.rotation_code, new Set());
    codeBySnap.get(s.rotation_code)!.add(s.snapshot_id);
  }
  const yearRoundCodes = Array.from(codeBySnap.entries())
    .filter(([, snaps]) => refSnapIds.every(id => snaps.has(id)))
    .map(([code]) => code);

  if (yearRoundCodes.length === 0) {
    return { error: 'Aucune rotation présente dans les 3 derniers mois' };
  }

  // 3) Signatures canoniques (= sigs du mois le plus récent ∈ yearRoundCodes)
  const { data: canonSigs, error: e3 } = await supabase
    .from('pairing_signature')
    .select('*')
    .eq('snapshot_id', canonicalSnap.id)
    .in('rotation_code', yearRoundCodes);
  if (e3) return { error: `loadCanonSigs: ${e3.message}` };
  if (!canonSigs?.length) return { error: 'Aucune signature canonique trouvée' };

  // 4) Instances canoniques (pour préserver la fréquence/jour-de-semaine)
  const canonSigIds = canonSigs.map(s => s.id);
  const { data: canonInstances, error: e4 } = await supabase
    .from('pairing_instance')
    .select('*')
    .in('signature_id', canonSigIds);
  if (e4) return { error: `loadCanonInstances: ${e4.message}` };

  // 5) Pour chaque mois cible : cleanup fictif existant + create snap + clone
  const monthsCreated: string[] = [];
  for (const targetMonth of targets) {
    // Idempotence : nuke tout fictif existant sur ce mois (RPC SECURITY DEFINER)
    const { error: eCleanup } = await supabase.rpc(
      'cleanup_fictive_snapshots_for_month',
      { p_target_month: toMonthDate(targetMonth) },
    );
    if (eCleanup) return { error: `cleanup ${targetMonth}: ${eCleanup.message}` };

    // Création du snapshot fictif
    const { data: newSnap, error: e5 } = await supabase
      .from('scrape_snapshot')
      .insert({
        target_month: toMonthDate(targetMonth),
        status: 'success',
        is_fictive: true,
        unique_signatures: canonSigs.length,
        flights_found: canonInstances?.length ?? 0,
        finished_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (e5 || !newSnap) return { error: `createSnap ${targetMonth}: ${e5?.message}` };

    // Clone sigs : nouveaux UUIDs + relink snapshot_id
    const sigIdMap = new Map<string, string>();
    const sigsToInsert: SignatureRow[] = canonSigs.map(s => {
      const newId = crypto.randomUUID();
      sigIdMap.set(s.id, newId);
      return { ...s, id: newId, snapshot_id: newSnap.id, created_at: new Date().toISOString() };
    });
    const { error: e6 } = await supabase.from('pairing_signature').insert(sigsToInsert);
    if (e6) return { error: `cloneSigs ${targetMonth}: ${e6.message}` };

    // Clone instances : shift de N mois, nouveau UUID, relink signature_id
    const monthsShift = monthDiff(canonicalMonth, targetMonth);
    const instancesToInsert: InstanceRow[] = (canonInstances ?? [])
      .map((inst): InstanceRow | null => {
        const newSigId = sigIdMap.get(inst.signature_id);
        if (!newSigId) return null;
        return {
          ...inst,
          id: crypto.randomUUID(),
          signature_id: newSigId,
          // Préfixe activity_id pour éviter toute collision même si la contrainte
          // unique est (signature_id, activity_id) — on s'évite l'incident.
          activity_id: `fic-${newSnap.id.slice(0, 8)}-${inst.activity_id}`,
          depart_date: shiftDateByMonths(inst.depart_date, monthsShift),
          depart_at:   shiftIsoByMonths(inst.depart_at,   monthsShift),
          arrivee_at:  shiftIsoByMonths(inst.arrivee_at,  monthsShift),
          scheduled_begin_activity_at: inst.scheduled_begin_activity_at
            ? shiftIsoByMonths(inst.scheduled_begin_activity_at, monthsShift) : null,
          scheduled_end_activity_at: inst.scheduled_end_activity_at
            ? shiftIsoByMonths(inst.scheduled_end_activity_at, monthsShift) : null,
        };
      })
      .filter((x): x is InstanceRow => x !== null);

    if (instancesToInsert.length) {
      // Insert par chunks pour rester sous les limites payload Supabase
      const CHUNK = 500;
      for (let i = 0; i < instancesToInsert.length; i += CHUNK) {
        const chunk = instancesToInsert.slice(i, i + CHUNK);
        const { error: e7 } = await supabase.from('pairing_instance').insert(chunk);
        if (e7) return { error: `cloneInstances ${targetMonth} chunk ${i}: ${e7.message}` };
      }
    }

    monthsCreated.push(targetMonth);
  }

  revalidatePath('/admin/outils');
  return {
    created: monthsCreated.length,
    months: monthsCreated,
    yearRoundCount: yearRoundCodes.length,
    sourceMonths: realSnaps.map(s => s.target_month.slice(0, 7)),
  };
}

/** Supprime tous les snapshots fictifs pour un mois (admin only, manuel). */
export async function deleteFictiveSnapshotsForMonth(month: string): Promise<{ deleted: number } | { error: string }> {
  const { supabase } = await requireAdmin();
  if (!/^\d{4}-\d{2}$/.test(month)) return { error: 'Format de mois invalide' };

  const { data, error } = await supabase.rpc(
    'cleanup_fictive_snapshots_for_month',
    { p_target_month: toMonthDate(month) },
  );
  if (error) return { error: error.message };
  revalidatePath('/admin/outils');
  return { deleted: Number(data ?? 0) };
}

/** Liste les snapshots fictifs existants (pour l'UI admin). */
export async function listFictiveSnapshots(): Promise<{ target_month: string; unique_signatures: number | null; flights_found: number | null; finished_at: string | null }[]> {
  const { supabase } = await requireAdmin();
  const { data } = await supabase
    .from('scrape_snapshot')
    .select('target_month, unique_signatures, flights_found, finished_at')
    .eq('is_fictive', true)
    .order('target_month', { ascending: true });
  return data ?? [];
}
