import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/** The throttler reads HTTP request/response objects, so it only applies to HTTP. Sockets are limited in the
 *  gateway instead (one authenticated handshake per connection, capped subscriptions per socket). */
@Injectable()
export class HttpThrottlerGuard extends ThrottlerGuard {
  protected override async shouldSkip(ctx: ExecutionContext): Promise<boolean> {
    return ctx.getType() !== 'http';
  }
}
