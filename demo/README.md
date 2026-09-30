# Try the TELUS auction platform on your own computer

Everything runs on your computer only (addresses start with `http://localhost`). Nothing is put on the internet.
**Demo only:** the passwords below are public. Never use this setup for real customers — see `infra/aws` for that.

## 1. Install once
- **Docker Desktop** (Windows or Mac): https://www.docker.com/products/docker-desktop — install it and start it.
- **Git**, or download the project as a ZIP from GitHub (green "Code" button → "Download ZIP") and unzip it.

## 2. Start the demo
Open a terminal (Windows: "PowerShell", Mac: "Terminal") in the project folder and run:

```
docker compose -f demo/docker-compose.yml up --build
```

The first start takes 5–10 minutes (it builds the app). It is ready when you see **`Demo ready → open http://localhost:3000`**.
Keep that window open while you use the demo.

## 3. Open it
- The app: **http://localhost:3000** → "Sign in"
- The e-mails the platform sends (outbid alerts, results, invoices): **http://localhost:8025**

Every account uses the password **`Demo-Passw0rd!2026`**

| Sign in as | Role | What you can do |
|---|---|---|
| `admin@telus.test` | Staff — super admin | Everything: auctions, customers, margin rules, security settings |
| `manager@telus.test` | Staff — auction manager | Create auctions, add lots, invite customers, schedule, finalise |
| `finance@telus.test` | Staff — finance | Invoices, mark as paid |
| `viewonly@telus.test` | Staff — view only | Look, never change |
| `admin@alpha.test` | Customer admin — Alpha Trading LLC | Bid, invoices, create logins for their own team |
| `viewer@alpha.test` | Customer viewer — Alpha Trading LLC | Watch auctions, cannot bid |
| `admin@beta.test` | Customer admin — Beta Mobile FZE | Bid against Alpha |
| `bidder@beta.test` | Customer bidder — Beta Mobile FZE | Bid |

**Staff need a phone.** The first time a staff account signs in, it shows a QR code: scan it with Google Authenticator,
Microsoft Authenticator or FreeOTP and type the 6-digit code. From then on staff always enter a code from the app (the
same as production). Customer accounts sign in with the password only.

**Ready-made data:** two customer companies, an auction that is **live now** (6 lots of phones, closes in 3 days) and one that
opens tomorrow. Tip: open two different browsers (e.g. Chrome and Edge, or one private window), sign in as `admin@alpha.test`
in one and `bidder@beta.test` in the other, and bid against each other — prices and "Leading / Outbid" change live.

## 4. Stop, restart, reset
- Stop: press `Ctrl+C` in the terminal window (your data is kept).
- Start again: the same command as in step 2 (much faster after the first time).
- Start from scratch (deletes all demo data): `docker compose -f demo/docker-compose.yml down -v`

Card payments are switched off in the demo (they need a Stripe test account); bank-transfer invoices work.
