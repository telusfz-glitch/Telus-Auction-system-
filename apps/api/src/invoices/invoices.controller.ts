import { Body, Controller, Get, HttpCode, Ip, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { CUSTOMER_ROLES, STAFF_ROLES, SettleInvoiceSchema, type SettleInvoiceInput } from '@telus/shared';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod.pipe';
import { InvoicesService } from './invoices.service';

@Controller()
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get('invoices') @Roles(...CUSTOMER_ROLES)
  mine(@CurrentPrincipal() p: Principal) { return this.invoices.list(p); }

  @Get('admin/invoices') @Roles(...STAFF_ROLES)
  all(@CurrentPrincipal() p: Principal, @Query('status') status?: string) { return this.invoices.list(p, status); }

  @Post('admin/invoices/:id/settle') @HttpCode(200) @Roles('super_admin', 'finance')
  settle(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(SettleInvoiceSchema)) b: SettleInvoiceInput, @Ip() ip: string) {
    return this.invoices.settle(p, id, b, ip);
  }
}
