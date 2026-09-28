import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenVerifier } from '../src/auth/token-verifier';
import { configureApp } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';
import { AUD, ISS, customerClaims, makeKeys, signToken } from './helpers';

/**
 * Every request here comes from the same address, exactly like production traffic relayed by the web app (the BFF).
 * Limits must still be per signed-in user, or one busy bidder would lock every other customer out.
 */
describe('Rate limits — per signed-in user, not per client address', () => {
  let app: INestApplication;
  let tok: (sub: string) => Promise<string>;
  const LIMIT = 5;
  const http = () => request(app.getHttpServer());
  const me = (t?: string) => (t ? http().get('/me').set('Authorization', `Bearer ${t}`) : http().get('/me')).then((r) => r.status);

  beforeAll(async () => {
    const keys = await makeKeys();
    tok = (sub) => signToken(keys.privateKey, customerClaims('customer_bidder'), { sub });
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgres://u:p@127.0.0.1:1/none', KEYCLOAK_ISSUER: ISS, API_AUDIENCE: AUD,
      CORS_ORIGINS: 'https://auction.telus.ae', WORKERS_ENABLED: 'false', RATE_LIMIT_PER_MINUTE: String(LIMIT),
    });
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier).useValue(new TokenVerifier({ issuer: ISS, audience: AUD, getKey: async () => keys.publicKey }))
      .compile();
    app = mod.createNestApplication();
    await configureApp(app, loadEnv());
    await app.init();
  });
  afterAll(async () => { await app.close(); delete process.env.RATE_LIMIT_PER_MINUTE; });

  it('one user exhausting their limit does not affect another user behind the same address', async () => {
    const [a, b] = await Promise.all([tok('rl-user-a'), tok('rl-user-b')]);
    const codesA: number[] = [];
    for (let i = 0; i < LIMIT + 2; i++) codesA.push(await me(a));
    expect(codesA).toEqual([...Array(LIMIT).fill(200), 429, 429]);
    expect(await me(b)).toBe(200);
    // A fresh token for the same user is the same user: no new quota by re-signing in.
    expect(await me(await tok('rl-user-a'))).toBe(429);
  });

  it('bad tokens are refused before counting, so they cannot burn a real user\'s quota', async () => {
    const c = await tok('rl-user-c');
    for (let i = 0; i < LIMIT * 2; i++) expect(await me('forged.' + c.split('.').slice(1).join('.'))).toBe(401);
    expect(await me(c)).toBe(200);
  });

  it('anonymous requests are limited per address', async () => {
    const codes: number[] = [];
    for (let i = 0; i < LIMIT + 1; i++) codes.push(await http().get('/health').then((r) => r.status));
    expect(codes.at(-1)).toBe(429);
  });
});
