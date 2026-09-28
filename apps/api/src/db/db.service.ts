import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { ENV } from '../config/tokens';
import type { Env } from '../config/env';
import type { Principal } from '../auth/principal';

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(@Inject(ENV) env: Env) {
    this.pool = new Pool({ connectionString: env.DATABASE_URL, max: env.DB_POOL_MAX ?? 20, idleTimeoutMillis: 30_000, statement_timeout: 10_000 });
  }

  /**
   * The ONLY way application code touches the database. It opens a transaction and sets
   * transaction-local session variables that the Postgres row-level-security policies read
   * (see db/migrations/001_init.sql). Because the settings are LOCAL to the transaction, a
   * pooled connection can never leak one user's identity into the next request.
   * Querying without a principal returns zero rows (RLS fails closed).
   */
  async withPrincipal<T>(p: Principal, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.inContext([p.kind, p.customerId ?? '', p.customerRole ?? '', p.sub], fn);
  }

  /**
   * For background workers only (scheduler, outbox publisher) — never reachable from a request. The 'system'
   * context can read lots and bids and call the owner-run lifecycle/outbox functions (see 003_lifecycle.sql);
   * those functions refuse any other context, so a request running as a customer or staff member cannot.
   */
  async withSystem<T>(worker: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.inContext(['system', '', '', `system:${worker}`], fn);
  }

  private async inContext<T>(ctx: [string, string, string, string], fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.role', $1, true), set_config('app.customer_id', $2, true),
                set_config('app.customer_role', $3, true), set_config('app.user_sub', $4, true)`,
        ctx,
      );
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
