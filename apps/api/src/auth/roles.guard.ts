import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ANY_AUTHENTICATED, IS_PUBLIC, ROLES_KEY } from './decorators';

/** Deny-by-default: a non-public route with NO role decorator is forbidden for everyone.
 *  A developer forgetting to annotate a new endpoint fails closed instead of open. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const principal = ctx.switchToHttp().getRequest().principal;
    if (!principal) throw new UnauthorizedException();

    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required || required.length === 0) throw new ForbiddenException();
    if (required.includes(ANY_AUTHENTICATED)) return true;
    if (principal.roles.some((r: string) => required.includes(r))) return true;
    throw new ForbiddenException();
  }
}
