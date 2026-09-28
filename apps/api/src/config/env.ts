import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().url(),
  KEYCLOAK_ISSUER: z.string().url(),
  KEYCLOAK_JWKS_URI: z.string().url().optional(),
  API_AUDIENCE: z.string().min(1).default('telus-api'),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  // Background loops (auction scheduler, outbox → realtime publisher). Off only for tooling/tests.
  WORKERS_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  OUTBOX_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(250),
  OUTBOX_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  // Set when running more than one API instance: Socket.IO rooms are then shared through Redis.
  REDIS_URL: z.string().url().optional(),
  // Enables POST /realtime/tickets (browser sockets without access tokens). Used for nothing else.
  REALTIME_TICKET_SECRET: z.string().min(32).optional(),
  // Customer team logins (Keycloak Admin API, service account `telus-api-admin`). Unset ⇒ team endpoints return 503.
  KEYCLOAK_ADMIN_CLIENT_ID: z.string().min(1).default('telus-api-admin'),
  KEYCLOAK_ADMIN_CLIENT_SECRET: z.string().min(16).optional(),
  // Required actions for new customer logins. Production keeps TOTP enrolment.
  TEAM_USER_REQUIRED_ACTIONS: z.string().default('UPDATE_PASSWORD,CONFIGURE_TOTP'),
  // Rate limits shared by all instances when set (falls back to REDIS_URL, then to in-memory).
  RATE_LIMIT_REDIS_URL: z.string().url().optional(),
  // Notification emails (outbid, results, cancellations, invoices). Unset SMTP_URL ⇒ emails stay queued, none sent.
  // e.g. smtps://user:pass@smtp.example.com:465 — the password is never logged.
  SMTP_URL: z.string().url().optional(),
  MAIL_FROM: z.string().min(3).default('TELUS Auctions <no-reply@auctions.telus.ae>'),
  /** Public web-app URL used for links in emails (e.g. https://auction.telus.ae). */
  PUBLIC_WEB_URL: z.string().url().optional(),
  DISPLAY_TIMEZONE: z.string().default('Asia/Dubai'),
  EMAIL_INTERVAL_MS: z.coerce.number().int().min(200).max(600_000).default(2000),
});
export type Env = z.infer<typeof EnvSchema>;

/** Fails fast at boot. Error text lists field NAMES only — never values (they may be secrets). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error('Invalid environment configuration: ' + Object.keys(parsed.error.flatten().fieldErrors).join(', '));
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.KEYCLOAK_ISSUER.startsWith('https://')) {
    throw new Error('KEYCLOAK_ISSUER must be https in production');
  }
  return parsed.data;
}
