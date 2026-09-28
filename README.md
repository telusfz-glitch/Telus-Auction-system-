# TELUS Auction Platform — v2

Steps 1–6 of the rebuild: monorepo, infrastructure, Keycloak identity, tenant isolation, the concurrency-safe bid engine, the
auction lifecycle (scheduler, allocation, finalisation into invoices, outbox → realtime push), the staff admin API with
multi-instance realtime over Redis, and the **Next.js web app** (customer bidding + staff console) on Keycloak with server-side
sessions — plus a security test suite that runs the whole stack end to end.
The earlier single-file demo and the first Express backend are **prototypes** — this replaces them.
(The v1 backend had a role-check bug that would have rejected every admin; it should not be deployed.)

## Layout
```
apps/api/            NestJS API (TypeScript)
  src/auth/          Keycloak JWT verification, deny-by-default guards
  src/db/            tenant-scoped DB access (RLS context), migration runner
  src/audit/         audit writer (DB makes it append-only + hash-chained)
  src/bids/          bid engine (validation, idempotency, per-customer margin brackets, exposure)
  src/auctions/      customer auction views, accept-terms, my-results · staff results + finalise → invoices
  src/lifecycle/     scheduler: scheduled→live→closed on the DB clock, lot allocation at close
  src/outbox/        at-least-once outbox publisher (claim → deliver → mark, one transaction)
  src/realtime/      Socket.IO gateway (/realtime) + routing.ts, the confidentiality rules for pushed events
  src/workers/       in-process loops that run the scheduler, the publisher and the outbox purge
  src/admin/         staff admin API: auctions, lots, invitations, customers' status/limits/margin rules, security settings
  db/migrations/     001_init.sql (tenancy, RLS, audit chain) · 002_bid_engine.sql (lots, margin rules, DB bid invariants)
                     003_lifecycle.sql (close-vs-bid locking, lot_results, invoice_lines, outbox claim, terms acceptance)
                     004_admin.sql (status-transition / freeze guards, withdrawn-lot bid guard, cancel notice, outbox purge)
                     005_realtime_tickets.sql (single-use socket tickets)
  test/              see "Honest status" for the count
apps/web/            Next.js 15 web app (App Router, server components + server actions)
  src/lib/           OIDC (openid-client), Redis-backed encrypted sessions, server-side API client
  src/app/auth/      /auth/login · /auth/callback · /auth/logout (PKCE, state, nonce, RP-initiated logout)
  src/app/auctions/  customer: my auctions, auction page (accept terms, bid, live positions, results)
  src/app/admin/     staff console: auctions (create, lots, invitations, schedule/cancel/finalise), customers, settings
  e2e/               Playwright suite against real Keycloak + API + Postgres + Redis
packages/shared/     Zod schemas + role names shared by API and web
infra/keycloak/      telus realm (roles, confidential BFF client + PKCE, user profile, brute-force, password policy) + create-user.sh
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
npm run start   -w @telus/api          # as the restricted telus_app role (port 4000)
npm run build:web && npm run start -w @telus/web   # web app on http://localhost:3000 (same shell: it reads the .env values)
TEMP_PASSWORD='<one-time>' infra/keycloak/create-user.sh admin@telus.ae super_admin
```
For development, `npm run dev:web` instead of build+start.
Tests: `npm test` (DB-free) · `TEST_DB_ADMIN_URL=… TEST_DB_APP_URL=… npm run test:db` (needs Postgres; the OWNER role must be non-superuser, like production; the suite drops the
`public` schema and **refuses to run unless the database name contains "test"**). The owner must be able to `CREATE EXTENSION`
(pgcrypto and btree_gist are trusted extensions, so owning the database is enough on PG 13+).
`TEST_DB_ADMIN_URL=… TEST_DB_APP_URL=… TEST_REDIS_URL=redis://… npm run test:redis -w @telus/api` runs two API instances against one
Redis to prove cross-instance realtime delivery. `npm test -w @telus/web` runs the web unit tests (no services needed).

**End-to-end tests** (`npm run e2e`): Playwright drives Chromium against real Keycloak, Postgres and Redis; it starts the API and the
production build of the web app itself, resets a `*_test` database, and creates its Keycloak users through the admin REST API.
Defaults (overridable with `E2E_*` variables, see `apps/web/e2e/stack.ts`): Keycloak on :8080 with admin `kcadmin`, the realm imported
with `TELUS_WEB_URL=http://localhost:3000` and `TELUS_WEB_CLIENT_SECRET=e2e-web-client-secret-0123456789`; Postgres on :5433 with
database `telus_e2e_test`; Redis on :6380 with password `testpw`. These are test-only values.

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
| A bid slipping in after the winner was computed | bids hold a shared auction lock, the closer takes it exclusively | `lifecycle.spec` (held-open bid is included; fails without the lock) |
| Push channel leaking prices or competitor identity | pure routing rules; customer rooms carry only their own position; price only in `full_price` | `routing.spec`, `realtime.e2e.spec` |
| Unauthenticated / stale sockets; eavesdropping on other auctions | token verified at handshake, disconnect at token expiry, auction rooms joined only after an RLS check | `realtime.e2e.spec` |
| Customer tampering with participation (self-invite, un-accept terms) | RLS policy + guard trigger: only `terms_accepted_at`, only once | `lifecycle.spec` |
| Rewriting results or invoicing a lot twice | `lot_results` append-only; `invoice_lines.lot_id` unique; one invoice per auction+customer | `lifecycle.spec` |
| Staff (or buggy code) changing a running auction's rules | guard triggers: only legal status transitions; timing/visibility/lots frozen once started (close may only be extended) | `admin.spec` (raw SQL refused) |
| Bids on a withdrawn lot | per-lot lock shared by withdraw, engine and a bid trigger that re-checks `active` | `admin.spec` (API and raw SQL) |
| Over-broad staff powers | per-endpoint roles: managers run auctions, finance sets limits, only super_admin changes security settings | `admin.spec` (403 matrix) |
| Revoked customer still listening | revoke evicts their sockets from the auction room on every instance; re-subscribe is RLS-checked | `realtime-cluster.e2e.spec` |
| Token theft from the browser (XSS) | web app is a backend-for-frontend: tokens live in Redis (AES-GCM), the browser holds an opaque HttpOnly id; sockets use 30 s single-use tickets | web `e2e` (no Keycloak token in any response; cookie flags), `realtime.e2e.spec` (ticket reuse/forgery) |
| Login CSRF, code interception, token replay | Authorization Code + PKCE S256, state bound to an HttpOnly cookie, nonce, single-use login record; new session id at each login | web `e2e`, `lib.test` |
| Open redirects after login | `returnTo` accepts only same-site relative paths | `lib.test` |
| Script injection, framing | per-request nonce CSP (`strict-dynamic`, no `unsafe-eval` in production), `frame-ancestors 'none'`, nosniff, COOP | web `e2e` (headers) |
| CSRF on actions | server actions check Origin (Next), logout checks Origin, SameSite=Lax session cookie | web `e2e` |
| Refresh-token rotation races logging users out | one refresher per session (Redis lock), others wait for its result | web `e2e` (6 parallel requests; fails without the lock) |
| Customer moving themselves to another tenant | `customer_id` is a declared user-profile attribute that only admins can view or edit | realm import + web `e2e` setup |


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

## Auction lifecycle (step 4)
- **Scheduler** (`src/lifecycle`, every second): `scheduled → live` at `start_at`, `live → closed` at `close_at`, both on the database
  clock via SECURITY DEFINER functions that only a `system` DB context may call. Idempotent, so running several API instances is safe.
- **Close vs. bids:** every bid takes a *shared* advisory lock on its auction inside the bid trigger; the closer takes it *exclusively*,
  so it waits for in-flight bids and later bids queue behind it and then see `closed`. The winner is therefore always the top of the ledger.
- **Allocation:** at close each lot gets one immutable `lot_results` row: `won` (leader, winning bid, unit price, total = price × qty),
  `unsold`, or `withdrawn`. Customers see only the rows they won.
- **Finalisation:** `POST /admin/auctions/:id/finalize` (super_admin, auction_manager) turns `closed` results into one invoice per winning
  customer (`INV-<auction>-<customer code>`) with one line per lot, in one transaction, audited. Refuses twice.
- **Outbox → realtime:** the publisher claims events with `FOR UPDATE SKIP LOCKED`, pushes them, and marks them published in the same
  transaction (at-least-once; clients must tolerate duplicates and should re-fetch `/lots/:id/my-status` if in doubt).
  Socket.IO at `path: /realtime`, `transports: ['websocket']`, `auth: { token }`; emit `auction.subscribe {auctionId}` to join an auction.
  Customers receive `lot.leading` / `lot.outbid` (own position only), `auction.extended`, `auction.opened`, `auction.closed`, and
  `lot.price` only in `full_price` auctions. Staff receive every raw event.
- **Customer HTTP:** `GET /auctions`, `GET /auctions/:id` (with lots), `POST /auctions/:id/accept-terms` (admin/bidder; idempotent, first
  acceptance is the record), `GET /auctions/:id/my-results`. **Staff:** `GET /admin/auctions/:id/results`.
- Env: `WORKERS_ENABLED` (default `true`), `SCHEDULER_INTERVAL_MS` (1000), `OUTBOX_INTERVAL_MS` (250),
  `OUTBOX_RETENTION_DAYS` (30; published events older than this are purged hourly), `REDIS_URL` (optional, see below).

## Staff admin API (step 5)
All routes are under `/admin`, validated by `.strict()` Zod schemas (`packages/shared`), audited with before/after values in the same
transaction, and backed by database guard triggers (`004_admin.sql`) so the rules hold even if application code is wrong.

| Area | Routes | Roles |
|---|---|---|
| Auctions | `GET /auctions`, `GET /auctions/:id` (lots with live price/leader, participants), `POST /auctions` (creates a **draft**), `PATCH /auctions/:id` (draft/scheduled only), `POST /auctions/:id/schedule` (needs ≥1 lot, ≥1 invitee, a future close), `/unschedule`, `/cancel` (also a live auction: waits for in-flight bids, notifies participants) | read: all staff · write: super_admin, auction_manager |
| Lots | `POST /auctions/:id/lots` (bulk, ≤1000), `PATCH /lots/:id`, `DELETE /lots/:id` (draft/scheduled), `POST /lots/:id/withdraw` (up to live) | super_admin, auction_manager |
| Invitations | `POST /auctions/:id/participants {customerIds}` (re-admitting keeps terms acceptance), `DELETE /auctions/:id/participants/:customerId` (soft revoke) | super_admin, auction_manager |
| Customers | `PATCH /customers/:id {status, marginRuleSetId}` · `PUT /customers/:id/limits {maxPurchaseValue}` | managers · super_admin, finance |
| Margin rules | `GET /margin-rule-sets`, `POST /margin-rule-sets {name, brackets}`, `PUT /margin-rule-sets/:id/brackets` (atomic replace; overlaps → 422) | read: all staff · write: managers |
| Security | `GET /security-settings`, `PATCH /security-settings` | read: all staff · write: super_admin |

Auction lifecycle for staff: `draft → scheduled → (scheduler) live → (scheduler) closed → finalized`, with `cancelled` reachable from
draft/scheduled/live and `archived` from finalized/cancelled. Staff can never set `live` or `closed` themselves.

**Multiple API instances:** set `REDIS_URL` on every instance. Socket.IO rooms are then shared through the Redis adapter, so an event
published by whichever instance's worker claimed it reaches sockets connected to any instance.

## Web app (step 6)
Next.js 15 (App Router) as a **backend-for-frontend**. Every page is a server component that calls the API with the user's token
from the server-side session; every mutation is a server action that re-checks the session and re-validates input with the shared
Zod schemas. The browser never receives a Keycloak token: not in cookies, storage, HTML or RSC payloads (the e2e suite checks every
response).
- **Sign-in:** `/auth/login` → Keycloak (Authorization Code + PKCE S256, state, nonce) → `/auth/callback` validates everything
  (`openid-client`), rejects accounts with no TELUS role, mixed staff/customer roles, or a customer account without `customer_id`,
  then creates a new session. `/auth/logout` (POST, same-origin) ends the session and the Keycloak SSO session.
- **Sessions:** Redis, AES-256-GCM encrypted, keyed by a hash of the cookie; lifetime = the refresh token's, capped at 10 h. Access
  tokens are refreshed server-side with a per-session lock (Keycloak rotates refresh tokens and revokes on reuse).
- **Customers:** auction list; auction page with countdown, terms acceptance, per-lot bid forms (server-minted idempotency keys, so a
  double-submit cannot bid twice), own position per lot via `GET /auctions/:id/my-positions`, results after close.
  Live updates: the page opens a socket with a one-time ticket (`POST /socket-tickets` on the API, fetched server-side) and re-renders
  from the server on each event — pushed messages never become the source of truth for numbers.
- **Staff:** auctions list; create (times entered in the user's local time zone); lots (add, withdraw, delete); invitations (invite,
  revoke); schedule / back to draft / cancel / finalise; live highest bid, leader and bid count; results; customers (create, status,
  margin rule set, purchase limit); settings (security limits, margin rule sets). Buttons follow roles; the API enforces them.
- Web env (see `scripts/gen-secrets.sh`): `WEB_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `API_URL`, `API_PUBLIC_URL`,
  `REDIS_URL`, `SESSION_SECRET`, `DISPLAY_TIMEZONE` (default Asia/Dubai). `WEB_ALLOWED_ORIGINS` when behind a proxy that rewrites Host.
  The API needs `REALTIME_TICKET_SECRET` for browser sockets.

## Honest status: verified vs not
**Verified here:** typecheck clean (API and web); API 124/124 tests pass (repeated full runs, no deadlocks logged), the database ones
against a real PostgreSQL 16 using the restricted runtime role and a non-superuser owner; web 23 unit tests and 8 Playwright end-to-end
tests pass against a real **Keycloak 26.0.7** (this realm file imported), the API, Postgres 16, Redis 7 and the production web build. The realtime and admin suites run the real AppModule over
real HTTP and sockets; the cluster suite runs two instances against a real Redis 7. The close-race and revoke-eviction tests were
checked to fail when the protection they cover is removed, as was the web refresh-lock test. Writing these suites found and fixed real bugs (audit-chain ordering under concurrent writes; a test-harness
assumption about owner access under FORCE'd RLS).

**Not measured:** throughput. A hot lot serialises its bidders and each bid makes ~10 queries; on your hardware that likely means tens to a
few hundred bids/second per lot. Load-test before an event, and collapse the reads into one CTE if it is not enough.

**Keycloak, now verified:** the realm imports; the `telus-api` audience and `customer_id` mappers work in real access tokens (the
e2e suite logs in real users and the API accepts their tokens). Loading the realm found a real bug: Keycloak 24+ **silently dropped**
the `customer_id` attribute (undeclared attributes are discarded by the declarative user profile), so every customer login would have
been refused. The realm now declares it, admin-only. The web client is now confidential (the web server is the OIDC client); its
secret and URL come from `TELUS_WEB_CLIENT_SECRET` / `TELUS_WEB_URL` at import.

**Still NOT verified** (no Docker in the build environment): `docker-compose.yml` itself and `create-user.sh` (it wraps `kcadm.sh`
through `docker compose exec`; the same admin operations were verified via the REST API).

## Known gaps — do not skip these before production
1. **MFA is not enforced by the API.** It relies on Keycloak: `create-user.sh` sets `CONFIGURE_TOTP` as a required action, so users
   created that way enrol TOTP at first login. Users created any other way get no MFA unless you configure a required action /
   conditional-OTP flow for staff roles in Keycloak. The API does not check `acr`/`amr`.
2. `sslRequired: external` and `start-dev` are **dev settings**. Production: `sslRequired: all`, `kc start` behind TLS with a real
   hostname, `https` issuer (the API already refuses a non-https issuer when `NODE_ENV=production`).
3. Migrations here run as a superuser (`telus_owner` in the dev image). Production should use a separate non-superuser owner role.
4. Audit chain stops tampering by application code and by the owner *unless they drop the triggers*. Stream `audit_logs` to
   write-once storage (S3 Object Lock) to close that.
5. **API rate limits are per instance** (in-memory throttler). With several instances behind a load balancer the effective limit
   multiplies; move the throttler storage to Redis before scaling out. Socket connections are not rate-limited beyond the handshake.
6. Suspending or blocking a *customer* stops their bids immediately (engine check), but their already-open sockets keep receiving
   public room events until their token expires (≤5 min). Revoking an *invitation* evicts them at once (see step 5).
7. The exposure check stops counting an auction's lots once it is `finalized` (existing step-3 rule). If purchase limits should include
   unpaid invoices, count them explicitly.
8. Changing a margin rule set takes effect on the next bid, including in live auctions. If brackets must be frozen per auction,
   snapshot them at scheduling time.
9. No out-of-band notifications (email/SMS) for outbid/won/cancelled; no Excel/CSV import for lots (the bulk JSON endpoint takes up to
   1000 lots per call, so an importer only needs to parse the file and call it).
10. Web app: sessions end when the refresh token expires or refresh fails, but a user disabled in Keycloak keeps their current access
    token until it expires (≤5 min) — no back-channel logout yet. The web app has no rate limiting of its own (the API's applies).
    Customer team logins are still created in Keycloak by staff (`create-user.sh`); there is no self-service team management UI.
11. Not built yet: child-login provisioning via the Keycloak Admin API, Excel lot import, invoices/payments UI, credential vault for
    external-platform passwords, payments port, dependency/secret scanning in CI, third-party penetration test.

## Next
7. Customer team management (child logins via the Keycloak Admin API) · Excel lot import · invoices view · Redis-backed rate limits ·
8. Notifications (email/SMS), vault, payments, audit shipping, CI (typecheck + unit + DB + e2e) and security scanning, penetration test.
