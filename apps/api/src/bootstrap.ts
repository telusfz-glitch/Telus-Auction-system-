import { Logger, type INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import helmet from 'helmet';
import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { isIP } from 'net';
import { createClient } from 'redis';
import type { Server, ServerOptions } from 'socket.io';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import type { Env } from './config/env';

/** Shared by main.ts and the e2e tests, so tests exercise the real security configuration. */
export async function configureApp(app: INestApplication, env: Env): Promise<void> {
  const server = app.getHttpAdapter().getInstance();
  server.disable('x-powered-by');
  server.set('trust proxy', env.TRUST_PROXY);
  server.use(clientIpFromWebApp(env.CLIENT_IP_FORWARD_SECRET));

  app.use(
    helmet({
      // Pure JSON API: nothing may be framed, scripted or embedded from it.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.enableCors({
    origin: origins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key'],
    maxAge: 600,
  });
  const io = new SecureIoAdapter(app, origins);
  if (env.REDIS_URL) await io.connectToRedis(env.REDIS_URL);
  app.useWebSocketAdapter(io);
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
}

export const CLIENT_IP_HEADER = 'x-telus-client-ip';
export const CLIENT_IP_KEY_HEADER = 'x-telus-client-ip-key';

/**
 * Customers reach the API through the web app's server, so without help every bid and audit entry would record the web
 * server's address (in AWS: the NAT gateway's, the same for everyone). The web app forwards the end user's address with
 * a shared secret; only a request carrying that secret may set it, so a customer calling the API directly cannot choose
 * the address written into the audit log. Both headers are removed either way.
 */
export function clientIpFromWebApp(secret: string | undefined) {
  const expected = secret ? Buffer.from(secret) : null;
  return (req: Request, _res: Response, next: NextFunction) => {
    const ip = req.headers[CLIENT_IP_HEADER];
    const key = req.headers[CLIENT_IP_KEY_HEADER];
    delete req.headers[CLIENT_IP_HEADER];
    delete req.headers[CLIENT_IP_KEY_HEADER];
    if (expected && typeof key === 'string' && typeof ip === 'string' && isIP(ip)) {
      const got = Buffer.from(key);
      if (got.length === expected.length && timingSafeEqual(got, expected)) {
        Object.defineProperty(req, 'ip', { value: ip, configurable: true, enumerable: true });
      }
    }
    next();
  };
}

/**
 * Socket.IO with the same origin allow-list as HTTP, small frames, and no long-polling downgrade path. With a Redis
 * URL, rooms are shared across API instances (a push emitted on one instance reaches sockets on all of them).
 */
class SecureIoAdapter extends IoAdapter {
  private readonly logger = new Logger('Realtime');
  private redisAdapter?: ReturnType<typeof createAdapter>;
  private redisClients: Array<ReturnType<typeof createClient>> = [];

  constructor(app: INestApplication, private readonly origins: string[]) {
    super(app);
  }

  async connectToRedis(url: string): Promise<void> {
    const pub = createClient({ url });
    const sub = pub.duplicate();
    // Log the error class only: the connection URL carries the Redis password.
    for (const c of [pub, sub]) c.on('error', (e: Error) => this.logger.error(`redis: ${e.name}: ${e.message.replace(/\/\/[^@]*@/, '//***@')}`));
    await Promise.all([pub.connect(), sub.connect()]);
    this.redisClients = [pub, sub];
    this.redisAdapter = createAdapter(pub, sub, { key: 'telus-realtime' });
  }

  override createIOServer(port: number, options?: ServerOptions) {
    const server: Server = super.createIOServer(port, {
      ...options,
      cors: { origin: this.origins, credentials: false },
      transports: ['websocket'],
      maxHttpBufferSize: 16 * 1024,
      pingInterval: 20_000,
      pingTimeout: 20_000,
    });
    if (this.redisAdapter) server.adapter(this.redisAdapter);
    return server;
  }

  override async close(server: Server): Promise<void> {
    await super.close(server);
    await Promise.allSettled(this.redisClients.map((c) => c.quit()));
    this.redisClients = [];
  }
}
