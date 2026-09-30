import { Body, Controller, Get, Ip, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CUSTOMER_BIDDERS, CUSTOMER_ROLES, PlaceBidSchema, type PlaceBidInput } from '@telus/shared';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod.pipe';
import { MetricsService } from '../ops/metrics.service';
import { BidsService } from './bids.service';

@Controller()
export class BidsController {
  constructor(private readonly bids: BidsService, private readonly metrics: MetricsService) {}

  // Viewers are rejected by the guard; the service and Postgres RLS re-check independently.
  @Post('bids')
  @Roles(...CUSTOMER_BIDDERS)
  @Throttle({ default: { limit: 20, ttl: 10_000 } })
  async place(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(PlaceBidSchema)) body: PlaceBidInput, @Ip() ip: string) {
    const t0 = process.hrtime.bigint();
    const seconds = () => Number(process.hrtime.bigint() - t0) / 1e9;
    try {
      const r = await this.bids.place(p, body, ip);
      this.metrics.recordBid('accepted', seconds());
      return r;
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      this.metrics.recordBid(typeof code === 'string' ? code : 'error', seconds());
      throw e;
    }
  }

  @Get('auctions/:auctionId/my-positions')
  @Roles(...CUSTOMER_ROLES)
  myPositions(@CurrentPrincipal() p: Principal, @Param('auctionId', ParseUUIDPipe) auctionId: string) {
    return this.bids.myPositions(p, auctionId);
  }

  @Get('lots/:lotId/my-status')
  @Roles(...CUSTOMER_ROLES)
  myStatus(@CurrentPrincipal() p: Principal, @Param('lotId', ParseUUIDPipe) lotId: string) {
    return this.bids.myStatus(p, lotId);
  }
}
