import { Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { CUSTOMER_ROLES } from '@telus/shared';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentPrincipal, Public, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { PaymentsService } from './payments.service';

@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** Whether online card payment is configured (the web app shows the button only then). */
  @Get('payments/options') @Roles(...CUSTOMER_ROLES)
  options() { return { card: this.payments.enabled }; }

  /** Returns the hosted checkout URL; the web app sends the browser there. */
  @Post('invoices/:id/pay') @HttpCode(200) @Roles('customer_admin') @Throttle({ default: { limit: 10, ttl: 60_000 } })
  pay(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.payments.start(p, id); }

  /** Called by the provider, not by users: authenticated by its signature over the raw body. */
  @Public() @SkipThrottle() @Post('payments/stripe/webhook') @HttpCode(200)
  webhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') sig?: string) {
    return this.payments.webhook(req.rawBody, sig);
  }
}
