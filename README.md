# TELUS Auction Platform — v2 (secure foundation + bid engine)

Steps 1–3 of the rebuild: monorepo, infrastructure, Keycloak identity, tenant isolation, and the concurrency-safe bid engine, with a security test suite.
The earlier single-file demo and the first Express backend are **prototypes** — this replaces them.
(The v1 backend had a role-check bug that would have rejected every admin; it should not be deployed.)

## Layout
```
apps/api/            NestJS API (TypeScript)
  src/auth/          Keycloak JWT verification, deny-by-default guards
  src/db/            tenant-scoped DB access (RLS context), migration runner
  src/audit/         audit writer (DB makes it append-only + hash-chained)
  src/bids/          bid engine (validation, idempotency, per-customer margin brackets, exposure)
  db/migrations/     001_init.sql (tenancy, RLS, audit chain) · 002_bid_engine.sql (lots, margin rules, DB bid invariants)
  test/              77 tests (see below)
packages/shared/     Zod schemas + role names shared by API and (later) web
infra/keycloak/      telus realm (roles, PKCE client, brute-force, password policy) + create-user.sh
infra/postgres/init/ creates the restricted `telus_app` runtime role
docker-compose.yml   Postgres 16, Redis 7, Keycloak 26 (127.0.0.1 only, no default secrets)
```

## Run it
```bash
scripts/gen-secrets.sh                 # random secrets → .env (mode 600); refuses to overwrite
docker compose up -d
npm install
set -a; . ./.env; set +a
npm run migrate -w @telus/api          # as the OWNER role
npm run start   -w @telus/api          # as the restricted telus_app role
TEMP_PASSWORD='<one-time>' infra/keycloak/create-user.sh admin@telus.ae super_admin
```
Tests: `npm test` (DB-free) · `TEST_DB_ADMIN_URL=… TEST_DB_APP_URL=… npm run test:db` (needs Postgres; the OWNER role must be non-superuser, like production; the suite drops the
`public` schema and **refuses to run unless the database name contains "test"**).

## Security model (what is enforced, and where)
| Threat | Control | Proven by |
|---|---|---|
| Forged / unsigned / wrong-issuer / expired tokens | `jose` verification against Keycloak JWKS, RS256 pinned, issuer + audience + exp required | `auth.spec` (incl. `alg:none`, HS256 key-confusion) |
| Privilege smuggling via other claims | roles read only from `realm_access.roles`; staff+customer roles on one identity rejected | `auth.spec` |
| Forgotten `@Roles` on a new endpoint | global guards: no role decorator ⇒ 403 for everyone | `guards.spec` |
| Customer A reading customer B's data | Postgres **row-level security**, `FORCE`d, app role is non-owner/non-superuser | `rls.spec` |
| App bug that forgets a WHERE clause | RLS still filters; no identity context ⇒ **zero rows** (fail closed) | `rls.spec` |
| Viewer / non-invited customer placing bids; bid impersonation | RLS `WITH CHECK` on `bids` | `rls.spec` |
| Editing/deleting bids | no UPDATE/DELETE grant to app role | `rls.spec` |
| Rewriting history | `audit_logs` append-only (triggers block even the owner), SHA-256 hash chain, `verify_audit_chain()` | `rls.spec` (tamper detected; 12 concurrent writers stay valid) |
| Identity leaking between pooled connections | transaction-local `set_config` | `rls.spec` |
| Mass assignment / bad input | Zod `.strict()` schemas on every body | (schemas in `packages/shared`) |
| Info leaks in errors; missing headers; open CORS | global exception filter, helmet (CSP/HSTS/…), allow-listed CORS | `app.e2e.spec` |
| Brute force | Keycloak lockout (5 failures) + API rate limit (120/min/IP) | config only — see below |


## Bid engine (step 3) — how correctness is guaranteed
Two layers, deliberately redundant:
1. **Application engine** (`src/bids/bids.service.ts`) does the business rules and returns clean errors: eligibility (invited, active,
   terms accepted, bidder role), auction open (DB clock, never the browser's), platform hard limits (max bid, optional range),
   the bidder's **own margin bracket**, and exposure across everything they currently lead.
2. **Database safety net** (trigger in `002_bid_engine.sql`) re-checks, atomically, that the auction is open and the bid is *strictly
   higher*, then updates price, anti-sniping extension and the outbox — so even raw SQL that bypasses the engine cannot record a bad bid.

Concurrency: locks are taken in one fixed order (customer → lot; the auction row only when extending), so there are no deadlock
cycles. Per-customer serialisation makes idempotency and exposure checks race-free; per-lot serialisation makes ordering deterministic.
All money maths is integer cents (BigInt), never floats.

Confidentiality: current price/leader live in `lot_bid_state`, readable by a customer **only for lots they lead**. The only way to see
a price is `visible_highest_bid()`, which returns it solely when the auction's visibility mode is `full_price`. In hidden modes a
rejection does not reveal the price or the minimum next bid. Accepted bids are not written to `audit_logs` (the immutable `bids`
ledger is the record, and the audit chain's global lock would serialise every bid); security-relevant *rejections* are.

Proven by `bids.spec.ts` against real Postgres: 30 simultaneous bids from 3 customers → strictly increasing ledger, every increment
honoured, correct winner; 9 identical simultaneous bids → exactly one winner; 8 simultaneous same-key requests → one bid; two
simultaneous late bids on different lots → one extension, not two; DB rejects lower/equal/closed-auction bids even when the engine is
bypassed. The suite ran 10× in a row with no failures and no deadlocks logged.

## Honest status: verified vs not
**Verified here:** typecheck clean; 77/77 tests pass, the database ones against a real PostgreSQL 16 using the restricted runtime role and a
non-superuser owner. Writing these suites found and fixed real bugs (audit-chain ordering under concurrent writes; a test-harness
assumption about owner access under FORCE'd RLS).

**Not measured:** throughput. A hot lot serialises its bidders and each bid makes ~10 queries; on your hardware that likely means tens to a
few hundred bids/second per lot. Load-test before an event, and collapse the reads into one CTE if it is not enough.

**Written but NOT verified** (no Docker in the build environment): `docker-compose.yml`, the Keycloak realm import
(JSON validated, never loaded into Keycloak), `create-user.sh`, and the Keycloak token mappers (`customer_id`, audience).
Expect to iterate when you first run the stack. Specific things to check: the `telus-api` audience appears in access tokens,
and `customer_id` appears for customer users.

## Known gaps — do not skip these before production
1. **MFA is not enforced by the API.** It relies on Keycloak: `create-user.sh` sets `CONFIGURE_TOTP` as a required action, so users
   created that way enrol TOTP at first login. Users created any other way get no MFA unless you configure a required action /
   conditional-OTP flow for staff roles in Keycloak. The API does not check `acr`/`amr`.
2. `sslRequired: external` and `start-dev` are **dev settings**. Production: `sslRequired: all`, `kc start` behind TLS with a real
   hostname, `https` issuer (the API already refuses a non-https issuer when `NODE_ENV=production`).
3. Migrations here run as a superuser (`telus_owner` in the dev image). Production should use a separate non-superuser owner role.
4. Audit chain stops tampering by application code and by the owner *unless they drop the triggers*. Stream `audit_logs` to
   write-once storage (S3 Object Lock) to close that.
5. Redis is in the compose file but not used yet (auction open/close jobs, Socket.IO adapter, distributed rate limits). The outbox
   table is written on every bid, but **nothing consumes it yet** — no realtime push or outbid notifications until that worker exists.
6. Auctions do not yet open/close by themselves (a scheduled job must flip `scheduled→live→closed`); the bid trigger only *enforces*
   status and time.
7. No HTTP endpoints yet for staff to manage lots, margin rule sets, customer limits or the security settings (the tables, RLS and
   engine support exist and are tested), nor for a customer to accept auction terms (the engine refuses bids until they have).
8. Not built yet: allocation/winner calculation, finalisation, web app, child-login provisioning via the Keycloak Admin API,
   credential vault for external-platform passwords, payments port, dependency/secret scanning in CI, third-party penetration test.

## Next
4. Auction scheduler + outbox publisher (BullMQ/Redis, Socket.IO) + allocation & finalisation · 5. Staff admin endpoints (lots, margin
rules, limits, security settings, Excel import) · 6. Next.js web app on Keycloak (Auth.js, tokens kept server-side) ·
7. Vault, payments, audit shipping, CI security scanning, penetration test.
