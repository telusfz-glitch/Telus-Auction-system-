import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service';

export interface TickResult { opened: string[]; closed: string[] }

/**
 * Time-driven auction transitions: scheduled → live at start_at, live → closed (+ lot allocation) at close_at.
 * All timing uses the database clock. Safe to run from several API instances at once: every transition is
 * idempotent and re-checked under a lock inside the database (see 003_lifecycle.sql).
 */
@Injectable()
export class LifecycleService {
  private readonly logger = new Logger(LifecycleService.name);
  constructor(private readonly db: DbService) {}

  async tick(): Promise<TickResult> {
    const opened = await this.db.withSystem('scheduler', async (c) =>
      (await c.query('SELECT id FROM open_due_auctions() AS id')).rows.map((r) => r.id as string));
    const due = await this.db.withSystem('scheduler', async (c) =>
      (await c.query('SELECT id FROM due_auction_closures() AS id')).rows.map((r) => r.id as string));

    // One transaction per auction: a failure closing one auction must not block the others.
    const closed: string[] = [];
    for (const id of due) {
      try {
        const done = await this.db.withSystem('scheduler', async (c) =>
          (await c.query('SELECT close_auction_if_due($1) AS done', [id])).rows[0].done as boolean);
        if (done) closed.push(id);
      } catch (e) {
        this.logger.error(`failed to close auction ${id}`, e instanceof Error ? e.stack : String(e));
      }
    }
    return { opened, closed };
  }
}
