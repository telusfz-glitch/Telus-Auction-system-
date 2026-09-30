import 'server-only';
import { z } from 'zod';

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Public base URL of this web app, e.g. https://auction.telus.ae (used for the OIDC redirect URI). */
  WEB_URL: z.string().url(),
  OIDC_ISSUER: z.string().url(),
  OIDC_CLIENT_ID: z.string().min(1).default('telus-web'),
  OIDC_CLIENT_SECRET: z.string().min(16),
  /** API base URL as reached from THIS server (may be an internal hostname). */
  API_URL: z.string().url(),
  /** API origin as reached from the BROWSER — used only for the realtime socket. */
  API_PUBLIC_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  /** Encrypts session records at rest in Redis. 32+ random characters. */
  SESSION_SECRET: z.string().min(32),
  DISPLAY_TIMEZONE: z.string().default('Asia/Dubai'),
  /** Shared with the API only: lets the API record the end user's address instead of this server's (see api.ts). */
  CLIENT_IP_FORWARD_SECRET: z.string().min(32).optional(),
  /** Local end-to-end testing of the production build over plain http. Never set this on a real deployment. */
  ALLOW_HTTP_FOR_LOCAL_TESTING: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});
export type WebEnv = z.infer<typeof Schema>;

let cached: WebEnv | undefined;

/** Fails fast with field NAMES only — never values (they may be secrets). */
export function env(): WebEnv {
  if (cached) return cached;
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) throw new Error('Invalid web configuration: ' + Object.keys(parsed.error.flatten().fieldErrors).join(', '));
  const e = parsed.data;
  if (e.ALLOW_HTTP_FOR_LOCAL_TESTING) {
    console.warn('[config] ALLOW_HTTP_FOR_LOCAL_TESTING is on: plain-http URLs accepted. Never use this in a real deployment.');
  } else if (e.NODE_ENV === 'production') {
    for (const k of ['WEB_URL', 'OIDC_ISSUER', 'API_PUBLIC_URL'] as const) {
      if (!e[k].startsWith('https://')) throw new Error(`${k} must be https in production`);
    }
  }
  cached = e;
  return e;
}

export const isSecureOrigin = () => env().WEB_URL.startsWith('https://');
