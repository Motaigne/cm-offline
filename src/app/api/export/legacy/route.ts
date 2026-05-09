/**
 * Export legacy CSV (point L de la spec).
 *
 * Reproduit le contenu attendu par le GoogleSheet `AF_Paie_Claude` :
 *   - vols de la DB de M-1 dont la date d'arrivée est en M (rotations à cheval)
 *   - tous les vols de la DB de M
 *
 * Deux formats :
 *   - slim  : 12 colonnes, équivalent de `10_rotEur_<MMAAAA>.csv` (feuille `$MMAAAA$`)
 *   - full  : 47 colonnes, équivalent de `9_cleanEp4_<MMAAAA>.csv` (feuille `MMAAAA`)
 *
 * NOTE — le format `full` n'est PAS encore complet : les colonnes dérivées (TME, CMT,
 * HCV, HCT, HCA, H1, H2HC, HV100r, HCVr, H1r, H2HCr, HCVmoisM, ONm, IR, rtHDV) viennent
 * du pipeline Python `8_ep4_V7.py` qui n'est pas encore porté en TS. Ces colonnes sont
 * laissées vides en attendant. Les colonnes brutes (Code, ROT, vols, dates, signature)
 * sont remplies.
 *
 * Format français : virgule décimale, valeurs décimales encadrées de guillemets.
 */
import { createClient } from '@/lib/supabase/server';
import { fetchAllPaginated } from '@/lib/supabase/paginate';
import type { Database } from '@/types/supabase';

type SignatureRow = Database['public']['Tables']['pairing_signature']['Row'];
type InstanceRow  = Database['public']['Tables']['pairing_instance']['Row'];

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function timeToDecimalHours(t: string | null): number {
  if (!t) return 0;
  const [hh, mm] = t.split(':').map(Number);
  return Math.round((hh + (mm ?? 0) / 60) * 100) / 100;
}

function fmtFr(n: number, dec = 2): string {
  if (!Number.isFinite(n)) return '';
  return n.toFixed(dec).replace('.', ',');
}

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  // Toute valeur contenant , ; " ou newline est entourée de guillemets ;
  // les nombres décimaux français (avec virgule) sont aussi entourés.
  if (/[,;"\n]/.test(s) || /,/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function ddmmyyyy(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

interface ExportRow {
  signature: SignatureRow;
  instance:  InstanceRow;
  /** True si cette instance vient de M-1 (rotation à cheval). */
  spillover: boolean;
}

async function loadSnapshotIdForMonth(supabase: Awaited<ReturnType<typeof createClient>>, month: string): Promise<string | null> {
  const { data } = await supabase
    .from('scrape_snapshot')
    .select('id')
    .eq('target_month', `${month}-01`)
    .eq('status', 'success')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

async function loadRowsForMonth(supabase: Awaited<ReturnType<typeof createClient>>, month: string): Promise<ExportRow[]> {
  const snapId = await loadSnapshotIdForMonth(supabase, month);
  if (!snapId) return [];
  const sigs = await fetchAllPaginated<SignatureRow>((from, to) =>
    supabase.from('pairing_signature').select('*').eq('snapshot_id', snapId).range(from, to),
  );
  if (!sigs.length) return [];
  const sigIds = sigs.map(s => s.id);
  const insts = await fetchAllPaginated<InstanceRow>((from, to) =>
    supabase.from('pairing_instance').select('*').in('signature_id', sigIds).range(from, to),
  );
  const sigById = new Map(sigs.map(s => [s.id, s]));
  return insts.map(inst => ({
    signature: sigById.get(inst.signature_id)!,
    instance:  inst,
    spillover: false,
  })).filter(r => r.signature);
}

/** Retourne uniquement les instances de M-1 dont l'arrivée est en M. */
async function loadSpilloverFromPrev(supabase: Awaited<ReturnType<typeof createClient>>, prevMonth: string, currentMonth: string): Promise<ExportRow[]> {
  const all = await loadRowsForMonth(supabase, prevMonth);
  return all
    .filter(r => r.instance.arrivee_at.slice(0, 7) === currentMonth)
    .map(r => ({ ...r, spillover: true }));
}

// ─── Format slim (12 colonnes, 1 ligne par rotation) ──────────────────────────

const SLIM_HEADERS = [
  'ID Ligne', 'Code', 'Avion', 'DEP/UTC', 'ON', 'H2HC',
  'tempsSej', 'Zone', 'tauxApp', 'PV', 'Prime', 'PV+Prime',
];

interface TauxAppEntry {
  rot_code: string;
  duree_min_h: number;
  duree_max_h: number;
  taux: number;
}

async function loadTauxApp(supabase: Awaited<ReturnType<typeof createClient>>): Promise<TauxAppEntry[]> {
  const { data } = await supabase
    .from('taux_app')
    .select('rot_code, duree_min_h, duree_max_h, taux');
  return data ?? [];
}

function lookupTauxApp(taux: TauxAppEntry[], rotCode: string | null, tempsSej: number | null): number | null {
  if (!rotCode || tempsSej == null) return null;
  const code = rotCode.split(' ').slice(1).join(' ').trim() || rotCode; // strip "9ON " prefix
  const match = taux.find(t =>
    (t.rot_code === code || t.rot_code === rotCode) &&
    tempsSej >= t.duree_min_h && tempsSej <= t.duree_max_h,
  );
  return match?.taux ?? null;
}

function buildSlimCsv(rows: ExportRow[], taux: TauxAppEntry[]): string {
  // 1 ligne par signature (par rotation). On déduplique sur signature.id ; pour les
  // rotations à cheval, on garde l'instance qui décolle dans le mois précédent.
  const bySig = new Map<string, ExportRow>();
  for (const r of rows) {
    const existing = bySig.get(r.signature.id);
    if (!existing) bySig.set(r.signature.id, r);
  }

  const lines: string[] = [SLIM_HEADERS.join(',')];

  // Tri par PV+Prime décroissant comme dans 10_rotEur_v7.py
  const computed = Array.from(bySig.values()).map(r => {
    const sig      = r.signature;
    const tsvNuit  = Number(sig.tsv_nuit ?? 0);
    const hcrCrew  = Number(sig.hcr_crew ?? 0);
    const tempsSej = sig.temps_sej != null ? Number(sig.temps_sej) : null;
    const prime    = Number(sig.prime ?? 0);

    // ⚠️ Approximation : H2HCr du script Python n'est pas encore porté.
    // En attendant on utilise hcr_crew comme valeur la plus proche.
    const h2hcrApprox = hcrCrew;
    const pv       = tsvNuit / 2 + h2hcrApprox;
    const pvPrime  = pv + 2.5 * prime;

    const tauxApp  = lookupTauxApp(taux, sig.rotation_code, tempsSej);

    return {
      idLigne:  r.instance.activity_id,
      code:     sig.rotation_code ?? '',
      avion:    sig.aircraft_code,
      depUtc:   timeToDecimalHours(sig.heure_debut),
      on:       sig.nb_on_days,
      h2hc:     h2hcrApprox, // approximation, voir note ci-dessus
      tempsSej: tempsSej ?? 0,
      zone:     sig.zone ?? '',
      tauxApp:  tauxApp,
      pv,
      prime,
      pvPrime,
    };
  }).sort((a, b) => b.pvPrime - a.pvPrime);

  for (const r of computed) {
    lines.push([
      csvCell(r.idLigne),
      csvCell(r.code),
      csvCell(r.avion),
      csvCell(fmtFr(r.depUtc, 2)),
      csvCell(r.on),
      csvCell(fmtFr(r.h2hc, 2)),
      csvCell(fmtFr(r.tempsSej, 2)),
      csvCell(r.zone),
      csvCell(r.tauxApp != null ? fmtFr(r.tauxApp, 2) : ''),
      csvCell(fmtFr(r.pv, 2)),
      csvCell(fmtFr(r.prime, 2)),
      csvCell(fmtFr(r.pvPrime, 2)),
    ].join(','));
  }

  return lines.join('\n');
}

// ─── Format full (47 colonnes — squelette, colonnes dérivées vides) ──────────

const FULL_HEADERS = [
  'Code', 'ROT', 'N° Vol', 'Avion', 'DEP', 'ARR', 'DEP/UTC', 'ARR/UTC',
  'DebutVol', 'FinVol', 'HDV', 'HC', 'TSV', 'ON', 'ONm', 'TDV Total', 'Service',
  'Tronçon', 'ID Ligne', 'ID Tronçon', 'TDV/troncon', 'BLOCK/BLOCK', 'TA',
  'TSV nuit J', 'TSV nuit J+1', 'TSV nuit', 'TSVnSerM', 'TSVnRotM', 'TME',
  'CMT', 'HCV', 'HCVmoisM', 'HCT', 'HCA', 'H1', 'H2HC', 'rtHDV',
  'HV100r', 'HCVr', 'H1r', 'H2HCr', 'Prime', 'deadHead', 'IR', 'tempsSej', 'Zone', 'tauxApp',
];

function buildFullCsv(rows: ExportRow[], taux: TauxAppEntry[]): string {
  // Pour le format full on reproduit la structure : 1 ligne « tête » par rotation
  // suivie d'une ligne par tronçon, séparées par une ligne vide.
  // ⚠️ Les tronçons individuels exigent les `legs` du raw_detail JSONB et toute la
  // logique 8_ep4_V7.py — non porté pour l'instant. On émet une seule ligne tête
  // par rotation avec les colonnes brutes disponibles, séparées par une ligne vide.
  const lines: string[] = [FULL_HEADERS.join(',')];
  const bySig = new Map<string, ExportRow>();
  for (const r of rows) {
    const existing = bySig.get(r.signature.id);
    if (!existing) bySig.set(r.signature.id, r);
  }

  for (const r of bySig.values()) {
    const sig = r.signature;
    const tempsSej = sig.temps_sej != null ? Number(sig.temps_sej) : null;
    const tauxApp  = lookupTauxApp(taux, sig.rotation_code, tempsSej);

    const head: Record<string, string> = {};
    for (const h of FULL_HEADERS) head[h] = '';
    head['Code']      = sig.rotation_code ?? '';
    head['ROT']       = (sig.rotation_code ?? '').split(' ').slice(1).join(' ');
    head['Avion']     = sig.aircraft_code;
    head['DEP']       = sig.station_code;
    head['DEP/UTC']   = fmtFr(timeToDecimalHours(sig.heure_debut), 2);
    head['ARR/UTC']   = fmtFr(timeToDecimalHours(sig.heure_fin), 2);
    head['DebutVol']  = ddmmyyyy(r.instance.depart_at);
    head['FinVol']    = ddmmyyyy(r.instance.arrivee_at);
    head['HDV']       = fmtFr(Number(sig.hdv ?? 0), 2);
    head['HC']        = fmtFr(Number(sig.hc ?? 0), 2);
    head['ON']        = String(sig.nb_on_days);
    head['TDV Total'] = fmtFr(Number(sig.tdv_total ?? 0), 2);
    head['ID Ligne']  = String(r.instance.activity_id);
    head['TSV nuit']  = fmtFr(Number(sig.tsv_nuit ?? 0), 2);
    head['TSVnRotM']  = fmtFr(Number(sig.tsv_nuit ?? 0), 2);
    head['Prime']     = String(sig.prime ?? 0);
    head['deadHead']  = sig.dead_head ? '1' : '0';
    head['tempsSej']  = tempsSej != null ? fmtFr(tempsSej, 2) : '';
    head['Zone']      = sig.zone ?? '';
    head['tauxApp']   = tauxApp != null ? fmtFr(tauxApp, 2) : '';

    lines.push(FULL_HEADERS.map(h => csvCell(head[h])).join(','));
    lines.push(FULL_HEADERS.map(() => '').join(','));
  }

  return lines.join('\n');
}

export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const url = new URL(req.url);
  const month  = url.searchParams.get('month');
  const format = (url.searchParams.get('format') ?? 'slim') as 'slim' | 'full';

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return new Response('month requis au format YYYY-MM', { status: 400 });
  }
  if (format !== 'slim' && format !== 'full') {
    return new Response('format doit être "slim" ou "full"', { status: 400 });
  }

  const taux = await loadTauxApp(supabase);

  const monthRows  = await loadRowsForMonth(supabase, month);
  const prevMonth  = shiftMonth(month, -1);
  const spillRows  = await loadSpilloverFromPrev(supabase, prevMonth, month);
  const merged     = [...spillRows, ...monthRows];

  const csv = format === 'slim' ? buildSlimCsv(merged, taux) : buildFullCsv(merged, taux);

  // Journal d'activité (point K) : qui télécharge quoi
  if (user.email) {
    await supabase.from('auth_log').insert({
      email:   user.email.toLowerCase(),
      kind:    'db_download',
      user_id: user.id,
      meta:    { month, format, rows: merged.length },
    });
  }

  // Ajout d'un BOM UTF-8 pour la compatibilité Excel/GoogleSheet
  const body = '﻿' + csv;
  const filename = `${format === 'slim' ? '10_rotEur' : '9_cleanEp4'}_${month.replace('-', '')}.csv`;

  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
