import { Controller, Get, Header, Headers, HttpCode, Inject, NotFoundException, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'crypto';
import { createClient } from 'redis';
import { Public } from '../auth/decorators';
import type { Env } from '../config/env';
import { ENV } from '../config/tokens';
import { DbService } from '../db/db.service';
import { MetricsService } from './metrics.service';

const READY_CACHE_MS = 2000;
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Operations endpoints: readiness for the load balancer, metrics for Prometheus. Neither reveals any business data. */
@Controller()
export class OpsController implements OnModuleDestroy {
  private redis?: ReturnType<typeof createClient>;

  constructor(@Inject(ENV) private readonly env: Env, private readonly db: DbService, private readonly metrics: MetricsService) {}

  /**
   * 200 only when this instance can reach its database (and Redis, when configured). No details on failure.
   * The endpoint is public and unthrottled (load balancers call it), so one check result is shared for READY_CACHE_MS:
   * a flood of requests costs at most one database connection per interval instead of one each.
   */
  @Public() @SkipThrottle() @Get('health/ready') @HttpCode(200)
  async ready() {
    const now = Date.now();
    if (!this.readiness || now - this.readiness.at > READY_CACHE_MS) {
      this.readiness = { at: now, ok: this.check() };
    }
    if (!(await this.readiness.ok)) throw new ServiceUnavailableException({ statusCode: 503, code: 'NOT_READY', message: 'Not ready.' });
    return { ok: true };
  }

  private readiness?: { at: number; ok: Promise<boolean> };

  private async check(): Promise<boolean> {
    const checks = await Promise.all([
      this.db.withSystem('ready', (c) => c.query('SELECT 1')).then(() => true, () => false),
      this.env.REDIS_URL ? this.pingRedis() : Promise.resolve(true),
    ]);
    return !checks.includes(false);
  }

  /** Prometheus scrape. Disabled (404) unless METRICS_TOKEN is set; the scraper sends it as a bearer token. */
  @Public() @SkipThrottle() @Get('metrics') @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8') @Header('cache-control', 'no-store')
  async scrape(@Headers('authorization') auth?: string) {
    const token = this.env.METRICS_TOKEN;
    if (!token) throw new NotFoundException();
    if (!same(auth ?? '', `Bearer ${token}`)) throw new NotFoundException();   // no oracle: wrong token looks like "off"
    return this.metrics.render();
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit().catch(() => undefined);
  }

  private async pingRedis(): Promise<boolean> {
    try {
      if (!this.redis) {
        this.redis = createClient({ url: this.env.REDIS_URL, socket: { connectTimeout: 2000, reconnectStrategy: false } });
        this.redis.on('error', () => undefined);
      }
      if (!this.redis.isOpen) await this.redis.connect();
      return (await this.redis.ping()) === 'PONG';
    } catch {
      this.redis = undefined;
      return false;
    }
  }
}
