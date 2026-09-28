import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Principal } from './principal';

export const IS_PUBLIC = 'auth:isPublic';
export const ROLES_KEY = 'auth:roles';
export const ANY_AUTHENTICATED = '*';

/** Opt OUT of authentication. Every other route requires a valid token AND an explicit role decorator. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
export const Authenticated = () => Roles(ANY_AUTHENTICATED);

export const CurrentPrincipal = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal =>
  ctx.switchToHttp().getRequest().principal,
);
