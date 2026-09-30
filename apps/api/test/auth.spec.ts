import { SignJWT, type KeyLike } from 'jose';
import { ForbiddenPrincipalError, InvalidTokenError, MfaRequiredError, TokenVerifier } from '../src/auth/token-verifier';
import { AUD, CUST_A, ISS, customerClaims, makeKeys, signToken, staffClaims } from './helpers';

describe('TokenVerifier — JWT validation and principal mapping', () => {
  let priv: KeyLike, pub: KeyLike, other: KeyLike, verifier: TokenVerifier;
  beforeAll(async () => {
    ({ privateKey: priv, publicKey: pub } = await makeKeys());
    ({ privateKey: other } = await makeKeys());
    verifier = new TokenVerifier({ issuer: ISS, audience: AUD, getKey: async () => pub });
  });

  it('accepts a valid staff token', async () => {
    const p = await verifier.verify(await signToken(priv, staffClaims('finance')));
    expect(p).toMatchObject({ kind: 'staff', roles: ['finance'], customerId: null });
  });

  it('accepts a valid customer token and picks the highest customer role', async () => {
    const claims = { ...customerClaims('customer_viewer'), realm_access: { roles: ['customer_viewer', 'customer_admin'] } };
    const p = await verifier.verify(await signToken(priv, claims));
    expect(p).toMatchObject({ kind: 'customer', customerId: CUST_A, customerRole: 'customer_admin' });
  });

  it.each([
    ['wrong issuer', () => signToken(priv, staffClaims('finance'), { iss: 'http://evil.example/realms/telus' })],
    ['wrong audience', () => signToken(priv, staffClaims('finance'), { aud: 'some-other-api' })],
    ['expired', () => signToken(priv, staffClaims('finance'), { exp: Math.floor(Date.now() / 1000) - 3600 })],
    ['signed with an attacker key', () => signToken(other, staffClaims('super_admin'))],
    ['missing subject', () => signToken(priv, staffClaims('finance'), { sub: null })],
  ])('rejects: %s', async (_name, make) => {
    await expect(verifier.verify(await make())).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects an unsigned "alg: none" token', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: ISS, aud: AUD, sub: 'x', iat: now, exp: now + 300, ...staffClaims('super_admin') })}.`;
    await expect(verifier.verify(forged)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects an HS256 token signed with the public key as secret (algorithm-confusion attack)', async () => {
    const forged = await new SignJWT(staffClaims('super_admin')).setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISS).setAudience(AUD).setSubject('x').setIssuedAt().setExpirationTime('5m')
      .sign(new TextEncoder().encode('-----BEGIN PUBLIC KEY-----attacker-known-material'));
    await expect(verifier.verify(forged)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects garbage', async () => {
    await expect(verifier.verify('not.a.jwt')).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('forbids a staff token that does not show a second factor (password alone never reaches the staff API)', async () => {
    const { amr: _amr, ...noAmr } = staffClaims('super_admin');
    for (const claims of [noAmr, { ...noAmr, amr: ['pwd'] }, { ...noAmr, amr: 'otp' }, { ...noAmr, amr: [42] }]) {
      await expect(verifier.verify(await signToken(priv, claims))).rejects.toBeInstanceOf(MfaRequiredError);
    }
    // Customers are not affected: their second factor is governed by the login flow (enrolled logins are always asked).
    await expect(verifier.verify(await signToken(priv, customerClaims('customer_admin')))).resolves.toMatchObject({ kind: 'customer' });
    // Configurable (e.g. accept a hardware key), and can be switched off only explicitly.
    const hwk = new TokenVerifier({ issuer: ISS, audience: AUD, getKey: async () => pub, staffAmr: ['otp', 'hwk'] });
    await expect(hwk.verify(await signToken(priv, { ...noAmr, amr: ['pwd', 'hwk'] }))).resolves.toMatchObject({ kind: 'staff' });
    const off = new TokenVerifier({ issuer: ISS, audience: AUD, getKey: async () => pub, staffAmr: [] });
    await expect(off.verify(await signToken(priv, noAmr))).resolves.toMatchObject({ kind: 'staff' });
  });

  it('forbids an identity holding both staff and customer roles', async () => {
    const t = await signToken(priv, { realm_access: { roles: ['finance', 'customer_admin'] }, customer_id: CUST_A });
    await expect(verifier.verify(t)).rejects.toBeInstanceOf(ForbiddenPrincipalError);
  });

  it('forbids a customer token with no customer_id, or a malformed one (no tenant guessing)', async () => {
    await expect(verifier.verify(await signToken(priv, { realm_access: { roles: ['customer_bidder'] } }))).rejects.toBeInstanceOf(ForbiddenPrincipalError);
    await expect(verifier.verify(await signToken(priv, customerClaims('customer_bidder', "x'; DROP TABLE bids;--")))).rejects.toBeInstanceOf(ForbiddenPrincipalError);
  });

  it('ignores privileges smuggled outside realm_access.roles', async () => {
    const t = await signToken(priv, { roles: ['super_admin'], resource_access: { 'telus-api': { roles: ['super_admin'] } } });
    await expect(verifier.verify(t)).rejects.toBeInstanceOf(ForbiddenPrincipalError);
  });
});
