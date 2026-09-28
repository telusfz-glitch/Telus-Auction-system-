import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { Env } from '../config/env';
import { ENV } from '../config/tokens';
import { LifecycleService } from '../lifecycle/lifecycle.service';
import { NotificationService } from '../notifications/notification.service';
import { OutboxService } from '../outbox/outbox.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { route } from '../realtime/routing';

/**
 * In-process background loops: the auction scheduler (every second), the outbox publisher (every 250 ms, draining
 * the backlog each time) and the outbox purge (hourly). Each loop never overlaps itself. All are safe with several
 * API instances running: the database serialises transitions, SKIP LOCKED splits the outbox, and with REDIS_URL set
 * the pushes reach sockets connected to every instance.
 */
@Injectable()
export class WorkersService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WorkersService.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly inFlight = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly lifecycle: LifecycleService,
    private readonly outbox: OutboxService,
    private readonly gateway: RealtimeGateway,
    private readonly notifications: NotificationService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.WORKERS_ENABLED) return;
    this.every('scheduler', this.env.SCHEDULER_INTERVAL_MS, () => this.lifecycle.tick());
    this.every('outbox', this.env.OUTBOX_INTERVAL_MS, () => this.drainOutbox());
    this.every('outbox-purge', 3_600_000, () => this.outbox.purge(this.env.OUTBOX_RETENTION_DAYS));
    if (this.notifications.enabled) this.every('email', this.env.EMAIL_INTERVAL_MS, () => this.drainEmail());
  }

  /** Publishes until the outbox is empty (or shutdown starts). */
  async drainOutbox(): Promise<void> {
    while (!this.stopped && (await this.outbox.publishBatch((events) => this.gateway.deliver(events.flatMap(route)))) > 0);
  }

  /** Sends due emails until none are left (or shutdown starts). */
  async drainEmail(): Promise<void> {
    while (!this.stopped && (await this.notifications.sendBatch()) > 0);
  }

  private every(name: string, ms: number, fn: () => Promise<unknown>): void {
    let running = false;
    const timer = setInterval(() => {
      if (running || this.stopped) return;
      running = true;
      const run = fn()
        .catch((e) => { if (!this.stopped) this.logger.error(`${name} loop failed`, e instanceof Error ? e.stack : String(e)); })
        .finally(() => { running = false; this.inFlight.delete(run); });
      this.inFlight.add(run);
    }, ms);
    timer.unref();
    this.timers.push(timer);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    await Promise.allSettled([...this.inFlight]);
  }
}
