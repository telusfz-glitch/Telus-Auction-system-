import { Controller, Get } from '@nestjs/common';
import { Authenticated, CurrentPrincipal, Public } from './auth/decorators';
import type { Principal } from './auth/principal';

@Controller()
export class AppController {
  @Public()
  @Get('health')
  health() {
    return { ok: true };
  }

  @Authenticated()
  @Get('me')
  me(@CurrentPrincipal() p: Principal) {
    return { sub: p.sub, username: p.username, kind: p.kind, roles: p.roles, customerId: p.customerId };
  }
}
