import { createHmac } from 'crypto';

/** RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s) — what an authenticator app computes from the secret Keycloak shows. */
export function totp(base32Secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = base32Secret.replace(/[\s=]/g, '').toUpperCase();
  let bits = '';
  for (const ch of clean) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', key).update(counter).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

/** RFC 4648 base32 of raw secret bytes (what Keycloak shows under "Unable to scan?"). */
export function base32(raw: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...Buffer.from(raw, 'utf8')].map((b) => b.toString(2).padStart(8, '0')).join('');
  return (bits.match(/.{1,5}/g) ?? []).map((c) => alphabet[parseInt(c.padEnd(5, '0'), 2)]).join('');
}

const lastStep = new Map<string, number>();
/**
 * A code for this user that Keycloak has not seen yet: codes are single-use (otpPolicyCodeReusable=false), so a second
 * login by the same user inside one 30-second window waits for the next window — like a person would.
 */
export async function freshCode(user: string, base32Secret: string): Promise<string> {
  let step = Math.floor(Date.now() / 30_000);
  if (lastStep.get(user) === step) {
    await new Promise((r) => setTimeout(r, (step + 1) * 30_000 - Date.now() + 200));
    step = Math.floor(Date.now() / 30_000);
  }
  lastStep.set(user, step);
  return totp(base32Secret);
}
