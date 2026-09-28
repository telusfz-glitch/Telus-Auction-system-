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
