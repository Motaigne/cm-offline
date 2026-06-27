// Réconciliation du planning avec le cache rotations (Sync différentiel).
//
// Le Sync télécharge déjà la dernière version des rotations par mois (différentiel
// `getMonthsLastModified` ↔ `month_sync_state` : on ne re-pull qu'un mois dont la
// date serveur > date locale). Mais ça rafraîchit le CACHE rotations, pas la
// `meta` figée des vols posés ni les liens manquants. Cette passe — 100 % locale,
// aucun réseau supplémentaire — repasse sur chaque vol du planning et le réconcilie
// avec le cache (déjà à jour) :
//   1. lien `pairing_instance_id` absent (vol legacy / hors catalogue) → on le
//      rattache à l'instance correspondante (match code + date + nb_on_days) ;
//   2. `meta` qui diffère du cache (backfill / zones / dates corrigés en base) →
//      on l'actualise ;
//   3. rotation introuvable dans le cache → on la signale (non réparable ici).
// Les changements sont appliqués en local (Dexie) ET poussés au serveur via la
// file de sync (relink = delete + add, refresh = update_meta), puis résumés pour
// le popup de fin de Sync.

import { db, loadRotationsFromDB } from './local-db';
import type { CalendarItem } from '@/app/page';
import type { RotationSignature, RotationInstance } from '@/app/actions/search';
import type { Json } from '@/types/supabase';
import { enqueueDelete, enqueueAdd, enqueueMetaUpdate } from './sync-service';

export interface RepairChange {
  kind: 'relinked' | 'updated' | 'orphaned';
  scenario: string;     // A / B / C
  destination: string;  // code rotation
  date: string;         // start_date du vol
}
export interface RepairSummary {
  changes: RepairChange[];
}

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Construit la `meta` canonique d'un vol depuis sa signature + instance.
 *  Strictement aligné sur `search-panel.buildNewItem` (source unique au moment
 *  d'ajouter une rotation au planning). */
function buildMeta(sig: RotationSignature, inst: RotationInstance): Json {
  return {
    destination:   sig.rotation_code,
    zone:          sig.zone,
    hc:            sig.hc,
    hcr_crew:      sig.hcr_crew,
    nb_on_days:    sig.nb_on_days,
    a81:           sig.a81,
    prime:         sig.prime,
    rest_before_h: inst.rest_before_h ?? sig.rest_before_h,
    rest_after_h:  inst.rest_after_h  ?? sig.rest_after_h,
    tsv_nuit:      sig.tsv_nuit,
    temps_sej:     sig.temps_sej,
    depart_at:     inst.depart_at,
    arrivee_at:    inst.arrivee_at,
    scheduled_begin_activity_at: inst.scheduled_begin_activity_at,
    scheduled_end_activity_at:   inst.scheduled_end_activity_at,
  } as unknown as Json;
}

/** Champs de `meta` qui comptent pour le calcul (valeurs de paie + dates).
 *  On ignore le bruit flottant via une tolérance. */
function metaDiffers(cur: Record<string, unknown> | null, next: Record<string, unknown>): boolean {
  if (!cur) return true;
  const numKeys = ['hc', 'hcr_crew', 'tsv_nuit', 'temps_sej', 'prime', 'nb_on_days'] as const;
  for (const k of numKeys) {
    const a = num(cur[k]), b = num(next[k]);
    if (a === null && b === null) continue;
    if (a === null || b === null) return true;
    if (Math.abs(a - b) > 0.01) return true;
  }
  const strKeys = ['zone', 'depart_at', 'arrivee_at', 'destination'] as const;
  for (const k of strKeys) {
    if (str(cur[k]) !== str(next[k])) return true;
  }
  return false;
}

type StoredItem = CalendarItem & { draft_id: string };

/** Réconcilie le planning de chaque mois donné avec le cache rotations local. */
export async function reconcilePlanning(months: string[]): Promise<RepairSummary> {
  const changes: RepairChange[] = [];

  for (const month of months) {
    const drafts = await db.drafts.where('target_month').equals(month).toArray();
    if (drafts.length === 0) continue;
    const draftName = new Map(drafts.map(d => [d.id, d.name] as const));

    const sigs = await loadRotationsFromDB(month);
    if (sigs.length === 0) continue;

    // Index : instance → (sig, inst) ; et (code|nb_on_days) → sig pour le legacy.
    const byInst = new Map<string, { sig: RotationSignature; inst: RotationInstance }>();
    const byCodeOn = new Map<string, RotationSignature>();
    for (const sig of sigs) {
      byCodeOn.set(`${sig.rotation_code}|${sig.nb_on_days}`, sig);
      for (const inst of sig.instances) byInst.set(inst.id, { sig, inst });
    }

    const items = await db.items.where('draft_id').anyOf(drafts.map(d => d.id)).toArray() as StoredItem[];
    for (const it of items) {
      if (it.kind !== 'flight') continue;
      const m = (it.meta && typeof it.meta === 'object' && !Array.isArray(it.meta))
        ? it.meta as Record<string, unknown> : null;
      const scenario = draftName.get(it.draft_id) ?? '?';
      const dest = str(m?.destination) ?? '?';

      if (it.pairing_instance_id) {
        // Vol lié : on vérifie que l'instance est dans le cache et que la meta colle.
        const hit = byInst.get(it.pairing_instance_id);
        if (!hit) { changes.push({ kind: 'orphaned', scenario, destination: dest, date: it.start_date }); continue; }
        const nextMeta = buildMeta(hit.sig, hit.inst) as unknown as Record<string, unknown>;
        if (metaDiffers(m, nextMeta)) {
          await db.items.update(it.id, { meta: nextMeta as unknown as Json });
          await enqueueMetaUpdate(it.id, nextMeta as unknown as Json);
          changes.push({ kind: 'updated', scenario, destination: dest, date: it.start_date });
        }
        continue;
      }

      // Vol legacy (pas de lien) : on tente de retrouver l'instance par code +
      // nb_on_days + date de départ, puis on rattache (delete + add côté serveur
      // pour garder des ids cohérents local/serveur).
      const code = str(m?.destination);
      const nbOn = num(m?.nb_on_days);
      if (!code || nbOn === null) { changes.push({ kind: 'orphaned', scenario, destination: dest, date: it.start_date }); continue; }
      const sig = byCodeOn.get(`${code}|${nbOn}`);
      const inst = sig?.instances.find(i => i.depart_date === it.start_date)
                ?? sig?.instances.find(i => (str(m?.depart_at) ?? '').slice(0, 10) === i.depart_at.slice(0, 10));
      if (!sig || !inst) { changes.push({ kind: 'orphaned', scenario, destination: dest, date: it.start_date }); continue; }

      const newItem: CalendarItem = {
        id: crypto.randomUUID(),
        kind: 'flight',
        start_date: it.start_date,
        end_date: it.end_date,
        bid_category: it.bid_category,
        pairing_instance_id: inst.id,
        meta: buildMeta(sig, inst),
      };
      await db.items.delete(it.id);
      await db.items.add({ ...newItem, draft_id: it.draft_id } as StoredItem);
      await enqueueDelete(it.id);
      await enqueueAdd(newItem, it.draft_id);
      changes.push({ kind: 'relinked', scenario, destination: dest, date: it.start_date });
    }
  }

  return { changes };
}
