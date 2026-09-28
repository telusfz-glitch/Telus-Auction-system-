import { Injectable, Logger } from '@nestjs/common';
import type { CreateTeamUserInput, UpdateTeamUserInput } from '@telus/shared';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../auth/principal';
import { ApiError } from '../common/api-error';
import { mapPgError } from '../common/pg-errors';
import { DbService } from '../db/db.service';
import { KeycloakAdmin } from '../identity/keycloak-admin';

const COLS = 'id, customer_id, keycloak_sub, email, display_name, role, status, created_at, updated_at';

/**
 * Customer team logins. A customer admin manages their own company's logins; staff manage any customer's. Keycloak
 * holds the credentials and roles, `customer_users` is the local record (RLS-scoped to the customer).
 * Ordering keeps the two consistent: create = Keycloak first, then the row (the Keycloak user is disabled again if the
 * row cannot be written, never left usable without a record); update = row first inside the transaction, then Keycloak, then commit.
 */
@Injectable()
export class TeamService {
  private readonly logger = new Logger(TeamService.name);
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly kc: KeycloakAdmin) {}

  private run<T>(p: Principal, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.db.withPrincipal(p, fn).catch((e) => { throw mapPgError(e); });
  }

  /** Customers act on their own company only; staff name the company explicitly. */
  private customerOf(p: Principal, customerId?: string): string {
    if (p.kind === 'customer') {
      if (p.customerRole !== 'customer_admin') throw new ApiError('FORBIDDEN', 'Only your company administrator can manage logins.', 403);
      return p.customerId!;
    }
    if (!customerId) throw new ApiError('CUSTOMER_REQUIRED', 'Customer required.', 422);
    return customerId;
  }

  list(p: Principal, customerId?: string) {
    const cid = p.kind === 'customer' ? p.customerId! : this.customerOf(p, customerId);
    return this.run(p, async (c) => (await c.query(`SELECT ${COLS} FROM customer_users WHERE customer_id = $1 ORDER BY created_at`, [cid])).rows);
  }

  async create(p: Principal, input: CreateTeamUserInput, customerId?: string, ip?: string) {
    const cid = this.customerOf(p, customerId);
    // Existence check under RLS first: staff get 404 for an unknown customer, customers can only ever reach their own.
    await this.run(p, async (c) => {
      if (!(await c.query('SELECT 1 FROM customers WHERE id = $1', [cid])).rowCount) throw new ApiError('CUSTOMER_NOT_FOUND', 'Customer not found.', 404);
      if ((await c.query('SELECT 1 FROM customer_users WHERE lower(email) = lower($1)', [input.email])).rowCount) {
        throw new ApiError('EMAIL_UNAVAILABLE', 'This email address cannot be used for a new login.', 409);
      }
    });
    const { id: sub, temporaryPassword } = await this.kc.createCustomerUser({ ...input, customerId: cid });
    try {
      const row = await this.run(p, async (c) => {
        const r = (await c.query(
          `INSERT INTO customer_users (customer_id, keycloak_sub, email, display_name, role, created_by)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${COLS}`,
          [cid, sub, input.email, `${input.firstName} ${input.lastName}`, input.role, p.sub])).rows[0];
        await this.audit.record(c, { actor: p, action: 'customer_user.create', referenceType: 'customer_user', referenceId: r.id,
          after: { customerId: cid, email: input.email, role: input.role }, ip });
        return r;
      });
      // The temporary password is returned exactly once and never stored or logged by the API.
      return { ...row, temporaryPassword };
    } catch (e) {
      await this.kc.setEnabled(sub, cid, false).catch(() => undefined);
      this.logger.error(`created Keycloak user ${sub} but could not record it; the login was disabled`);
      throw e;
    }
  }

  update(p: Principal, userId: string, input: UpdateTeamUserInput, ip?: string) {
    return this.run(p, async (c) => {
      const row = (await c.query(`SELECT ${COLS} FROM customer_users WHERE id = $1 FOR UPDATE`, [userId])).rows[0];
      if (!row) throw new ApiError('USER_NOT_FOUND', 'User not found.', 404);
      const cid = this.customerOf(p, row.customer_id);
      if (row.customer_id !== cid) throw new ApiError('USER_NOT_FOUND', 'User not found.', 404);
      if (row.keycloak_sub === p.sub) throw new ApiError('CANNOT_CHANGE_SELF', 'You cannot change your own login.', 422);

      const role = input.role ?? row.role;
      const status = input.status ?? row.status;
      const losesAdmin = row.role === 'customer_admin' && row.status === 'active' && (role !== 'customer_admin' || status !== 'active');
      if (losesAdmin) {
        // Serialise admin changes per customer so two concurrent demotions cannot both pass this check.
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`team:${cid}`]);
        const others = (await c.query(
          `SELECT count(*)::int AS n FROM customer_users WHERE customer_id = $1 AND role = 'customer_admin' AND status = 'active' AND id <> $2`,
          [cid, userId])).rows[0].n;
        if (others === 0) throw new ApiError('LAST_ADMIN', 'A company must keep at least one active administrator.', 422);
      }
      const after = (await c.query(`UPDATE customer_users SET role = $2, status = $3 WHERE id = $1 RETURNING ${COLS}`, [userId, role, status])).rows[0];
      await this.audit.record(c, { actor: p, action: 'customer_user.update', referenceType: 'customer_user', referenceId: userId,
        before: { role: row.role, status: row.status }, after: { role, status }, ip });

      // Keycloak last: if it fails, the transaction rolls back and nothing changed.
      if (role !== row.role) await this.kc.setCustomerRole(row.keycloak_sub, cid, role);
      if (status !== row.status) await this.kc.setEnabled(row.keycloak_sub, cid, status === 'active');
      return after;
    });
  }
}
