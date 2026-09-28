import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';

describe('Full app wiring — real AppModule + real security configuration', () => {
  let app: INestApplication;
  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgres://u:p@127.0.0.1:1/none', KEYCLOAK_ISSUER: 'http://localhost:8080/realms/telus',
      API_AUDIENCE: 'telus-api', CORS_ORIGINS: 'https://auction.telus.ae',
    });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, loadEnv());
    await app.init();
  });
  afterAll(() => app.close());
  const http = () => request(app.getHttpServer());

  it('/health is public and carries hardened headers', async () => {
    const res = await http().get('/health').expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['strict-transport-security']).toMatch(/max-age=63072000/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it.each([['GET', '/me'], ['GET', '/customers/me'], ['GET', '/admin/customers'], ['POST', '/admin/customers'], ['POST', '/bids'], ['GET', '/lots/aaaaaaaa-0000-4000-8000-000000000201/my-status']])(
    '%s %s without a token → 401', async (method, path) => {
      const res = await (http() as any)[method.toLowerCase()](path).expect(401);
      expect(JSON.stringify(res.body)).not.toMatch(/stack|jose|at .*\.ts/i);
    });

  it('a forged token → 401', () => http().get('/admin/customers').set('Authorization', 'Bearer eyJhbGciOiJub25lIn0.e30.').expect(401));

  it('CORS: unknown origin gets no allow header; configured origin does', async () => {
    const bad = await http().get('/health').set('Origin', 'https://evil.example');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    const good = await http().get('/health').set('Origin', 'https://auction.telus.ae');
    expect(good.headers['access-control-allow-origin']).toBe('https://auction.telus.ae');
  });
});

describe('loadEnv', () => {
  const base = { DATABASE_URL: 'postgres://u:p@h/db', KEYCLOAK_ISSUER: 'https://kc.example/realms/telus' };
  it('rejects missing config without echoing values', () => {
    expect(() => loadEnv({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
    try { loadEnv({ DATABASE_URL: 'not-a-url-secret-xyz' } as NodeJS.ProcessEnv); } catch (e) { expect(String(e)).not.toContain('secret-xyz'); }
  });
  it('refuses a non-https issuer in production', () => {
    expect(() => loadEnv({ ...base, KEYCLOAK_ISSUER: 'http://kc.example/realms/telus', NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/https/);
  });
});
