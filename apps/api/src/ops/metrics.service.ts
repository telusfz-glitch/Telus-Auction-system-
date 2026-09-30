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

/** CloudWatch names for the backlog gauges (embedded metric format). */
const EMF_BACKLOG: Record<keyof typeof BACKLOG, [string, 'Count' | 'Seconds']> = {
  outbox_unpublished: ['OutboxUnpublished', 'Count'],
  outbox_oldest_unpublished_seconds: ['OutboxOldestUnpublishedSeconds', 'Seconds'],
  email_pending: ['EmailPending', 'Count'],
  email_failed: ['EmailFailed', 'Count'],
  email_oldest_pending_seconds: ['EmailOldestPendingSeconds', 'Seconds'],
  audit_unshipped_rows: ['AuditUnshippedRows', 'Count'],
  audit_oldest_unshipped_seconds: ['AuditOldestUnshippedSeconds', 'Seconds'],
  auctions_live: ['AuctionsLive', 'Count'],
};
/** Bid durations kept per interval for CloudWatch percentiles (reservoir sample; EMF takes ≤100 values per metric). */
const LATENCY_SAMPLES = 100;

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

  // Embedded-metric-format state: counter totals at the last emit, and this interval's bid-duration sample.
  private lastTotals = new Map<string, number>();
  private latency: number[] = [];
  private latencySeen = 0;

  constructor(private readonly db: DbService) {
    collectDefaultMetrics({ register: this.registry, prefix: 'telus_' });
  }

  /** Outcome labels are a closed set: accepted, a known refusal code, or "error". */
  recordBid(outcome: string, seconds: number): void {
    this.bids.inc({ outcome: /^[A-Z_]{2,40}$/.test(outcome) || outcome === 'accepted' ? outcome : 'error' });
    this.bidSeconds.observe(seconds);
    this.latencySeen++;
    if (this.latency.length < LATENCY_SAMPLES) this.latency.push(seconds);
    else {
      const i = Math.floor(Math.random() * this.latencySeen);
      if (i < LATENCY_SAMPLES) this.latency[i] = seconds;
    }
  }

  async render(): Promise<string> {
    await this.refreshBacklog();
    return this.registry.metrics();
  }

  /**
   * One CloudWatch embedded-metric-format record (in AWS: printed to stdout, the awslogs driver ships it, CloudWatch
   * extracts the metrics — no agent, no extra permissions). Counters are the change since the previous record, so each
   * instance's values add up; backlog gauges are the same for every instance (alarms use their maximum).
   */
  async emf(namespace: string, service: string, now = Date.now()): Promise<Record<string, unknown>> {
    const snap = await this.refreshBacklog();
    const bids = await this.deltas(this.bids, 'bids', 'outcome');
    const failures = await this.deltas(this.workerFailures, 'failures', 'loop');
    const sum = (m: Map<string, number>, keep: (k: string) => boolean) => [...m].reduce((t, [k, v]) => t + (keep(k) ? v : 0), 0);
    const values: Record<string, number | number[]> = {
      BidsAccepted: sum(bids, (k) => k === 'accepted'),
      BidsRefused: sum(bids, (k) => k !== 'accepted' && k !== 'error'),
      BidErrors: sum(bids, (k) => k === 'error'),
      WorkerFailures: sum(failures, () => true),
      DatabaseUp: snap ? 1 : 0,
    };
    const units: Record<string, string> = { BidsAccepted: 'Count', BidsRefused: 'Count', BidErrors: 'Count', WorkerFailures: 'Count', DatabaseUp: 'None' };
    if (this.latency.length > 0) { values.BidLatency = this.latency; units.BidLatency = 'Seconds'; }
    this.latency = [];
    this.latencySeen = 0;
    if (snap) {
      for (const [what, [name, unit]] of Object.entries(EMF_BACKLOG)) { values[name] = Number(snap[what] ?? 0); units[name] = unit; }
    }
    return {
      _aws: { Timestamp: now, CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [['Service']], Metrics: Object.keys(values).map((Name) => ({ Name, Unit: units[Name] })) }] },
      Service: service,
      ...values,
    };
  }

  private async refreshBacklog(): Promise<Record<string, number> | null> {
    try {
      const snap = (await this.db.withSystem('metrics', (c) => c.query('SELECT ops_metrics() AS m'))).rows[0].m as Record<string, number>;
      for (const what of Object.keys(BACKLOG)) this.backlog.set({ what }, Number(snap[what] ?? 0));
      this.dbUp.set(1);
      return snap;
    } catch (e) {
      this.dbUp.set(0);
      this.logger.error(`backlog snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** Change of each label value of a counter since the previous call. */
  private async deltas(counter: Counter<string>, id: string, label: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const v of (await counter.get()).values) {
      const key = `${id}|${String(v.labels[label])}`;
      out.set(String(v.labels[label]), Math.max(0, v.value - (this.lastTotals.get(key) ?? 0)));
      this.lastTotals.set(key, v.value);
    }
    return out;
  }
}
