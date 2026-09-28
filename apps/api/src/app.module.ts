import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { createRemoteJWKSet } from 'jose';
import { AdminAuctionsService } from './admin/admin-auctions.service';
import { AdminSettingsService } from './admin/admin-settings.service';
import { AdminController } from './admin/admin.controller';
import { AppController } from './app.controller';
import { AuctionsController } from './auctions/auctions.controller';
import { AuctionsService } from './auctions/auctions.service';
import { AuditService } from './audit/audit.service';
import { RedisThrottlerStorage } from './common/redis-throttler.storage';
import { BidsController } from './bids/bids.controller';
import { BidsService } from './bids/bids.service';
import { HttpThrottlerGuard } from './auth/http-throttler.guard';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { TokenVerifier } from './auth/token-verifier';
import { loadEnv, type Env } from './config/env';
import { ENV } from './config/tokens';
import { CustomersController } from './customers/customers.controller';
import { DbService } from './db/db.service';
import { KeycloakAdmin } from './identity/keycloak-admin';
import { InvoicesController } from './invoices/invoices.controller';
import { InvoicesService } from './invoices/invoices.service';
import { LifecycleService } from './lifecycle/lifecycle.service';
import { OutboxService } from './outbox/outbox.service';
import { TeamController } from './team/team.controller';
import { TeamService } from './team/team.service';
import { RealtimeController } from './realtime/realtime.controller';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { TicketService } from './realtime/ticket.service';
import { WorkersService } from './workers/workers.service';

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      useFactory: () => {
        const env = loadEnv();
        const url = env.RATE_LIMIT_REDIS_URL ?? env.REDIS_URL;
        return { throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }], storage: url ? new RedisThrottlerStorage(url) : undefined };
      },
    }),
  ],
  controllers: [AppController, CustomersController, BidsController, AuctionsController, AdminController, RealtimeController, TeamController, InvoicesController],
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    {
      provide: TokenVerifier,
      inject: [ENV],
      useFactory: (env: Env) =>
        new TokenVerifier({
          issuer: env.KEYCLOAK_ISSUER,
          audience: env.API_AUDIENCE,
          getKey: createRemoteJWKSet(new URL(env.KEYCLOAK_JWKS_URI ?? `${env.KEYCLOAK_ISSUER}/protocol/openid-connect/certs`), {
            cooldownDuration: 30_000,
            cacheMaxAge: 600_000,
          }),
        }),
    },
    DbService,
    AuditService,
    BidsService,
    AuctionsService,
    AdminAuctionsService,
    AdminSettingsService,
    LifecycleService,
    OutboxService,
    RealtimeGateway,
    TicketService,
    KeycloakAdmin,
    TeamService,
    InvoicesService,
    WorkersService,
    // Guard order matters: rate-limit → authenticate → authorize. All global, so new routes (and socket
    // handlers) are protected by default.
    { provide: APP_GUARD, useClass: HttpThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
