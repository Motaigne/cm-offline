/**
 * Helpers client pour les releases locales (Dexie chiffré + expiration).
 *
 *  - downloadAndStoreRelease : GET /api/release/:id/download → Dexie
 *  - getDecryptedRelease     : lit Dexie + déchiffre AES-GCM via WebCrypto
 *  - dropExpiredReleases     : supprime les releases dont expires_at est passé
 *  - getStoredReleases       : liste les releases en cache (sans déchiffrer)
 */
import { db, type StoredRelease } from '@/lib/local-db';

interface DownloadResponse {
  release: { id: string; target_month: string; version: number; released_at: string; notes: string | null };
  encrypted: { iv: string; data: string };
  key_b64: string;
  watermark: string;
  expires_at: string;
}

interface ReleasePayload {
  schema_version: number;
  release_id: string;
  target_month: string;
  version: number;
  released_at: string;
  notes: string | null;
  signatures: unknown[];
  instances: unknown[];
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function importAesKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    b64ToBytes(b64) as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
}

export async function downloadAndStoreRelease(releaseId: string): Promise<StoredRelease> {
  const res = await fetch(`/api/release/${releaseId}/download`);
  if (!res.ok) throw new Error(`Download release: HTTP ${res.status}`);
  const json = (await res.json()) as DownloadResponse;

  const stored: StoredRelease = {
    target_month:  json.release.target_month,
    release_id:    json.release.id,
    version:       json.release.version,
    released_at:   json.release.released_at,
    notes:         json.release.notes,
    iv:            json.encrypted.iv,
    data:          json.encrypted.data,
    key_b64:       json.key_b64,
    watermark:     json.watermark,
    expires_at:    json.expires_at,
    downloaded_at: Date.now(),
  };

  // Une seule release par mois en local : on remplace l'ancienne au passage.
  await db.transaction('rw', db.releases, async () => {
    await db.releases.where('target_month').equals(json.release.target_month).delete();
    await db.releases.put(stored);
  });

  return stored;
}

export async function getStoredReleases(): Promise<StoredRelease[]> {
  return db.releases.orderBy('target_month').reverse().toArray();
}

export async function getStoredReleaseForMonth(targetMonth: string): Promise<StoredRelease | undefined> {
  // targetMonth peut être 'YYYY-MM' ou 'YYYY-MM-DD' (la DB stocke 'YYYY-MM-DD')
  const fullMonth = targetMonth.length === 7 ? `${targetMonth}-01` : targetMonth;
  return db.releases.get(fullMonth);
}

export async function getDecryptedRelease(targetMonth: string): Promise<ReleasePayload | null> {
  const stored = await getStoredReleaseForMonth(targetMonth);
  if (!stored) return null;
  if (Date.parse(stored.expires_at) < Date.now()) {
    await db.releases.delete(stored.target_month);
    return null;
  }
  const key = await importAesKey(stored.key_b64);
  const iv  = b64ToBytes(stored.iv);
  const ct  = b64ToBytes(stored.data);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource);
  const text = new TextDecoder().decode(plain);
  return JSON.parse(text) as ReleasePayload;
}

export async function dropExpiredReleases(): Promise<number> {
  const now = new Date().toISOString();
  // expires_at est un index Dexie — on peut filtrer par range.
  const expired = await db.releases.where('expires_at').below(now).toArray();
  if (expired.length === 0) return 0;
  await db.releases.bulkDelete(expired.map(r => r.target_month));
  return expired.length;
}
