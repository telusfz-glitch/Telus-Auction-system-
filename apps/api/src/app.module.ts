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
import { LifecycleService } from './lifecycle/lifecycle.service';
import { OutboxService } from './outbox/outbox.service';
import { RealtimeController } from './realtime/realtime.controller';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { TicketService } from './realtime/ticket.service';
import { WorkersService } from './workers/workers.service';

@Module({
  imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }])],
  controllers: [AppController, CustomersController, BidsController, AuctionsController, AdminController, RealtimeController],
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
    WorkersService,
    // Guard order matters: rate-limit → authenticate → authorize. All global, so new routes (and socket
    // handlers) are protected by default.
    { provide: APP_GUARD, useClass: HttpThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
