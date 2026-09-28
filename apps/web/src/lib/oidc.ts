import 'server-only';
import * as client from 'openid-client';
import { env } from './env';

const g = globalThis as unknown as { __telusOidc?: Promise<client.Configuration> };

/** Discovered once per process. Plain-http issuers are accepted only outside production or when explicitly allowed for local testing. */
export function oidc(): Promise<client.Configuration> {
  if (!g.__telusOidc) {
    const e = env();
    const insecure = (e.NODE_ENV !== 'production' || e.ALLOW_HTTP_FOR_LOCAL_TESTING) && e.OIDC_ISSUER.startsWith('http://');
    g.__telusOidc = client
      .discovery(new URL(e.OIDC_ISSUER), e.OIDC_CLIENT_ID, undefined, client.ClientSecretBasic(e.OIDC_CLIENT_SECRET),
        insecure ? { execute: [client.allowInsecureRequests] } : undefined)
      .catch((err) => { g.__telusOidc = undefined; throw err; });
  }
  return g.__telusOidc;
}

export const redirectUri = () => `${env().WEB_URL}/auth/callback`;
export { client };
