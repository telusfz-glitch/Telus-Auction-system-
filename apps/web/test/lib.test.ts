import { describe, expect, it } from 'vitest';
import { keyOf, randomId, safeReturnTo, seal, unseal } from '../src/lib/crypto';
import { aed, parseMoney } from '../src/lib/format';

describe('session sealing (AES-256-GCM)', () => {
  const secret = 'x'.repeat(40);
  it('round-trips and never contains the plaintext', () => {
    const s = seal('{"accessToken":"eyJsecret"}', secret);
    expect(s).not.toContain('eyJ');
    expect(unseal(s, secret)).toBe('{"accessToken":"eyJsecret"}');
  });
  it('rejects a wrong key, tampering and truncation', () => {
    const s = seal('hello', secret);
    expect(unseal(s, 'y'.repeat(40))).toBeNull();
    const buf = Buffer.from(s, 'base64url'); buf[buf.length - 1]! ^= 1;
    expect(unseal(buf.toString('base64url'), secret)).toBeNull();
    expect(unseal(s.slice(0, 10), secret)).toBeNull();
    expect(unseal('', secret)).toBeNull();
  });
  it('ids are 256-bit and Redis keys do not contain them', () => {
    const id = randomId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keyOf('sess', id)).not.toContain(id);
  });
});

describe('safeReturnTo — no open redirects', () => {
  it.each([
    ['/auctions/1', '/auctions/1'], ['//evil.example', '/'], ['/\\evil.example', '/'], ['https://evil.example', '/'],
    ['javascript:alert(1)', '/'], ['/auth/callback?x', '/'], ['/a\r\nSet-Cookie: x', '/'], [null, '/'], ['', '/'],
  ])('%s → %s', (input, out) => expect(safeReturnTo(input)).toBe(out));
});

describe('money formatting and parsing (no floats in display)', () => {
  it.each([['1234.5', 'AED 1,234.50'], ['0.00', 'AED 0.00'], ['1000000', 'AED 1,000,000.00'], [null, '—']])('aed(%s)', (v, out) => expect(aed(v)).toBe(out));
  it.each([['1250', 1250], ['1,250.50', 1250.5], ['AED 99.9', 99.9], ['1.234', null], ['-5', null], ['1e3', null], ['', null]])('parseMoney(%s)', (v, out) => expect(parseMoney(v)).toBe(out));
});
