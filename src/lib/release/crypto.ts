/**
 * Helpers crypto pour les release downloads.
 *
 *  - deriveUserKey  : dérive une clé AES-GCM 256 bits stable par user via PBKDF2
 *                     (user_id + RELEASE_ENCRYPTION_SECRET). Le serveur la régénère
 *                     à chaque download ; le client la reçoit dans la réponse et
 *                     l'utilise pour déchiffrer le payload.
 *  - encryptPayload : AES-GCM avec IV aléatoire 12 octets, retourne base64.
 *  - watermarkFor   : HMAC-SHA256(user_id || release_id, RELEASE_WATERMARK_SECRET).
 *                     Permet en cas de fuite d'identifier l'utilisateur source.
 *
 * Le serveur tient les deux secrets ; ils ne quittent jamais le runtime Node.
 */
import { createHmac, pbkdf2Sync, randomBytes, createCipheriv } from 'node:crypto';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variable d'environnement manquante : ${name}`);
  return v;
}

/** Clé AES-GCM 256 bits, stable pour un (userId) donné. */
export function deriveUserKey(userId: string): Buffer {
  const secret = requireEnv('RELEASE_ENCRYPTION_SECRET');
  // Salt = userId : la clé est stable pour le user, mais distincte entre users.
  return pbkdf2Sync(secret, userId, 100_000, 32, 'sha256');
}

export interface EncryptedBlob {
  /** AES-GCM IV (base64, 12 octets). */
  iv: string;
  /** ciphertext + auth tag concaténés (base64). */
  data: string;
}

export function encryptPayload(plaintext: string, key: Buffer): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv:   iv.toString('base64'),
    data: Buffer.concat([ct, tag]).toString('base64'),
  };
}

export function watermarkFor(userId: string, releaseId: string): string {
  const secret = requireEnv('RELEASE_WATERMARK_SECRET');
  return createHmac('sha256', secret)
    .update(`${userId}|${releaseId}`)
    .digest('hex');
}

/**
 * Renvoie la clé brute en base64 — le client doit la stocker en mémoire (pas
 * dans Dexie) le temps de déchiffrer, puis l'oublier. Le client peut toujours
 * re-télécharger pour récupérer la clé si nécessaire (online).
 */
export function exportUserKeyBase64(userId: string): string {
  return deriveUserKey(userId).toString('base64');
}
