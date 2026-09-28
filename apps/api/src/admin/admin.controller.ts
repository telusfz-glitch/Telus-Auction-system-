import { Body, Controller, Delete, Get, HttpCode, Ip, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import {
  BracketsSchema, CreateAuctionSchema, CreateLotsSchema, CreateMarginRuleSetSchema, InviteCustomersSchema, STAFF_ROLES,
  SetCustomerLimitSchema, UpdateAuctionSchema, UpdateCustomerSchema, UpdateLotSchema, UpdateSecuritySettingsSchema,
  type BracketsInput, type CreateAuctionInput, type CreateLotsInput, type CreateMarginRuleSetInput, type InviteCustomersInput,
  type SetCustomerLimitInput, type UpdateAuctionInput, type UpdateCustomerInput, type UpdateLotInput, type UpdateSecuritySettingsInput,
} from '@telus/shared';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod.pipe';
import { AdminAuctionsService } from './admin-auctions.service';
import { AdminSettingsService } from './admin-settings.service';

/** Who may do what. Reads are open to every staff role; writes are narrow. */
const MANAGERS = ['super_admin', 'auction_manager'];
const LIMIT_SETTERS = ['super_admin', 'finance'];
const SECURITY_ADMINS = ['super_admin'];
const Id = new ParseUUIDPipe();

@Controller('admin')
export class AdminController {
  constructor(private readonly auctions: AdminAuctionsService, private readonly settings: AdminSettingsService) {}

  // ---------------- auctions ----------------
  @Get('auctions') @Roles(...STAFF_ROLES)
  list(@CurrentPrincipal() p: Principal) { return this.auctions.list(p); }

  @Get('auctions/:id') @Roles(...STAFF_ROLES)
  get(@CurrentPrincipal() p: Principal, @Param('id', Id) id: string) { return this.auctions.get(p, id); }

  @Post('auctions') @Roles(...MANAGERS)
  create(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(CreateAuctionSchema)) b: CreateAuctionInput, @Ip() ip: string) {
    return this.auctions.create(p, b, ip);
  }

  @Patch('auctions/:id') @Roles(...MANAGERS)
  update(@CurrentPrincipal() p: Principal, @Param('id', Id) id: string, @Body(new ZodValidationPipe(UpdateAuctionSchema)) b: UpdateAuctionInput, @Ip() ip: string) {
    return this.auctions.update(p, id, b, ip);
  }

  @Post('auctions/:id/schedule') @HttpCode(200) @Roles(...MANAGERS)
  schedule(@CurrentPrincipal() p: Principal, @Param('id', Id) id: string, @Ip() ip: string) { return this.auctions.schedule(p, id, ip); }

  @Post('auctions/:id/unschedule') @HttpCode(200) @Roles(...MANAGERS)
  unschedule(@CurrentPrincipal() p: Principal, @Param('id', Id) id: string, @Ip() ip: string) { return this.auctions.unschedule(p, id, ip); }

  @Post('auctions/:id/cancel') @HttpCode(200) @Roles(...MANAGERS)
  cancel(@CurrentPrincipal() p: Principal, @Param('id', Id) id: string, @Ip() ip: string) { return this.auctions.cancel(p, id, ip); }

  // ---------------- lots ----------------
  @Post('auctions/:id/lots') @Roles(...MANAGERS)
  addLots(@CurrentPrincipal() p: Principal, @Param('id', Id) id: string, @Body(new ZodValidationPipe(CreateLotsSchema)) b: CreateLotsInput, @Ip() ip: string) {
    return this.auctions.addLots(p, id, b, ip);
  }

  @Patch('lots/:id') @Roles(...MANAGERS)
  updateLot(@CurrentPrincipal() p: Principal, @Param('id', Id) id: string, @Body(new ZodValidationPipe(UpdateLotSchema)) b: UpdateLotInput, @Ip() ip: string) {
    return this.auctions.updateLot(p, id, b, ip);
  }

  @Delete('lots/:id') @Roles(...MANAGERS)
  deleteLot(@CurrentPrincipal() p: Principal, @Param('id', Id) id: string, @Ip() ip: string) { return this.auctions.deleteLot(p, id, ip); }

  @Post('lots/:id/withdraw') @HttpCode(200) @Roles(...MANAGERS)
  withdrawLot(@CurrentPrincipal() p: Principal, @Param('id', Id) id: string, @Ip() ip: string) { return this.auctions.withdrawLot(p, id, ip); }

  // ---------------- invitations ----------------
  @Post('auctions/:id/participants') @HttpCode(200) @Roles(...MANAGERS)
  invite(@CurrentPrincipal() p: Principal, @Param('id', Id) id: string, @Body(new ZodValidationPipe(InviteCustomersSchema)) b: InviteCustomersInput, @Ip() ip: string) {
    return this.auctions.invite(p, id, b, ip);
  }

  @Delete('auctions/:id/participants/:customerId') @Roles(...MANAGERS)
  revoke(@CurrentPrincipal() p: Principal, @Param('id', Id) id: string, @Param('customerId', Id) customerId: string, @Ip() ip: string) {
    return this.auctions.revoke(p, id, customerId, ip);
  }

  // ---------------- customers ----------------
  @Patch('customers/:id') @Roles(...MANAGERS)
  updateCustomer(@CurrentPrincipal() p: Principal, @Param('id', Id) id: string, @Body(new ZodValidationPipe(UpdateCustomerSchema)) b: UpdateCustomerInput, @Ip() ip: string) {
    return this.settings.updateCustomer(p, id, b, ip);
  }

  @Put('customers/:id/limits') @Roles(...LIMIT_SETTERS)
  setLimit(@CurrentPrincipal() p: Principal, @Param('id', Id) id: string, @Body(new ZodValidationPipe(SetCustomerLimitSchema)) b: SetCustomerLimitInput, @Ip() ip: string) {
    return this.settings.setLimit(p, id, b, ip);
  }

  // ---------------- margin rules ----------------
  @Get('margin-rule-sets') @Roles(...STAFF_ROLES)
  ruleSets(@CurrentPrincipal() p: Principal) { return this.settings.listRuleSets(p); }

  @Post('margin-rule-sets') @Roles(...MANAGERS)
  createRuleSet(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(CreateMarginRuleSetSchema)) b: CreateMarginRuleSetInput, @Ip() ip: string) {
    return this.settings.createRuleSet(p, b, ip);
  }

  @Put('margin-rule-sets/:id/brackets') @Roles(...MANAGERS)
  replaceBrackets(@CurrentPrincipal() p: Principal, @Param('id', Id) id: string, @Body(new ZodValidationPipe(BracketsSchema)) b: BracketsInput, @Ip() ip: string) {
    return this.settings.replaceBrackets(p, id, b, ip);
  }

  // ---------------- security settings ----------------
  @Get('security-settings') @Roles(...STAFF_ROLES)
  security(@CurrentPrincipal() p: Principal) { return this.settings.getSecurity(p); }

  @Patch('security-settings') @Roles(...SECURITY_ADMINS)
  updateSecurity(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(UpdateSecuritySettingsSchema)) b: UpdateSecuritySettingsInput, @Ip() ip: string) {
    return this.settings.updateSecurity(p, b, ip);
  }
}
