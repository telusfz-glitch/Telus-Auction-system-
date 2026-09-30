import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Principal } from './principal';

/**
 * HTTP rate limits, per route. Runs AFTER authentication (see app.module.ts), so an authenticated request is counted
 * against the signed-in user, not the client address: the web app calls the API server-to-server, so keying on the
 * address would put every customer in one shared bucket. Only anonymous requests (public routes) are keyed by address.
 * Requests with a bad token never get here (401 first); floods of those are for the edge proxy / WAF to absorb.
 * The throttler reads HTTP request/response objects, so it only applies to HTTP. Sockets are limited in the gateway
 * instead (one authenticated handshake per connection, capped subscriptions per socket).
 */
@Injectable()
export class HttpThrottlerGuard extends ThrottlerGuard {
  protected override async shouldSkip(ctx: ExecutionContext): Promise<boolean> {
    return ctx.getType() !== 'http';
  }

  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const p = req['principal'] as Principal | undefined;
    return p ? `user:${p.sub}` : `ip:${req['ip']}`;
  }
}
