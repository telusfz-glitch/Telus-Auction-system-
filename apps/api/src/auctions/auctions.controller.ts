import { Controller, Get, HttpCode, Ip, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AUCTION_MANAGERS, CUSTOMER_BIDDERS, CUSTOMER_ROLES, STAFF_ROLES } from '@telus/shared';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { AuctionsService } from './auctions.service';

@Controller()
export class AuctionsController {
  constructor(private readonly auctions: AuctionsService) {}

  @Get('auctions')
  @Roles(...CUSTOMER_ROLES)
  list(@CurrentPrincipal() p: Principal) {
    return this.auctions.listForCustomer(p);
  }

  @Get('auctions/:id')
  @Roles(...CUSTOMER_ROLES)
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.auctions.getForCustomer(p, id);
  }

  // Viewers cannot bid, so they cannot accept terms either (the database policy enforces the same).
  @Post('auctions/:id/accept-terms')
  @HttpCode(200)
  @Roles(...CUSTOMER_BIDDERS)
  acceptTerms(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Ip() ip: string) {
    return this.auctions.acceptTerms(p, id, ip);
  }

  @Get('auctions/:id/my-results')
  @Roles(...CUSTOMER_ROLES)
  myResults(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.auctions.myResults(p, id);
  }

  @Get('admin/auctions/:id/results')
  @Roles(...STAFF_ROLES)
  results(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.auctions.results(p, id);
  }

  @Post('admin/auctions/:id/finalize')
  @HttpCode(200)
  @Roles(...AUCTION_MANAGERS)
  finalize(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Ip() ip: string) {
    return this.auctions.finalize(p, id, ip);
  }
}
