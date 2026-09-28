import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
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
  app.enableCors({
    origin: env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key'],
    maxAge: 600,
  });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
}
