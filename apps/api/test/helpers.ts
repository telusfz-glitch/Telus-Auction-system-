import { SignJWT, generateKeyPair, type KeyLike } from 'jose';

export const ISS = 'http://localhost:8080/realms/telus';
export const AUD = 'telus-api';
export const CUST_A = '11111111-1111-4111-8111-111111111111';
export const CUST_B = '22222222-2222-4222-8222-222222222222';

export async function makeKeys() {
  return generateKeyPair('RS256');
}

export interface TokenOpts { iss?: string; aud?: string; exp?: string | number; sub?: string | null; alg?: string }
export async function signToken(privateKey: KeyLike, claims: Record<string, unknown>, o: TokenOpts = {}) {
  const jwt = new SignJWT(claims).setProtectedHeader({ alg: (o.alg ?? 'RS256') })
    .setIssuer(o.iss ?? ISS).setAudience(o.aud ?? AUD).setIssuedAt().setExpirationTime(o.exp ?? '5m');
  if (o.sub !== null) jwt.setSubject(o.sub ?? 'user-1');
  return jwt.sign(privateKey);
}
// Staff tokens carry `amr` like Keycloak's AMR mapper writes after password + authenticator app.
export const staffClaims = (role: string) => ({ preferred_username: `${role}@telus.ae`, realm_access: { roles: [role] }, amr: ['pwd', 'otp'] });
export const customerClaims = (role: string, customerId = CUST_A) => ({ preferred_username: `${role}@x.ae`, customer_id: customerId, realm_access: { roles: [role] } });
