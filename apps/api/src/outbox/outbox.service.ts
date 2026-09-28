import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';

export interface OutboxEvent { id: string; type: string; payload: Record<string, unknown>; createdAt: string }
export type OutboxHandler = (events: OutboxEvent[]) => Promise<void> | void;

/**
 * At-least-once publisher for the transactional outbox. Rows are claimed (row-locked, SKIP LOCKED), handed to the
 * handler, and marked published in the same transaction — if the handler throws or the process dies, the
 * transaction rolls back and the rows are delivered again. Consumers must therefore tolerate duplicates.
 */
@Injectable()
export class OutboxService {
  constructor(private readonly db: DbService) {}

  /** Publishes one batch. Returns how many events were delivered (0 ⇒ the outbox is drained). */
  async publishBatch(handler: OutboxHandler, limit = 200): Promise<number> {
    return this.db.withSystem('outbox', async (c) => {
      const { rows } = await c.query('SELECT id, type, payload, created_at FROM outbox_claim($1)', [limit]);
      if (rows.length === 0) return 0;
      const events: OutboxEvent[] = rows.map((r) => ({
        id: String(r.id), type: r.type, payload: r.payload, createdAt: new Date(r.created_at).toISOString(),
      }));
      await handler(events);
      await c.query('SELECT outbox_mark_published($1::bigint[])', [events.map((e) => e.id)]);
      return events.length;
    });
  }
}
