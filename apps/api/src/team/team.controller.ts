import { Body, Controller, Get, Ip, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  CUSTOMER_ROLES, CreateTeamUserSchema, STAFF_ROLES, UpdateTeamUserSchema, type CreateTeamUserInput, type UpdateTeamUserInput,
} from '@telus/shared';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod.pipe';
import { TeamService } from './team.service';

const MANAGERS = ['super_admin', 'auction_manager'];
const Id = new ParseUUIDPipe();

@Controller()
export class TeamController {
  constructor(private readonly team: TeamService) {}

  // ---------------- customer admins: their own company ----------------
  @Get('team') @Roles(...CUSTOMER_ROLES)
  list(@CurrentPrincipal() p: Principal) { return this.team.list(p); }

  @Post('team') @Roles('customer_admin') @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  create(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(CreateTeamUserSchema)) b: CreateTeamUserInput, @Ip() ip: string) {
    return this.team.create(p, b, undefined, ip);
  }

  @Patch('team/:id') @Roles('customer_admin')
  update(@CurrentPrincipal() p: Principal, @Param('id', Id) id: string, @Body(new ZodValidationPipe(UpdateTeamUserSchema)) b: UpdateTeamUserInput, @Ip() ip: string) {
    return this.team.update(p, id, b, ip);
  }

  // ---------------- staff: any customer (e.g. the first administrator) ----------------
  @Get('admin/customers/:customerId/users') @Roles(...STAFF_ROLES)
  staffList(@CurrentPrincipal() p: Principal, @Param('customerId', Id) customerId: string) { return this.team.list(p, customerId); }

  @Post('admin/customers/:customerId/users') @Roles(...MANAGERS)
  staffCreate(@CurrentPrincipal() p: Principal, @Param('customerId', Id) customerId: string,
    @Body(new ZodValidationPipe(CreateTeamUserSchema)) b: CreateTeamUserInput, @Ip() ip: string) {
    return this.team.create(p, b, customerId, ip);
  }

  @Patch('admin/customer-users/:id') @Roles(...MANAGERS)
  staffUpdate(@CurrentPrincipal() p: Principal, @Param('id', Id) id: string, @Body(new ZodValidationPipe(UpdateTeamUserSchema)) b: UpdateTeamUserInput, @Ip() ip: string) {
    return this.team.update(p, id, b, ip);
  }
}
