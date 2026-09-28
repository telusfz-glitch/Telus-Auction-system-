import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { CUSTOMER_ROLES } from '@telus/shared';
import type { KeyLike } from 'jose';
import request from 'supertest';
import { Authenticated, CurrentPrincipal, Public, Roles } from '../src/auth/decorators';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import type { Principal } from '../src/auth/principal';
import { RolesGuard } from '../src/auth/roles.guard';
import { TokenVerifier } from '../src/auth/token-verifier';
import { AUD, ISS, customerClaims, makeKeys, signToken, staffClaims } from './helpers';

@Controller('t')
class TestController {
  @Public() @Get('public') pub() { return { ok: true }; }
  @Get('undecorated') undecorated() { return { ok: true }; } // developer forgot a role decorator
  @Authenticated() @Get('any') any(@CurrentPrincipal() p: Principal) { return { kind: p.kind }; }
  @Roles('finance') @Get('finance') fin() { return { ok: true }; }
  @Roles(...CUSTOMER_ROLES) @Get('customer') cust() { return { ok: true }; }
}

describe('Global guards — authentication and deny-by-default authorization', () => {
  let app: INestApplication, priv: KeyLike;
  beforeAll(async () => {
    const { privateKey, publicKey } = await makeKeys();
    priv = privateKey;
    const verifier = new TokenVerifier({ issuer: ISS, audience: AUD, getKey: async () => publicKey });
    const mod = await Test.createTestingModule({
      controllers: [TestController],
      providers: [
        { provide: TokenVerifier, useValue: verifier },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());

  const get = (path: string, token?: string) => {
    const r = request(app.getHttpServer()).get(path);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };

  it('public route needs no token', () => get('/t/public').expect(200));
  it('protected route without token → 401', () => get('/t/any').expect(401));
  it('garbage bearer token → 401', () => get('/t/any', 'garbage').expect(401));
  it('non-bearer scheme → 401', () => request(app.getHttpServer()).get('/t/any').set('Authorization', 'Basic YWRtaW46YWRtaW4=').expect(401));
  it('oversized token → 401', () => get('/t/any', 'a'.repeat(9000)).expect(401));

  it('route with no role decorator is FORBIDDEN even for a super_admin (deny by default)', async () => {
    await get('/t/undecorated', await signToken(priv, staffClaims('super_admin'))).expect(403);
  });
  it('wrong staff role → 403', async () => { await get('/t/finance', await signToken(priv, staffClaims('auction_manager'))).expect(403); });
  it('right staff role → 200', async () => { await get('/t/finance', await signToken(priv, staffClaims('finance'))).expect(200); });
  it('customer token cannot reach a staff route → 403', async () => { await get('/t/finance', await signToken(priv, customerClaims('customer_admin'))).expect(403); });
  it('staff token cannot reach a customer route → 403', async () => { await get('/t/customer', await signToken(priv, staffClaims('super_admin'))).expect(403); });
  it('authentic token but mixed roles → 403 (not 401)', async () => {
    await get('/t/any', await signToken(priv, { realm_access: { roles: ['finance', 'customer_admin'] }, customer_id: '11111111-1111-4111-8111-111111111111' })).expect(403);
  });
  it('error bodies contain no internals', async () => {
    const res = await get('/t/any', 'garbage').expect(401);
    expect(JSON.stringify(res.body)).not.toMatch(/jose|signature|stack|JWS|JWT/i);
  });
});
