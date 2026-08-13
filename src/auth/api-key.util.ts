import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Format d'une cle : sk_<env>_<prefixe 12 hex>_<secret 48 hex>
 * Le prefixe est stocke en clair pour retrouver la ligne en base sans avoir a
 * comparer le hash de toutes les cles ; le secret n'existe qu'une fois, a la
 * creation.
 */
export interface GeneratedApiKey {
  plaintext: string;
  prefix: string;
  hash: string;
}

export function generateApiKey(salt: string, env: string): GeneratedApiKey {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomBytes(24).toString('hex');
  const plaintext = `sk_${env}_${prefix}_${secret}`;
  return { plaintext, prefix, hash: hashApiKey(plaintext, salt) };
}

export function hashApiKey(plaintext: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${plaintext}`).digest('hex');
}

/** Extrait le prefixe d'une cle presentee, sans faire confiance a son format. */
export function extractPrefix(plaintext: string): string | null {
  const parts = plaintext.split('_');
  if (parts.length !== 4 || parts[0] !== 'sk') return null;
  return parts[2] || null;
}

/** Comparaison a temps constant, pour ne pas fuiter le hash par timing. */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
