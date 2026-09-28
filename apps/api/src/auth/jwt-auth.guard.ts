import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WsException } from '@nestjs/websockets';
import { IS_PUBLIC } from './decorators';
import { ForbiddenPrincipalError, TokenVerifier } from './token-verifier';

const MAX_TOKEN_LENGTH = 8192;

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly verifier: TokenVerifier) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    // Sockets authenticate once, at the handshake (RealtimeGateway). Any other transport fails closed.
    if (ctx.getType() === 'ws') {
      if (!ctx.switchToWs().getClient()?.data?.principal) throw new WsException('unauthorized');
      return true;
    }
    if (ctx.getType() !== 'http') throw new ForbiddenException();

    const req = ctx.switchToHttp().getRequest();
    const header: unknown = req.headers['authorization'];
    const parts = typeof header === 'string' ? header.split(' ') : [];
    const token = parts.length === 2 && parts[0]!.toLowerCase() === 'bearer' ? parts[1]! : '';
    if (!token || token.length > MAX_TOKEN_LENGTH) throw new UnauthorizedException();

    try {
      req.principal = await this.verifier.verify(token);
      return true;
    } catch (err) {
      if (err instanceof ForbiddenPrincipalError) throw new ForbiddenException();
      throw new UnauthorizedException();
    }
  }
}
