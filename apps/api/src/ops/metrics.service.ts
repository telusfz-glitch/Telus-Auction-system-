import { Injectable, Logger } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { DbService } from '../db/db.service';

const BACKLOG = {
  outbox_unpublished: 'Outbox events not yet pushed to sockets/emails',
  outbox_oldest_unpublished_seconds: 'Age of the oldest unpublished outbox event',
  email_pending: 'Emails queued, not yet sent',
  email_failed: 'Emails that gave up after all retries',
  email_oldest_pending_seconds: 'Age of the oldest queued email',
  audit_unshipped_rows: 'Audit rows not yet copied to write-once storage',
  audit_oldest_unshipped_seconds: 'Age of the oldest audit row not yet shipped',
  auctions_live: 'Auctions currently live',
} as const;

/**
 * Prometheus metrics for operators. Counters are per process (Prometheus sums instances); the backlog gauges are read
 * from the database at scrape time through ops_metrics(), a system-only function that returns counts and ages only.
 * Its own registry (not the global one), so several app instances in one process — as in the tests — never collide.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger('Metrics');
  readonly registry = new Registry();
  readonly bids = new Counter({ name: 'telus_bids_total', help: 'Bid attempts by outcome', labelNames: ['outcome'], registers: [this.registry] });
  readonly bidSeconds = new Histogram({
    name: 'telus_bid_duration_seconds', help: 'Time to accept or refuse a bid (API side)',
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [this.registry],
  });
  readonly workerFailures = new Counter({ name: 'telus_worker_failures_total', help: 'Background loop runs that threw', labelNames: ['loop'], registers: [this.registry] });
  private readonly backlog = new Gauge({ name: 'telus_backlog', help: 'Backlogs and ages read from the database at scrape time (see "what")', labelNames: ['what'], registers: [this.registry] });
  private readonly dbUp = new Gauge({ name: 'telus_database_up', help: '1 if the last scrape could read the database', registers: [this.registry] });

  constructor(private readonly db: DbService) {
    collectDefaultMetrics({ register: this.registry, prefix: 'telus_' });
  }

  /** Outcome labels are a closed set: accepted, a known refusal code, or "error". */
  recordBid(outcome: string, seconds: number): void {
    this.bids.inc({ outcome: /^[A-Z_]{2,40}$/.test(outcome) || outcome === 'accepted' ? outcome : 'error' });
    this.bidSeconds.observe(seconds);
  }

  async render(): Promise<string> {
    try {
      const snap = (await this.db.withSystem('metrics', (c) => c.query('SELECT ops_metrics() AS m'))).rows[0].m as Record<string, number>;
      for (const what of Object.keys(BACKLOG)) this.backlog.set({ what }, Number(snap[what] ?? 0));
      this.dbUp.set(1);
    } catch (e) {
      this.dbUp.set(0);
      this.logger.error(`backlog snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return this.registry.metrics();
  }
}
