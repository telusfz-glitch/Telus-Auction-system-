import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Principal } from '../auth/principal';
import { ApiError } from '../common/api-error';
import type { Env } from '../config/env';
import { ENV } from '../config/tokens';
import { DbService } from '../db/db.service';

const ISSUER = 'telus-api';
const AUDIENCE = 'telus-realtime-ticket';
const TTL_SECONDS = 30;

export interface TicketClaims { principal: Principal; tokenExp: number }

/**
 * Socket tickets: what a browser presents instead of an access token. HS256 with a secret used for nothing else,
 * a distinct issuer/audience, 30-second lifetime, and single use (enforced in the database, so it holds across
 * instances). The ticket carries the verified principal and the expiry of the access token it was minted from:
 * the socket is disconnected at that time, exactly as if the token itself had been presented.
 */
@Injectable()
export class TicketService {
  private readonly key: Uint8Array | null;

  constructor(@Inject(ENV) env: Env, private readonly db: DbService) {
    this.key = env.REALTIME_TICKET_SECRET ? new TextEncoder().encode(env.REALTIME_TICKET_SECRET) : null;
  }

  get enabled(): boolean { return this.key !== null; }

  async issue(principal: Principal, tokenExp: number): Promise<{ ticket: string; expiresIn: number }> {
    if (!this.key) throw new ApiError('TICKETS_DISABLED', 'Realtime tickets are not configured.', 503);
    const ttl = Math.min(TTL_SECONDS, Math.max(0, tokenExp - Math.floor(Date.now() / 1000)));
    if (ttl <= 0) throw new ApiError('TOKEN_EXPIRING', 'Your session is about to expire. Please retry.', 401);
    const ticket = await new SignJWT({ p: principal, tex: tokenExp })
      .setProtectedHeader({ alg: 'HS256', typ: 'telus-ticket' })
      .setIssuer(ISSUER).setAudience(AUDIENCE).setSubject(principal.sub)
      .setJti(randomUUID()).setIssuedAt().setExpirationTime(`${ttl}s`)
      .sign(this.key);
    return { ticket, expiresIn: ttl };
  }

  /** Throws on anything wrong: bad signature, expired, wrong issuer/audience/alg, or already used. */
  async redeem(ticket: string): Promise<TicketClaims> {
    if (!this.key) throw new Error('tickets disabled');
    const { payload } = await jwtVerify(ticket, this.key, {
      issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'], typ: 'telus-ticket', requiredClaims: ['exp', 'jti', 'sub'],
    });
    const fresh = await this.db.withSystem('realtime', async (c) =>
      (await c.query('SELECT realtime_ticket_consume($1, to_timestamp($2)) AS ok', [payload.jti, payload.exp])).rows[0].ok as boolean);
    if (!fresh) throw new Error('ticket already used');
    return { principal: payload['p'] as Principal, tokenExp: payload['tex'] as number };
  }
}
