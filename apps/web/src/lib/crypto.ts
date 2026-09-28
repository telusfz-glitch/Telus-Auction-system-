import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/** AES-256-GCM with a key derived from the secret. Output: base64url(iv | tag | ciphertext). */
export function seal(plaintext: string, secret: string): string {
  const key = createHash('sha256').update(`telus-session-v1|${secret}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

/** Returns null for anything that does not authenticate (wrong key, tampered, truncated). */
export function unseal(sealed: string, secret: string): string | null {
  try {
    const buf = Buffer.from(sealed, 'base64url');
    if (buf.length < 29) return null;
    const key = createHash('sha256').update(`telus-session-v1|${secret}`).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Random opaque identifier (256 bits). */
export const randomId = () => randomBytes(32).toString('base64url');

/** Redis keys are hashes of the cookie value, so a Redis dump does not contain usable session cookies. */
export const keyOf = (prefix: string, id: string) => `${prefix}:${createHash('sha256').update(id).digest('base64url')}`;

/** Only same-site relative paths may be used as post-login destinations (no open redirects). */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || /[\r\n]/.test(value)) return '/';
  if (value.startsWith('/auth/')) return '/';
  return value.slice(0, 512);
}
