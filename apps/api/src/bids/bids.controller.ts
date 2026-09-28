import { Body, Controller, Get, Ip, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CUSTOMER_ROLES, PlaceBidSchema, type PlaceBidInput } from '@telus/shared';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod.pipe';
import { BidsService } from './bids.service';

@Controller()
export class BidsController {
  constructor(private readonly bids: BidsService) {}

  // Viewers are rejected by the guard; the service and Postgres RLS re-check independently.
  @Post('bids')
  @Roles('customer_admin', 'customer_bidder')
  @Throttle({ default: { limit: 20, ttl: 10_000 } })
  place(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(PlaceBidSchema)) body: PlaceBidInput, @Ip() ip: string) {
    return this.bids.place(p, body, ip);
  }

  @Get('lots/:lotId/my-status')
  @Roles(...CUSTOMER_ROLES)
  myStatus(@CurrentPrincipal() p: Principal, @Param('lotId', ParseUUIDPipe) lotId: string) {
    return this.bids.myStatus(p, lotId);
  }
}
