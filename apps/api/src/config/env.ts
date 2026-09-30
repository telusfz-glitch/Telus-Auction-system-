import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  // Staff tokens must show one of these authentication methods (token `amr` claim). Empty = no check (never in production).
  STAFF_MFA_AMR: z.string().default('otp'),
  // Connections per API instance. Keep instances × DB_POOL_MAX below Postgres max_connections.
  DB_POOL_MAX: z.coerce.number().int().min(2).max(500).default(20),
  DATABASE_URL: z.string().url(),
  KEYCLOAK_ISSUER: z.string().url(),
  KEYCLOAK_JWKS_URI: z.string().url().optional(),
  API_AUDIENCE: z.string().min(1).default('telus-api'),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  /** Shared with the web app only. When a request carries it, the API records the end user's address that the web app
   *  forwards (x-telus-client-ip) instead of the web server's own. Unset ⇒ the header is ignored. */
  CLIENT_IP_FORWARD_SECRET: z.string().min(32).optional(),
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
  // How new logins get their first credential: a temporary password shown once to the inviter, or a Keycloak email
  // link (needs the realm's SMTP settings). Links expire after TEAM_INVITE_LIFESPAN_SECONDS.
  TEAM_INVITE_METHOD: z.enum(['password', 'email']).default('password'),
  TEAM_INVITE_LIFESPAN_SECONDS: z.coerce.number().int().min(300).max(7 * 86400).default(86400),
  // Card payments (Stripe Checkout, hosted page). Both set ⇒ enabled; otherwise card payment answers 503.
  STRIPE_SECRET_KEY: z.string().regex(/^(sk|rk)_(test|live)_/).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().regex(/^whsec_/).optional(),
  STRIPE_API_URL: z.string().url().optional(),   // tests only: a local stand-in for api.stripe.com
  // Prometheus scrape token for GET /metrics (sent as a bearer token). Unset ⇒ /metrics answers 404.
  METRICS_TOKEN: z.string().min(32).optional(),
  // Rate limits shared by all instances when set (falls back to REDIS_URL, then to in-memory).
  RATE_LIMIT_REDIS_URL: z.string().url().optional(),
  // Requests per minute per route, per signed-in user (anonymous requests: per client address). Some routes set their own.
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  // Audit shipping to write-once storage (S3 Object Lock). Unset bucket ⇒ not shipped. The bucket must have Object Lock
  // enabled; credentials come from the AWS default chain. AUDIT_SHIP_ENDPOINT is for S3-compatible stores.
  AUDIT_SHIP_BUCKET: z.string().min(3).optional(),
  AUDIT_SHIP_PREFIX: z.string().regex(/^([A-Za-z0-9._-]+\/)*$/).default('audit/'),
  AUDIT_SHIP_REGION: z.string().min(1).default('us-east-1'),
  AUDIT_SHIP_ENDPOINT: z.string().url().optional(),
  AUDIT_SHIP_RETENTION_DAYS: z.coerce.number().int().min(1).max(36500).default(2557),   // ~7 years
  AUDIT_SHIP_INTERVAL_MS: z.coerce.number().int().min(1000).max(86_400_000).default(60_000),
  AUDIT_SHIP_BATCH: z.coerce.number().int().min(1).max(10000).default(5000),
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
