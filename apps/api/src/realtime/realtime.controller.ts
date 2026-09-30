import { Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Authenticated, CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ApiError } from '../common/api-error';
import { TicketService } from './ticket.service';

// Not under /realtime: Socket.IO owns every HTTP path with that prefix.
@Controller()
export class RealtimeController {
  constructor(private readonly tickets: TicketService) {}

  /** Called by the web SERVER (holding the user's token) to get a one-time socket ticket for the browser. */
  @Post('socket-tickets')
  @HttpCode(201)
  @Authenticated()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  issue(@CurrentPrincipal() p: Principal) {
    if (!p.tokenExp) throw new ApiError('TOKEN_EXPIRING', 'Token has no expiry.', 401);
    const { tokenExp, ...principal } = p;
    return this.tickets.issue(principal, tokenExp);
  }
}
