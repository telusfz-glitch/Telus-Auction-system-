import { Logger, OnApplicationShutdown } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { createClient } from 'redis';

interface ThrottlerStorageRecord { totalHits: number; timeToExpire: number; isBlocked: boolean; timeToBlockExpire: number }

// Atomic fixed window + block. KEYS: hits, block. ARGV: ttl ms, limit, block ms. Returns {hits, ttl ms, blocked, block ms}.
const SCRIPT = `
local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl > 0 then
  return {tonumber(redis.call('GET', KEYS[1]) or '0'), redis.call('PTTL', KEYS[1]), 1, blockTtl}
end
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  return {hits, ttl, 1, tonumber(ARGV[3])}
end
return {hits, ttl, 0, 0}`;

/**
 * Rate-limit counters shared by every API instance (the default in-memory storage multiplies the limit by the number of
 * instances). If Redis is unreachable the request is allowed and the failure logged: a Redis outage must not stop an
 * auction. Keys arrive already hashed by the throttler guard, so no client address is stored in clear.
 */
export class RedisThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  private readonly logger = new Logger('RateLimit');
  private readonly client: ReturnType<typeof createClient>;
  private ready: Promise<unknown>;

  constructor(url: string, private readonly prefix = 'telus:rl') {
    this.client = createClient({ url, socket: { connectTimeout: 3000, reconnectStrategy: (n) => Math.min(n * 200, 5000) } });
    this.client.on('error', (e: Error) => this.logger.error(`redis: ${e.name}: ${e.message.replace(/\/\/[^@]*@/, '//***@')}`));
    this.ready = this.client.connect().catch(() => undefined);
  }

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    try {
      await this.ready;
      const base = `${this.prefix}:${throttlerName}:${key}`;
      const [hits, ttlMs, blocked, blockMs] = (await this.client.eval(SCRIPT, {
        keys: [`${base}:h`, `${base}:b`], arguments: [String(ttl), String(limit), String(blockDuration)],
      })) as number[];
      return {
        totalHits: hits!, timeToExpire: Math.max(0, Math.ceil(ttlMs! / 1000)),
        isBlocked: blocked === 1, timeToBlockExpire: Math.max(0, Math.ceil(blockMs! / 1000)),
      };
    } catch (e) {
      this.logger.error(`rate limit check failed open: ${e instanceof Error ? e.name : 'error'}`);
      return { totalHits: 0, timeToExpire: Math.ceil(ttl / 1000), isBlocked: false, timeToBlockExpire: 0 };
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}
