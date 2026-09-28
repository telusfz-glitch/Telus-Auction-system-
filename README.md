# TELUS Auction Platform — v2 (secure foundation + bid engine + auction lifecycle)

Steps 1–4 of the rebuild: monorepo, infrastructure, Keycloak identity, tenant isolation, the concurrency-safe bid engine, and the
auction lifecycle (scheduler, allocation, finalisation into invoices, outbox → realtime push), with a security test suite.
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
  src/workers/       in-process loops that run the scheduler and the publisher
  db/migrations/     001_init.sql (tenancy, RLS, audit chain) · 002_bid_engine.sql (lots, margin rules, DB bid invariants)
                     003_lifecycle.sql (close-vs-bid locking, lot_results, invoice_lines, outbox claim, terms acceptance)
  test/              105 tests (see below)
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
`public` schema and **refuses to run unless the database name contains "test"**). The owner must be able to `CREATE EXTENSION`
(pgcrypto and btree_gist are trusted extensions, so owning the database is enough on PG 13+).

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
- Env: `WORKERS_ENABLED` (default `true`), `SCHEDULER_INTERVAL_MS` (1000), `OUTBOX_INTERVAL_MS` (250).

## Honest status: verified vs not
**Verified here:** typecheck clean; 105/105 tests pass (5 consecutive full runs, no deadlocks logged), the database ones against a real
PostgreSQL 16 using the restricted runtime role and a non-superuser owner. The realtime suite runs the real AppModule over real sockets. Writing these suites found and fixed real bugs (audit-chain ordering under concurrent writes; a test-harness
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
5. **Realtime is single-instance.** Each instance's publisher pushes only to sockets connected to *that* instance. Running more than one
   API instance needs the Socket.IO Redis adapter (Redis is already in the compose file) — until then run one instance, or run the
   workers on one and route all sockets to it. Rate limits are per-instance for the same reason.
6. A customer whose invitation is revoked mid-auction keeps receiving that auction's *public* room events (timer, and price in
   `full_price` mode) until their socket reconnects, at most one access-token lifetime (5 min). Their own position events are unaffected.
7. The outbox is never purged; add a retention job (e.g. delete published rows older than 30 days) before it grows large.
8. The exposure check stops counting an auction's lots once it is `finalized` (existing step-3 rule). If purchase limits should include
   unpaid invoices, count them explicitly.
9. No HTTP endpoints yet for staff to create/schedule auctions and lots, invite customers, manage margin rule sets, customer limits or
   the security settings (the tables, RLS and engine support exist and are tested). No out-of-band notifications (email/SMS) for outbid/won.
10. Not built yet: web app, child-login provisioning via the Keycloak Admin API, credential vault for external-platform passwords,
    payments port, dependency/secret scanning in CI, third-party penetration test.

## Next
5. Staff admin endpoints (auctions, lots, invitations, margin rules, limits, security settings, Excel import) + Socket.IO Redis adapter ·
6. Next.js web app on Keycloak (Auth.js, tokens kept server-side) · 7. Vault, payments, audit shipping, CI security scanning, penetration test.
