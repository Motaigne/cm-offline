/**
 * Imports June 2026 rotation data from CSV files into Supabase.
 * Usage: npx tsx --env-file=.env.local scripts/import-rotations.ts
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Missing env vars');

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const DATA_DIR = path.join('D:', 'Documents', 'Code', 'Python', 'Claude');

// ─── CSV parser ───────────────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;

  while (i < line.length) {
    if (line[i] === '"') {
      // Quoted field: consume until closing (unescaped) quote
      let field = '';
      i++; // skip opening quote
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { field += '"'; i += 2; }
        else if (line[i] === '"')                    { i++; break; }   // closing quote
        else                                          { field += line[i++]; }
      }
      fields.push(field);
      if (i < line.length && line[i] === ',') i++; // skip field separator
    } else {
      // Unquoted field: consume until comma or end
      let field = '';
      while (i < line.length && line[i] !== ',') field += line[i++];
      fields.push(field);
      if (i < line.length && line[i] === ',') i++; // skip field separator
    }
  }

  // Trailing comma → push one final empty field
  if (line.endsWith(',')) fields.push('');
  return fields;
}

function readCSV(filename: string) {
  const raw = fs.readFileSync(path.join(DATA_DIR, filename), 'utf8').replace(/^﻿/, '');
  const lines = raw.split('\n').map(l => l.trimEnd()).filter(Boolean);
  const headers = parseCSVLine(lines[0]);
  const rows    = lines.slice(1).map(parseCSVLine);
  const idx     = Object.fromEntries(headers.map((h, i) => [h, i]));
  return { headers, rows, idx };
}

// ─── value helpers ────────────────────────────────────────────────────────────

function fr(val: string | undefined): number {
  if (!val) return 0;
  return parseFloat(val.replace(',', '.')) || 0;
}

/** "dd/MM/yyyy" → "yyyy-MM-dd" */
function parseDate(val: string): string {
  if (!val) return '2026-06-01';
  const parts = val.split('/');
  if (parts.length !== 3) {
    console.warn(`parseDate: unexpected value "${val}"`);
    return '2026-06-01';
  }
  const [d, m, y] = parts;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** Decimal UTC hours (e.g. "17,5") → "HH:MM:00" */
function toTime(val: string): string {
  const h = fr(val);
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
}

/** dateStr "dd/MM/yyyy" + utcHours "17,5" → ISO UTC string */
function toTimestamp(dateStr: string, utcHours: string): string {
  return `${parseDate(dateStr)}T${toTime(utcHours)}+00:00`;
}

// ─── batch helper ─────────────────────────────────────────────────────────────

async function insertBatch<T extends object>(table: string, rows: T[], size = 200) {
  for (let i = 0; i < rows.length; i += size) {
    const batch = rows.slice(i, i + size);
    const { error } = await supabase.from(table).insert(batch);
    if (error) throw new Error(`Insert ${table} batch ${i}: ${error.message}`);
    process.stdout.write(`  ${table}: ${Math.min(i + size, rows.length)}/${rows.length}\r`);
  }
  console.log(`  ${table}: ${rows.length} rows inserted.`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── 1. Parse source files ──────────────────────────────────────────────────
  console.log('Parsing CSV files…');

  const clean = readCSV('9_cleanEp4_062026.csv');
  const b81   = readCSV('8b_ep4_81_062026.csv');

  // Column indices (by name)
  const C = clean.idx;
  const B = b81.idx;

  // ── 2. Build ID Ligne → HCr(CM) lookup from 8b ───────────────────────────
  const hcrLookup = new Map<string, number>();
  for (const row of b81.rows) {
    const idLigne = row[B['ID Ligne']]?.trim();
    const hcr     = row[B['HCr(CM)']]?.trim();
    if (idLigne && hcr) {
      if (!hcrLookup.has(idLigne)) hcrLookup.set(idLigne, fr(hcr));
    }
  }
  console.log(`HCr lookup: ${hcrLookup.size} entries`);

  // ── 3. Group clean rows by rotation ───────────────────────────────────────
  type RotGroup = { code: string; rows: string[][] };
  const rotations: RotGroup[] = [];
  let current: RotGroup | null = null;

  for (const row of clean.rows) {
    const code = row[C['Code']]?.trim();
    if (code) {
      if (current) rotations.push(current);
      current = { code, rows: [row] };
    } else if (current && row.some(c => c.trim())) {
      current.rows.push(row);
    }
  }
  if (current) rotations.push(current);

  console.log(`Rotations parsed: ${rotations.length}`);

  // ── 4. Create scrape_snapshot ──────────────────────────────────────────────
  const { data: snap, error: snapErr } = await supabase
    .from('scrape_snapshot')
    .insert({
      target_month:       '2026-06-01',
      status:             'success',
      flights_found:      rotations.length,
      unique_signatures:  0,
    })
    .select('id')
    .single();

  if (snapErr || !snap) throw new Error('Snapshot: ' + snapErr?.message);
  const snapshotId = snap.id;
  console.log(`Snapshot: ${snapshotId}`);

  // ── 5. Build unique signatures ─────────────────────────────────────────────
  // Key: "rotCode|onDays" — use first occurrence's metrics
  type SigInsert = Record<string, unknown>;
  const sigInserts: SigInsert[] = [];
  const sigKeyToIdx = new Map<string, number>();

  for (const rot of rotations) {
    const first = rot.rows[0];
    const last  = rot.rows[rot.rows.length - 1];

    const rotCode = first[C['ROT']]?.trim() ?? '';
    const onDays  = parseInt(first[C['ON']] ?? '0', 10) || 0;
    const sigKey  = `${rotCode}|${onDays}`;

    if (sigKeyToIdx.has(sigKey)) continue;
    sigKeyToIdx.set(sigKey, sigInserts.length);

    const hc      = fr(first[C['HC']]);
    const idLigne = first[C['ID Ligne']]?.trim() ?? '';
    const hcr     = hcrLookup.get(idLigne) ?? hc;

    sigInserts.push({
      snapshot_id:          snapshotId,
      rotation_code:        rotCode,
      station_code:         first[C['DEP']] ?? 'CDG',
      stopovers:            rotCode,
      legs_number:          rot.rows.length,
      layovers:             Math.max(0, onDays - 1),
      first_layover:        first[C['ARR']] ?? null,
      first_flight_number:  first[C['N° Vol']] ?? null,
      aircraft_code:        first[C['Avion']] ?? '',
      heure_debut:          toTime(first[C['DEP/UTC']] ?? '0'),
      heure_fin:            toTime(last[C['ARR/UTC']] ?? '0'),
      nb_on_days:           onDays,
      tdv_total:            fr(first[C['TDV Total']]),
      hc,
      hcr_crew:             hcr,
      hdv:                  fr(first[C['HDV']]),
      zone:                 first[C['Zone']] ?? null,
      temps_sej:            fr(first[C['tempsSej']]),
      h2hc:                 fr(first[C['H2HC']]),
      pv_base:              fr(first[C['TA']]),
      prime:                fr(first[C['Prime']]),
      dead_head:            first[C['deadHead']] === '1',
      a81:                  hcr > hc,
      raw_detail: {
        legs: rot.rows.map(r =>
          Object.fromEntries(clean.headers.map((h, i) => [h, r[i] ?? '']))
        ),
      },
    });
  }

  console.log(`Unique signatures: ${sigInserts.length}`);

  // ── 6. Insert signatures ───────────────────────────────────────────────────
  // Insert in one batch (small enough), retrieve IDs
  const { data: insertedSigs, error: sigErr } = await supabase
    .from('pairing_signature')
    .insert(sigInserts)
    .select('id, rotation_code, nb_on_days');

  if (sigErr || !insertedSigs) throw new Error('Signatures: ' + sigErr?.message);
  console.log(`Signatures inserted: ${insertedSigs.length}`);

  // Update snapshot unique_signatures count
  await supabase.from('scrape_snapshot').update({ unique_signatures: insertedSigs.length }).eq('id', snapshotId);

  // Build sigKey → id
  const sigIdMap = new Map<string, string>();
  for (const s of insertedSigs) {
    sigIdMap.set(`${s.rotation_code}|${s.nb_on_days}`, s.id);
  }

  // ── 7. Build & insert instances ────────────────────────────────────────────
  type InstInsert = {
    signature_id: string;
    activity_id:  string;
    depart_date:  string;
    depart_at:    string;
    arrivee_at:   string;
  };

  const instInserts: InstInsert[] = rotations.map(rot => {
    const first = rot.rows[0];
    const last  = rot.rows[rot.rows.length - 1];

    const rotCode = first[C['ROT']]?.trim() ?? '';
    const onDays  = parseInt(first[C['ON']] ?? '0', 10) || 0;
    const sigId   = sigIdMap.get(`${rotCode}|${onDays}`);
    if (!sigId) throw new Error(`No sig for ${rotCode}|${onDays}`);

    const activityId = first[C['ID Ligne']]?.trim() || rot.code;
    return {
      signature_id: sigId,
      activity_id:  activityId,
      depart_date:  parseDate(first[C['DebutVol']] || '01/06/2026'),
      depart_at:    toTimestamp(first[C['DebutVol']] || '01/06/2026', first[C['DEP/UTC']] || '0'),
      arrivee_at:   toTimestamp(first[C['FinVol']]   || '01/06/2026', last[C['ARR/UTC']]  || '0'),
    };
  });

  await insertBatch('pairing_instance', instInserts);

  console.log('\nImport complete.');
  console.log(`  Snapshot:   ${snapshotId}`);
  console.log(`  Signatures: ${insertedSigs.length}`);
  console.log(`  Instances:  ${instInserts.length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
