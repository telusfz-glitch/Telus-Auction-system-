import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { CUSTOMER_ROLES, CUSTOMER_ROLE_RANK, STAFF_ROLES } from '@telus/shared';
import type { Principal } from './principal';

/** Token is bad/expired/forged → HTTP 401. Reason is never sent to the client. */
export class InvalidTokenError extends Error {}
/** Token is authentic but the identity is not acceptable for this app → HTTP 403. */
export class ForbiddenPrincipalError extends Error {}
/** A staff token without a second factor (e.g. issued right after enrolling an authenticator) → 403 MFA_REQUIRED. */
export class MfaRequiredError extends ForbiddenPrincipalError {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TokenVerifierOptions {
  issuer: string;
  audience: string;
  getKey: JWTVerifyGetKey;
  /**
   * A staff token is accepted only if its `amr` (authentication methods, set by Keycloak's AMR mapper from the login flow)
   * includes one of these. Default ['otp']: staff must have used their authenticator app. [] disables the check.
   */
  staffAmr?: readonly string[];
}

export class TokenVerifier {
  constructor(private readonly opts: TokenVerifierOptions) {}

  async verify(token: string): Promise<Principal> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.opts.getKey, {
        issuer: this.opts.issuer,
        audience: this.opts.audience,
        // Pinned algorithm: blocks "alg: none" and HS256-with-public-key confusion attacks.
        algorithms: ['RS256'],
        clockTolerance: 5,
        requiredClaims: ['exp', 'iat', 'sub'],
      }));
    } catch {
      throw new InvalidTokenError('token rejected');
    }
    return this.toPrincipal(payload);
  }

  private toPrincipal(payload: JWTPayload): Principal {
    // Roles are read ONLY from Keycloak's realm_access.roles. Top-level or client-level
    // "roles" claims are ignored so they can't be used to smuggle privileges.
    const realmAccess = payload['realm_access'] as { roles?: unknown } | undefined;
    const roles = Array.isArray(realmAccess?.roles) ? (realmAccess!.roles as unknown[]).filter((r): r is string => typeof r === 'string') : [];
    const staffRoles = roles.filter((r) => (STAFF_ROLES as readonly string[]).includes(r));
    const customerRoles = roles.filter((r) => (CUSTOMER_ROLES as readonly string[]).includes(r));
    const sub = payload.sub as string;
    const username = typeof payload['preferred_username'] === 'string' ? (payload['preferred_username'] as string) : sub;

    // Privilege separation: one identity is either TELUS staff or a customer user, never both.
    if (staffRoles.length > 0 && customerRoles.length > 0) throw new ForbiddenPrincipalError('mixed staff/customer roles');

    if (staffRoles.length > 0) {
      // Keycloak's login flow already forces an authenticator for staff; this refuses a staff token obtained any other
      // way (another client, a flow change, password-only) so a stolen password alone never reaches the staff API.
      const required = this.opts.staffAmr ?? ['otp'];
      const amr = Array.isArray(payload['amr']) ? (payload['amr'] as unknown[]) : [];
      if (required.length > 0 && !amr.some((m) => typeof m === 'string' && required.includes(m))) {
        throw new MfaRequiredError('staff token without a second factor');
      }
      return { sub, username, kind: 'staff', roles: staffRoles, customerId: null, customerRole: null, tokenExp: payload.exp };
    }
    if (customerRoles.length > 0) {
      const customerId = payload['customer_id'];
      if (typeof customerId !== 'string' || !UUID_RE.test(customerId)) throw new ForbiddenPrincipalError('customer token without valid customer_id');
      const customerRole = CUSTOMER_ROLE_RANK.find((r) => customerRoles.includes(r)) ?? null;
      return { sub, username, kind: 'customer', roles: customerRoles, customerId: customerId.toLowerCase(), customerRole, tokenExp: payload.exp };
    }
    throw new ForbiddenPrincipalError('no application role');
  }
}
