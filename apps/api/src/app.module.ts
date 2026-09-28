import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { createRemoteJWKSet } from 'jose';
import { AppController } from './app.controller';
import { AuditService } from './audit/audit.service';
import { BidsController } from './bids/bids.controller';
import { BidsService } from './bids/bids.service';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { TokenVerifier } from './auth/token-verifier';
import { loadEnv, type Env } from './config/env';
import { ENV } from './config/tokens';
import { CustomersController } from './customers/customers.controller';
import { DbService } from './db/db.service';

@Module({
  imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }])],
  controllers: [AppController, CustomersController, BidsController],
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
    // Guard order matters: rate-limit → authenticate → authorize. All global, so new routes are protected by default.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
