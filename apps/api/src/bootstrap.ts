import type { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import helmet from 'helmet';
import type { ServerOptions } from 'socket.io';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import type { Env } from './config/env';

/** Shared by main.ts and the e2e tests, so tests exercise the real security configuration. */
export function configureApp(app: INestApplication, env: Env): void {
  const server = app.getHttpAdapter().getInstance();
  server.disable('x-powered-by');
  server.set('trust proxy', env.TRUST_PROXY);

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
  app.useWebSocketAdapter(new SecureIoAdapter(app, origins));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
}

/** Socket.IO with the same origin allow-list as HTTP, small frames, and no long-polling downgrade path. */
class SecureIoAdapter extends IoAdapter {
  constructor(app: INestApplication, private readonly origins: string[]) {
    super(app);
  }
  override createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.origins, credentials: false },
      transports: ['websocket'],
      maxHttpBufferSize: 16 * 1024,
      pingInterval: 20_000,
      pingTimeout: 20_000,
    });
  }
}
