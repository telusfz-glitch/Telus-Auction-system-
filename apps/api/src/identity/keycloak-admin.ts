import { Inject, Injectable, Logger } from '@nestjs/common';
import { CUSTOMER_ROLES, STAFF_ROLES } from '@telus/shared';
import { randomInt } from 'crypto';
import { ApiError } from '../common/api-error';
import type { Env } from '../config/env';
import { ENV } from '../config/tokens';

export interface KcUser { id: string; username: string; email?: string; enabled: boolean; attributes?: Record<string, string[]> }

/**
 * Minimal Keycloak Admin REST client for customer logins, authenticated as the `telus-api-admin` service account
 * (client credentials). Keycloak itself confines that account (fine-grained admin permissions v2, telus-realm.json):
 * it can create and manage only members of the `customers` group and grant only the three customer roles.
 * This class adds defence in depth on top: it only ever grants CUSTOMER roles, and refuses to touch a user that is not
 * bound to the expected customer or that holds any staff role.
 */
@Injectable()
export class KeycloakAdmin {
  private readonly logger = new Logger(KeycloakAdmin.name);
  private token: { value: string; exp: number } | null = null;
  private readonly realmUrl: string;
  private readonly adminUrl: string;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.realmUrl = env.KEYCLOAK_ISSUER;
    // http(s)://host/realms/<realm> → http(s)://host/admin/realms/<realm>
    this.adminUrl = env.KEYCLOAK_ISSUER.replace(/\/realms\/([^/]+)\/?$/, '/admin/realms/$1');
  }

  get enabled(): boolean { return !!this.env.KEYCLOAK_ADMIN_CLIENT_SECRET; }

  private async accessToken(): Promise<string> {
    if (!this.enabled) throw new ApiError('IDENTITY_ADMIN_DISABLED', 'Login management is not configured.', 503);
    if (this.token && this.token.exp - 15 > Date.now() / 1000) return this.token.value;
    const res = await fetch(`${this.realmUrl}/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials', client_id: this.env.KEYCLOAK_ADMIN_CLIENT_ID, client_secret: this.env.KEYCLOAK_ADMIN_CLIENT_SECRET!,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      this.logger.error(`service-account token request failed: ${res.status}`);
      throw new ApiError('IDENTITY_UNAVAILABLE', 'The identity service is unavailable. Please try again.', 503);
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, exp: Date.now() / 1000 + body.expires_in };
    return body.access_token;
  }

  private async call(method: string, path: string, body?: unknown, allowForbidden = false): Promise<Response> {
    const res = await fetch(`${this.adminUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status >= 500 || res.status === 401 || (res.status === 403 && !allowForbidden)) {
      this.logger.error(`keycloak admin ${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')} → ${res.status}`);
      throw new ApiError('IDENTITY_UNAVAILABLE', 'The identity service is unavailable. Please try again.', 503);
    }
    return res;
  }

  /** Creates the login with a temporary password; the user must replace it (and, by default, enrol TOTP) at first sign-in. */
  async createCustomerUser(u: { email: string; firstName: string; lastName: string; customerId: string; role: string }): Promise<{ id: string; temporaryPassword: string }> {
    this.assertCustomerRole(u.role);
    const temporaryPassword = generatePassword();
    const res = await this.call('POST', '/users', {
      username: u.email, email: u.email, firstName: u.firstName, lastName: u.lastName, enabled: true, emailVerified: true,
      attributes: { customer_id: [u.customerId] },
      // The service account may create users ONLY inside this group (fine-grained admin permissions, telus-realm.json).
      groups: ['/customers'],
      requiredActions: this.env.TEAM_USER_REQUIRED_ACTIONS.split(',').map((s) => s.trim()).filter(Boolean),
      credentials: [{ type: 'password', value: temporaryPassword, temporary: true }],
    });
    if (res.status === 409) throw new ApiError('EMAIL_UNAVAILABLE', 'This email address cannot be used for a new login.', 409);
    if (res.status === 400) throw new ApiError('INVALID_USER', 'Keycloak rejected the user details.', 422);
    if (res.status !== 201) throw new ApiError('IDENTITY_UNAVAILABLE', 'The identity service is unavailable. Please try again.', 503);
    const id = res.headers.get('location')?.split('/').pop();
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw new ApiError('IDENTITY_UNAVAILABLE', 'The identity service is unavailable. Please try again.', 503);
    try {
      await this.addRealmRole(id, u.role);
      // Read back: Keycloak silently drops undeclared attributes (see telus-realm.json user profile).
      await this.getCustomerUser(id, u.customerId);
    } catch (e) {
      await this.call('DELETE', `/users/${id}`).catch(() => undefined);
      throw e;
    }
    return { id, temporaryPassword };
  }

  /** Loads a user and proves it belongs to `customerId` and holds no staff role — before ANY change to it. */
  async getCustomerUser(id: string, customerId: string): Promise<KcUser> {
    const res = await this.call('GET', `/users/${id}`, undefined, true);
    if (res.status === 403) {
      // Keycloak itself refuses: the user is not a member of the customers group (e.g. a staff account).
      this.logger.error(`refusing to manage user ${id}: outside the service account's permissions`);
      throw new ApiError('USER_NOT_FOUND', 'User not found.', 404);
    }
    if (res.status === 404) throw new ApiError('USER_NOT_FOUND', 'User not found.', 404);
    const user = (await res.json()) as KcUser;
    if (user.attributes?.['customer_id']?.[0]?.toLowerCase() !== customerId.toLowerCase()) {
      this.logger.error(`refusing to manage user ${id}: not bound to the expected customer`);
      throw new ApiError('USER_NOT_FOUND', 'User not found.', 404);
    }
    const roles = (await (await this.call('GET', `/users/${id}/role-mappings/realm`)).json()) as Array<{ name: string }>;
    if (roles.some((r) => (STAFF_ROLES as readonly string[]).includes(r.name))) {
      this.logger.error(`refusing to manage user ${id}: holds a staff role`);
      throw new ApiError('USER_NOT_FOUND', 'User not found.', 404);
    }
    return user;
  }

  async setCustomerRole(id: string, customerId: string, role: string): Promise<void> {
    this.assertCustomerRole(role);
    await this.getCustomerUser(id, customerId);
    const current = (await (await this.call('GET', `/users/${id}/role-mappings/realm`)).json()) as Array<{ id: string; name: string }>;
    const stale = current.filter((r) => (CUSTOMER_ROLES as readonly string[]).includes(r.name) && r.name !== role);
    await this.addRealmRole(id, role);
    if (stale.length) await this.call('DELETE', `/users/${id}/role-mappings/realm`, stale);
    await this.call('POST', `/users/${id}/logout`);   // new role applies at next sign-in; end current sessions now
  }

  /** Disabling also ends every session; the access token still in use expires within its lifetime (≤5 min). */
  async setEnabled(id: string, customerId: string, enabled: boolean): Promise<void> {
    await this.getCustomerUser(id, customerId);
    await this.call('PUT', `/users/${id}`, { enabled });
    if (!enabled) await this.call('POST', `/users/${id}/logout`);
  }

  private async addRealmRole(id: string, role: string): Promise<void> {
    this.assertCustomerRole(role);
    const r = await this.call('GET', `/roles/${encodeURIComponent(role)}`);
    if (!r.ok) throw new ApiError('IDENTITY_UNAVAILABLE', 'The identity service is unavailable. Please try again.', 503);
    const rep = await r.json();
    const res = await this.call('POST', `/users/${id}/role-mappings/realm`, [rep]);
    if (!res.ok) throw new ApiError('IDENTITY_UNAVAILABLE', 'The identity service is unavailable. Please try again.', 503);
  }

  private assertCustomerRole(role: string): void {
    // Hard stop, independent of input validation: this service account must never grant a staff role.
    if (!(CUSTOMER_ROLES as readonly string[]).includes(role)) throw new Error(`refusing to grant non-customer role ${role}`);
  }
}

/** 20 characters, always satisfying the realm password policy (upper, lower, digit, special, length ≥ 14). */
export function generatePassword(): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%*-_=+?'];
  const all = sets.join('');
  const chars = sets.map((s) => s[randomInt(s.length)]!);
  while (chars.length < 20) chars.push(all[randomInt(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j]!, chars[i]!]; }
  return chars.join('');
}
