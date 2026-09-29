# TELUS Auction Platform — v2

Steps 1–7 of the rebuild: monorepo, infrastructure, Keycloak identity, tenant isolation, the concurrency-safe bid engine, the
auction lifecycle (scheduler, allocation, finalisation into invoices, outbox → realtime push), the staff admin API with
multi-instance realtime over Redis, the **Next.js web app** (customer bidding + staff console) on Keycloak with server-side
sessions, and customer team logins, invoices, Excel lot import, shared rate limits and CI — plus a security test suite that runs
the whole stack end to end.
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
  src/identity/      Keycloak Admin API client (service account) with customer-only guard rails
  src/team/          customer team logins: create / change role / suspend (customer admins and staff)
  src/invoices/      invoices: customers read their own, finance settles (unpaid → paid | void)
  db/migrations/     001_init.sql (tenancy, RLS, audit chain) · 002_bid_engine.sql (lots, margin rules, DB bid invariants)
                     003_lifecycle.sql (close-vs-bid locking, lot_results, invoice_lines, outbox claim, terms acceptance)
                     004_admin.sql (status-transition / freeze guards, withdrawn-lot bid guard, cancel notice, outbox purge)
                     005_realtime_tickets.sql (single-use socket tickets)
                     006_team_invoices.sql (customer_users identity guard, no deletes; invoice settlement guard)
  test/              see "Honest status" for the count
apps/web/            Next.js 15 web app (App Router, server components + server actions)
  src/lib/           OIDC (openid-client), Redis-backed encrypted sessions, server-side API client
  src/app/auth/      /auth/login · /auth/callback · /auth/logout (PKCE, state, nonce, RP-initiated logout)
  src/app/auctions/  customer: my auctions, auction page (accept terms, bid, live positions, results)
  src/app/admin/     staff console: auctions (create, lots, Excel import, invitations, schedule/cancel/finalise), customers
                     (with their logins), invoices (settle), settings
  src/app/team/      customer admin: company logins · src/app/invoices/: customer invoices
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
| Brute force | Keycloak lockout (5 failures) + API rate limit (120/min per route per signed-in user; anonymous: per address) | `ratelimit.e2e.spec` |
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


## Why PostgreSQL (and not MySQL or MongoDB)
Decided and kept deliberately. The platform's guarantees are enforced **by the database itself**, and they rely on PostgreSQL
features (counts from `apps/api/db/migrations`):

| Feature | Used | What it guarantees | MySQL | MongoDB |
|---|---|---|---|---|
| Row-level security (47 policies, 14 tables FORCE'd) | tenancy | one company can never read another's bids, invoices or logins — even with an app bug | none | none |
| Triggers (15) | immutability | invoices, lot results, audit log, running auctions cannot be altered or deleted | weaker | cannot veto a write |
| Functions (40, SECURITY DEFINER) | lifecycle | closing, email queue, audit export run inside the DB with `require_system()` | weaker | none |
| Advisory locks (18) | bidding | concurrent bids on a lot are serialised; a closing auction excludes late bids | limited | none |
| `FOR UPDATE SKIP LOCKED` (9) | queues | several API instances share the outbox / email queue without double-sending | yes | none |
| Foreign keys (22), CHECK constraints (54) | integrity | no orphan bids, no negative prices, valid states only | yes | none / partial |
| `numeric` money (16 columns) | money | exact to the cent | yes | weaker |
| `jsonb` (26 uses) | flexibility | event payloads and audit before/after values — document-style data without a second database | weaker | native |

MySQL would lose row-level security (the core of tenant isolation) and weaken the locking/trigger design; MongoDB would move
every one of these guarantees into application code. If a genuinely document-shaped, high-volume, non-transactional need
appears later, use `jsonb` first; add another store only if that is measured to be insufficient.

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

## Team logins, invoices, import, rate limits, CI (step 7)
- **Customer team logins.** A customer admin manages their company's logins at `/team` (API `GET/POST /team`, `PATCH /team/:id`);
  staff do the same for any customer, e.g. its first administrator (`/admin/customers/:id/users`, `PATCH /admin/customer-users/:id`).
  The API creates the Keycloak user (username = email, `customer_id` bound, customer role, temporary password shown **once**, required
  actions `TEAM_USER_REQUIRED_ACTIONS`, default `UPDATE_PASSWORD,CONFIGURE_TOTP`), records it in `customer_users`, and audits it.
  Role changes and suspensions go to Keycloak too (suspension disables the user and ends their sessions); a suspended login's
  still-valid access token is refused for bids (`LOGIN_SUSPENDED`). Nobody can change their own login, a company always keeps an
  active administrator, rows are never deleted, and their identity columns are immutable (database trigger).
- **The Keycloak service account** (`telus-api-admin`, client-credentials, secret `KEYCLOAK_ADMIN_CLIENT_SECRET` /
  `TELUS_API_ADMIN_CLIENT_SECRET`) is confined **by Keycloak itself** (Keycloak ≥ 26.2, fine-grained admin permissions v2, all in
  `telus-realm.json`): realm roles `query-users`, `query-groups`, `view-realm` only, plus three permissions — manage members of the
  `customers` group, map the three customer roles, map roles on users. It can create users only inside `customers`, cannot see,
  change, reset or re-role any staff account, cannot grant any staff role, cannot change realm settings or create clients
  (each proven with the raw service-account token in `team.kc.spec`). The API adds its own checks on top: customer roles only,
  target bound to the expected customer, no staff role.
- **Invoices.** Customers see theirs at `/invoices` (with lines); staff at `/admin/invoices`; `super_admin`/`finance` settle an unpaid
  invoice as paid (with a reference) or void — once. The database refuses every other change, and deletion.
- **Excel lot import** on the staff auction page: first sheet, row-1 headers `Lot, Description, Quantity, Starting price
  [, Fallback increment]` (common aliases accepted), ≤2 MB, ≤1000 lots, prices exact to the cent. Every bad row is reported by
  number and nothing is imported unless the whole sheet is valid.
- **Rate limits per signed-in user** (fixed in step 10): the limiter runs after authentication and counts an authenticated
  request against its user, per route (`RATE_LIMIT_PER_MINUTE`, default 120; bids 20 per 10 s; new logins 20 per hour).
  Previously it counted per client address, and since the web app calls the API server-to-server, every customer shared one
  bucket (the whole platform would have been limited to 20 bids per 10 s). Only anonymous requests are counted per address.
- **Rate limits shared across instances** through Redis (`RATE_LIMIT_REDIS_URL`, else `REDIS_URL`), atomic in a Lua script. If
  Redis is down the check fails **open** (logged) so a Redis outage cannot stop an auction.
- **CI** (`.github/workflows/ci.yml`): production-dependency audit (fails on high), API typecheck and every suite against real
  Postgres 16, Redis 7 and Keycloak 26.6.4 (the `REQUIRE_*` runs fail instead of skipping when a service is missing), web
  typecheck, unit tests, production build and the Playwright suite.
- **Secret scanning** in CI: gitleaks 8.28.0 (checksum-pinned) over the full history. `.gitleaks.toml` allow-lists only known test
  fixtures, by value pattern (`test-…secret…`, `e2e-…secret…`, two JWT header prefixes), never by directory — a real key committed
  into a test file is still reported (checked with planted GitHub/AWS keys).
- **Dependencies:** NestJS 10 → 11 (clears `multer`/`body-parser` advisories), `postcss` and `uuid` overridden to patched releases.
  `npm audit --omit=dev`: 0 vulnerabilities.

## Notifications and session hygiene (step 8)
- **Email notifications** (`src/notifications`, `007_notifications.sql`): outbid, lots won (per winning company, its own lots only),
  auction cancelled, invoice issued. The outbox publisher queues them in the same transaction that claims the events (dedupe keys
  absorb redelivery); a worker sends them over `SMTP_URL` with exponential-backoff retries. At most one outbid email per company,
  lot and 10 minutes. Outbid emails go to the company's active admins and bidders and never name the competitor; the price appears
  only in `full_price` auctions. HTML is escaped and subjects are single-line.
- **Back-channel logout**: Keycloak calls `POST /auth/backchannel-logout` on the web app when a user's session ends (sign-out
  elsewhere, an administrator ending sessions, a suspended login). The signed logout token is verified (issuer, audience, event,
  no nonce, ≤2 min old, single-use `jti`) and every matching web session is deleted immediately.
- **Keycloak 26.6.4** with the service account confined by fine-grained admin permissions v2 (see step 7) and the OTP policy fixed;
  the e2e suite enrols a real authenticator.

## Preferences and email invitations (step 9)
- **Personal outbid opt-out** (`009_notification_prefs.sql`): every admin or bidder login can turn outbid emails off for itself on
  `/team` (API `GET/PUT /me/notifications`, audited). Results, cancellations and invoices are always sent. The database enforces
  that the preference is personal: a customer may update its own row (`cu_self_prefs` policy) but, through it, only this column
  (no self re-role or reactivation), and a customer admin cannot change anyone else's preference. `email_claim` skips opted-out
  logins.
- **Invitations by email** (`TEAM_INVITE_METHOD=email`, default `password`): the API creates the Keycloak user with **no credential**
  and asks Keycloak to email a set-up link (`execute-actions-email`, valid `TEAM_INVITE_LIFESPAN_SECONDS`, default 24 h) that
  makes the person choose a password and (by default) enrol TOTP. No secret passes through the API or the inviting admin. If the
  email cannot be sent the Keycloak user is deleted, nothing is recorded, the call fails with `INVITE_EMAIL_FAILED` (502), and the
  address can be used again. Needs the realm's SMTP settings (Realm settings → Email); `team.kc.spec` sets them to an in-process
  SMTP catcher and follows both paths.

## Per-user rate limits and full-stack load test (step 10)
- **Bug fixed:** rate limits were counted per client address, but all customer traffic reaches the API from the web server, so
  one busy bidder could have exhausted the bid limit for every customer. Limits are now per signed-in user (see step 7);
  `ratelimit.e2e.spec` sends everything from one address and fails against the old guard.
- **`npm run load:http`**: the HTTP + Socket.IO load test described under "Measured" below. `DB_POOL_MAX` (default 20) sets the
  connections per API instance; keep instances × `DB_POOL_MAX` below Postgres `max_connections`.

## Audit log shipped to write-once storage (step 11)
- **What it closes:** the in-database hash chain stops tampering by the application and by anyone who does not drop the
  triggers. A database owner who drops them could rewrite history *and recompute the whole chain* so `verify_audit_chain()`
  passes again. Now the audit log is copied, in batches, to an S3 bucket with **Object Lock in COMPLIANCE mode**: until its
  retention date nobody — not the database owner, not the bucket owner, not AWS support — can change or delete a batch.
- **How** (`src/audit`, `010_audit_shipping.sql`): a worker (every `AUDIT_SHIP_INTERVAL_MS`, one instance at a time) takes the
  rows after the last shipped one, refuses to ship if they do not form an intact chain, writes them as deterministic NDJSON
  (`audit/<first id>-<last id>.ndjson`, header + one line per row, in the exact text the hash is computed from) with a
  SHA-256 checksum and COMPLIANCE retention (`AUDIT_SHIP_RETENTION_DAYS`, default ~7 years), then records it in the append-only
  `audit_shipments` table — which only accepts a batch that continues the shipped chain. A crash between upload and record
  is recovered (the rebuilt batch is byte-identical and recognised).
- **`npm run audit:verify -w @telus/api`** (exit 0 = intact, 2 = problems): checks the locked copy on its own (checksums, lock,
  chain across objects, recomputed hashes) and then the database against it — every shipped row still present and identical,
  nothing inserted into a shipped range, the unshipped tail continuing the chain, every recorded batch present in the bucket.
  Run it on a schedule from a separate account and alert on a non-zero exit.
- **Set up:** a bucket created with Object Lock enabled; the API's role needs `s3:PutObject`, `s3:PutObjectRetention`,
  `s3:GetObject`, `s3:ListBucket` on it (the verifier needs only the read permissions, including `s3:GetObjectRetention`);
  set `AUDIT_SHIP_BUCKET` (and `AUDIT_SHIP_REGION`, or `AUDIT_SHIP_ENDPOINT` for an S3-compatible store).
- **Tests** (`audit-ship.spec`, against real Postgres and moto's S3 with Object Lock): batching and retention, a locked object
  refusing deletion (403) and overwrite (412), crash recovery, two concurrent shippers, a DB owner who drops the triggers,
  edits a shipped row, deletes another and re-chains everything (the database's own check is fooled; the verifier names each
  changed and deleted row), and the shipper refusing to ship a broken chain.

## Product walkthrough (demo)
`DEMO=1 npx playwright test e2e/demo.spec.ts` in `apps/web` (same stack as the e2e suite) plays a whole auction in real
browsers — staff build and open it, two companies bid against each other with live updates, it closes, invoices are issued and
finance settles one — and saves numbered screenshots plus each bidder's browser video to `apps/web/demo-output/`
(`DEMO_OUT` to change). It is skipped in normal test runs.

## Staff MFA enforced by Keycloak and the API (step 12)
- **Keycloak** (`infra/keycloak/telus-realm.json`): custom browser flow `telus browser`. Every staff role includes the marker role
  `staff_mfa`; for anyone holding it the OTP form is required, and a staff user without an authenticator must enrol one before
  the login completes. Customers keep the previous behaviour (asked when enrolled). The AMR protocol mapper writes the methods
  used into the token (`amr: ["pwd","otp"]`).
- **API**: a staff token without `otp` in `amr` is refused with `403 MFA_REQUIRED` — even a perfectly valid token from another
  client or a changed flow never reaches staff endpoints on a password alone.
- **Web**: enrolling is not using — the token issued right after enrolment has only `pwd`. On `MFA_REQUIRED` the app starts one
  step-up login (`prompt=login`, guarded by a 60-second cookie against loops) and the user signs in with the new authenticator.
- **Proven** in the e2e suite against real Keycloak: forced enrolment, the step-up, `amr` in the stored token, kept on refresh
  and on a silent SSO re-login; seeded staff use pre-provisioned TOTP secrets and never reuse a code (single-use codes kept).

## Operations: readiness and metrics (step 13)
- **`GET /health`** — liveness (the process answers). **`GET /health/ready`** — readiness for the load balancer: 200 only if this
  instance reaches PostgreSQL (and Redis when `REDIS_URL` is set); otherwise 503 `NOT_READY` with no details.
- **`GET /metrics`** — Prometheus format, off (404) unless `METRICS_TOKEN` is set; the scraper sends `Authorization: Bearer
  <token>`, and a wrong token also gets 404. Counters are per instance (Prometheus sums them); backlogs come from the
  system-only `ops_metrics()` (counts and ages only, no customer data).

| Metric | Meaning | Suggested alert |
|---|---|---|
| `telus_database_up` | the scrape could read the database | `== 0` for 2 min |
| `telus_bids_total{outcome}` | bids by outcome (`accepted`, `BID_TOO_LOW`, `LOGIN_SUSPENDED`, …, `error`) | `rate(outcome="error") > 0` for 5 min |
| `telus_bid_duration_seconds` | API time per bid | p95 > 1 s for 5 min during a live auction |
| `telus_backlog{what="outbox_oldest_unpublished_seconds"}` | live updates waiting | > 30 s (pushes are stuck) |
| `telus_backlog{what="email_oldest_pending_seconds"}` / `email_failed` | notification emails | > 15 min / any increase |
| `telus_backlog{what="audit_oldest_unshipped_seconds"}` | audit rows not yet in write-once storage | > 3 × `AUDIT_SHIP_INTERVAL_MS` |
| `telus_worker_failures_total{loop}` | scheduler, outbox, email, audit-ship loops that threw | any increase |
| `telus_backlog{what="auctions_live"}`, `telus_process_*`, `telus_nodejs_*` | context, CPU, memory, event-loop lag | event-loop lag > 200 ms |

## Backups and restore drill (step 14)
- **Backup** — `BACKUP_DB_URL=postgres://telus_backup:…@host/telus scripts/db/backup.sh <dir>`: one consistent `pg_dump`
  snapshot (custom format) + `.sha256`; with `BACKUP_GPG_RECIPIENT` set, the dump is encrypted to that key and the plaintext
  removed. `telus_backup` (created by `infra/postgres/init/00-roles.sh`, password `BACKUP_DB_PASSWORD`) can read everything and
  change nothing (`pg_read_all_data`) and has `BYPASSRLS`: row-level security is FORCE'd even for the owner, so a dump as any
  other role is refused rather than silently incomplete.
- **Restore drill** — `DRILL_ADMIN_URL=postgres://<admin>@restore-host/postgres scripts/db/restore-drill.sh <file> [source]`
  restores into a throwaway database on an **isolated** server (with triggers disabled, so rows come back byte for byte) and
  checks: checksum, all migrations, the audit hash chain, every lot's price = top of its bid ledger, every invoice = sum of its
  lines, FORCE'd RLS and audit triggers still in place, and (right after a backup, with `source`) row counts equal the live
  database. Exit 0 only if everything passes.
- **Tested** (`backup.spec`, in CI): good backup passes; a damaged file is stopped by its checksum before restoring; a backup
  of a secretly edited database fails on the audit chain; dumping without `BYPASSRLS` is refused. (The damaged-file test caught
  a real bug in the first version of the drill script: a failed check inside `a && b` does not stop a `set -e` script.)
- **In production**: keep the managed database's point-in-time recovery on as well; ship these dumps off-site with a retention
  lock (e.g. the Object Lock bucket, a separate prefix); run the drill at least monthly and after every schema change, and alert
  if it fails or has not run.

## Honest status: verified vs not
**Verified here:** typecheck clean (API and web); API 168/168 tests pass (notifications against a real in-process SMTP server) (repeated full runs, no deadlocks logged), the database ones
against a real PostgreSQL 16 using the restricted runtime role and a non-superuser owner, the team suite against the real Keycloak
Admin API; web 26 unit tests and 12 Playwright end-to-end tests pass against a real **Keycloak 26.6.4** (this realm file imported), the API, Postgres 16, Redis 7 and the production web build. The realtime and admin suites run the real AppModule over
real HTTP and sockets; the cluster suite runs two instances against a real Redis 7. The close-race and revoke-eviction tests were
checked to fail when the protection they cover is removed, as was the web refresh-lock test. Writing these suites found and fixed real bugs (audit-chain ordering under concurrent writes; a test-harness
assumption about owner access under FORCE'd RLS).

**Measured (bid engine against Postgres 16, 4 vCPU sandbox shared with Keycloak/Redis — treat as a floor, not a capacity plan):**
`LOAD_DB_ADMIN_URL=… LOAD_DB_APP_URL=… npm run load -w @telus/api -- --seconds 15 --bidders 40` (resets a `*_test` database).

| 40 concurrent bidders, 15 s | requests/s | accepted bids/s | p50 | p95 | p99 |
|---|---|---|---|---|---|
| **Hot lot** (all on one lot) — before tuning | 257 | 108 | 152 ms | 202 ms | 267 ms |
| **Hot lot** — after tuning | ~405 | **~155** | 95 ms | 129 ms | 163 ms |
| **Spread** over 199 lots — after tuning | ~595 | **~258** | 66 ms | 96 ms | 110 ms |

Tuning = shortening the per-lot critical section: price-independent reads (limits, exposure, margin brackets) moved before the
lot lock (still under the customer lock, which keeps them race-free), an early lock-free rejection of bids that are already too low
(safe: a lot's price only rises), and fewer round trips after the insert. After every run the load script checks that each lot's
state equals the top of its ledger (it always has). Most rejected bids in the table are `BID_TOO_LOW` races, as in a real bidding
war.

**Measured through HTTP and Socket.IO (step 10):** `LOAD_DB_ADMIN_URL=… LOAD_DB_APP_URL=… LOAD_REDIS_URL=… npm run load:http -w
@telus/api -- [--bidders 200 --viewers 1000 --instances 2 --seconds 30]` starts real API processes (two, sharing Redis), signs
tokens with a throw-away key served from a local JWKS endpoint (verified exactly like Keycloak's), and drives them: bidders bid over
HTTP about once a second, each learning prices only from its own socket and from `BID_TOO_LOW` answers, as a real client would, in a
`full_price` auction whose every accepted bid is pushed to every spectator. Same 4-vCPU sandbox, now also running both API
processes and the load generator:

| 200 bidders, 2 API instances, 30 s | bids/s (accepted) | bid HTTP p50 / p95 | "you lead" push p50 / p95 | spectator push p50 / p95 | pushes missed |
|---|---|---|---|---|---|
| no spectators | 193 (135) | 26 / 100 ms | 89 / 182 ms | — | — |
| 300 spectators | 186 (122) | 47 / 225 ms | 103 / 229 ms | 114 / 247 ms | 0 of 1,096,500 |
| 1,000 spectators | 157 (80) | 184 / 467 ms | 247 / 489 ms | 280 / 539 ms | 0 of 2,408,000 |

Push latency is measured from the moment the bid is sent and includes the outbox poll (`OUTBOX_INTERVAL_MS`, 250 ms by default:
~125 ms on average). The API instances used ~0.5–0.6 of a core each; the single-threaded load generator was the busiest process,
and at 1,000 spectators its own event loop lagged (p99 285 ms, printed by the script), so that row's latencies overstate the
system's. Integrity was checked after every run (ledger = lot state, no unpublished outbox events). Still not measured:
Postgres and the API on production hardware, with the generator on separate machines — do that before a large event.

**Keycloak, now verified:** the realm imports; the `telus-api` audience and `customer_id` mappers work in real access tokens (the
e2e suite logs in real users and the API accepts their tokens). Loading the realm found a real bug: Keycloak 24+ **silently dropped**
the `customer_id` attribute (undeclared attributes are discarded by the declarative user profile), so every customer login would have
been refused. The realm now declares it, admin-only. The web client is now confidential (the web server is the OIDC client); its
secret and URL come from `TELUS_WEB_CLIENT_SECRET` / `TELUS_WEB_URL` at import. A second realm bug surfaced on 26.6: the OTP policy
had no algorithm (a null that crashed realm export); it is now complete, and the e2e suite enrols a real authenticator (it computes
TOTP codes from the secret Keycloak shows) for a newly created team login.

**Still NOT verified** (no Docker in the build environment): `docker-compose.yml` itself, `create-user.sh` (it wraps `kcadm.sh`
through `docker compose exec`; the same admin operations were verified via the REST API) and the CI workflow's Docker steps
(`scripts/ci/prepare-services.sh`) until it runs on GitHub.

## Known gaps — do not skip these before production
1. **Residual service-account power (small).** Keycloak 26.6 has no group-scoped "map roles on users", so the account holds
   `map-roles` on all users. Combined with its role permission it can only ever attach or remove the three *customer* roles; on a
   staff account that is not an escalation (a token with staff and customer roles is refused), but it would lock that staff member
   out until an administrator removes the role. Protect `KEYCLOAK_ADMIN_CLIENT_SECRET` like the database password, and alert on
   admin events that map customer roles to users outside `customers`. (With Keycloak 26.0 the same account could grant
   `super_admin`; that is why the realm now requires ≥ 26.2 — see `docker-compose.yml`.)
2. **MFA for staff is enforced twice** (step 12): the realm's `telus browser` flow requires an authenticator for every staff
   role (enrolment is forced on first login), and the API refuses any staff token whose `amr` lacks `otp` (`STAFF_MFA_AMR`).
   Customers are asked for a code when they have enrolled one (team logins always do); making it mandatory for *every* customer
   login is a business choice — add the customer roles to the flow's condition if wanted.
3. `sslRequired: external` and `start-dev` are **dev settings**. Production: `sslRequired: all`, `kc start` behind TLS with a real
   hostname, `https` issuer (the API already refuses a non-https issuer when `NODE_ENV=production`).
4. Migrations here run as a superuser (`telus_owner` in the dev image). Production should use a separate non-superuser owner role.
5. The audit chain alone stops tampering by application code and by the owner *unless they drop the triggers*; shipping to
   S3 Object Lock (step 11) closes that for everything shipped. Rows written since the last shipment (≤ `AUDIT_SHIP_INTERVAL_MS`)
   are protected only by the chain, and the `ip` column is not part of the hash (it is protected once shipped). Shipping is
   off until `AUDIT_SHIP_BUCKET` is set, and `audit:verify` must actually be scheduled and alerted on.
6. A suspended login loses its web session at once (back-channel logout) and cannot bid; an already-open *socket* keeps receiving
   public auction events until its access token expires (≤5 min). Suspending a whole *customer* stops bids immediately but does not
   end its users' sessions (suspend the logins too, or revoke the invitation, which evicts sockets at once).
7. The exposure check stops counting an auction's lots once it is `finalized` (step-3 rule). If purchase limits should include
   unpaid invoices, count them explicitly.
8. Changing a margin rule set takes effect on the next bid, including in live auctions. If brackets must be frozen per auction,
   snapshot them at scheduling time.
9. With the default `TEAM_INVITE_METHOD=password`, temporary passwords for new logins are shown once to the person who created
   them, who must pass them on; set `TEAM_INVITE_METHOD=email` (with the realm's SMTP configured) to avoid that. Notifications are email only (no SMS), and emails stay
   queued — not sent — until `SMTP_URL` is set.
10. Rate-limit checks fail open while Redis is unreachable (by design, logged). The web app has no rate limiting of its own.
   Requests with an invalid token are refused (401) before they are counted, so floods of them must be absorbed at the edge
   (proxy / WAF); the API only spends a signature check on each.
11. Not built yet: credential vault for external-platform passwords, payments port, third-party penetration test.

## Roadmap — what remains, in order
**Phase A — merge and stand up a staging environment**
1. Review and merge PR #1 (`claude/project-start-continue-8mn8ww` → `main`).
2. Provision staging: managed PostgreSQL 16 (non-superuser owner role, gap 4), Redis 7, Keycloak ≥ 26.2 in production mode
   (`kc start`, TLS, `sslRequired: all`, gap 3), the API (2+ instances behind a TLS load balancer) and the web app.
3. Generate secrets with `scripts/gen-secrets.sh` into a secrets manager; set `SMTP_URL`, `MAIL_FROM`, `PUBLIC_WEB_URL`.
4. Create the S3 Object Lock bucket, set `AUDIT_SHIP_BUCKET`, schedule `npm run audit:verify` from a separate account with alerting.
5. Run `docker-compose.yml` / `create-user.sh` once for real (never run here), create the first staff users with MFA.

**Phase B — business decisions that change code** (need the owner's answers)
6. Purchase limits: should unpaid invoices count against a customer's limit (gap 7)?
7. Margin brackets: freeze them per auction at scheduling time (gap 8)?
8. Invitations: switch to `TEAM_INVITE_METHOD=email` once SMTP works (gap 9); SMS notifications wanted?
9. Suspending a customer: also end all its users' sessions automatically (gap 6)?

**Phase C — features not built yet** (need provider / scope decisions)
10. Payments: choose the provider (card gateway, bank transfer reconciliation, or both); invoices already carry status and
    settlement fields.
11. Credential vault for external-platform passwords: which platforms, who may see them, which vault (e.g. cloud KMS-backed).
12. ~~Enforce MFA for staff~~ — done (step 12).

**Phase D — prove it before go-live**
13. `npm run load:http` on production-like hardware, load generator on separate machines.
14. Third-party penetration test; fix findings.
15. Schedule `scripts/db/backup.sh` + a monthly `restore-drill.sh` (both exist — step 14); wire `/health/ready` into the load
    balancer and `/metrics` into Prometheus with the alerts in "Operations" (step 13).
16. A pilot auction with one or two friendly customers, then go live.
