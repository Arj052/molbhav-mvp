# MolBhav MVP — project brief for Claude Code

## What this is
Early-access web app for **MolBhav**, a Pune startup that forecasts mandi (wholesale) prices for
tomatoes and onions and tells restaurants / cloud kitchens what to buy and when. Owner: Arjun.
Planned price: ₹149/month (free during the pilot).

Two separate links:
- **Public site** `/` — one page; people sign up / log in and see only their own details.
- **Admin panel** `ADMIN_PATH` (a long random path from `.env`) — owner only: counts, search,
  CSV export, remove people, audit log.

## Stack
- Node.js ≥ 18, Express 4, better-sqlite3 (single SQLite file), bcryptjs, helmet,
  express-rate-limit, cookie-parser, otplib (admin 2-step codes), dotenv.
- No frontend framework: plain HTML/CSS/JS. CSP forbids inline scripts and styles.

## Layout
- `server.js` — all routes. Public API under `/api/*`; admin router mounted at `ADMIN_PATH`
  (admin API = `ADMIN_PATH/api/*`, admin static = `ADMIN_PATH/static/*`).
- `db.js` — schema: `users`, `sessions` (token SHA-256 hashes), `login_events`, `audit_log`.
- `public/` — `index.html`, `styles.css`, `app.js` (public site).
- `admin/` — `admin.html`, `admin.css`, `admin.js` (served only under `ADMIN_PATH`).
- `scripts/setup-admin.js` — prints `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`, `ADMIN_PATH`, `ADMIN_TOTP_SECRET`.

## Commands
- `npm install`
- `npm run setup-admin` → paste output into `.env` (copy from `.env.example`)
- `npm start` → http://localhost:3000 ; admin at http://localhost:3000<ADMIN_PATH>/

## Security rules — do not weaken these
1. Never put secrets, the admin path, hashes or keys in anything under `public/` or `admin/`,
   in git, or in logs. Secrets come only from environment variables. `.env` stays git-ignored.
2. Every admin API route must use `requireAdmin`. User sessions (`is_admin = 0`) must never
   reach admin data; the admin cookie is scoped to `ADMIN_PATH`.
3. Every state-changing request must keep the CSRF guard: custom header `X-MB-Request: 1`,
   same-origin `Origin`, JSON body. Frontend `fetch` helpers already send the header.
4. Use bound SQL parameters only. Render user data with `textContent`, never `innerHTML`.
5. Keep bcrypt cost 12, rate limits on auth routes, generic login error messages,
   `DUMMY_HASH` timing protection, and session revocation on user removal (FK cascade).
6. Keep the CSP strict (`'self'` only). If an external service is added, extend the CSP narrowly.

## Status
- Built and tested: signup/login/logout, admin login with optional TOTP, stats, search,
  CSV export, remove user (instantly signs them out), audit log, rate limiting, CSRF guard.
- **Deployed on Vercel** (free Hobby): https://molbhav-gamma.vercel.app (project `molbhav`, team `grow-cd25`).
  Deploy with `npx vercel@latest deploy --prod --yes` from this folder (already linked via `.vercel/`).

## Hosting + database (Vercel + Turso) — read before touching the DB setup
- `db.js` uses `@libsql/client`: local file `data/molbhav.db` on the Mac; hosted Turso on Vercel.
- **The Vercel–Turso integration points `TURSO_DATABASE_URL` at a NEW empty branch per deployment**
  (`dpl-…`). Never rely on it: production uses `DATABASE_URL` + `DATABASE_AUTH_TOKEN` (Vercel env,
  Production) for the fixed database `database-cyan-cable`. `db.js` only uses `DATABASE_URL` when the
  token is also set, and refuses a local file on Vercel. Startup logs `[db] ready: … users=N` (check with
  `npx vercel@latest logs --environment production --since 5m`).
- `vercel.json` pins the function to **`bom1` (Mumbai)**: api.data.gov.in REFUSES connections from outside
  India (ECONNREFUSED from iad1). The Turso DB is in aws-us-east-1, so queries cross the world: reads retry
  on network errors, writes only when the connection never opened; `db.ready()` retries; pages/files don't
  wait for the DB; `/api/prices` is CDN-cached 5 min. Moving the DB to a Turso Mumbai region would help.
- **Real prices** (`prices.js`): AGMARKNET via data.gov.in — history resource 35985678-…, today resource
  9ef84268-…; stored in `mandi_prices` (₹/kg, per day × veg × Pune mandi) + `mandi_checked`. Visitors trigger
  a top-up of today/yesterday at most every 30 min (6 s budget). Admin `POST <ADMIN_PATH>/api/prices/backfill`
  {days,maxTasks} fills history in chunks. Uses data.gov.in's public sample key unless `DATA_GOV_API_KEY`
  is set (heavily throttled: 429s). Forecast/signal = statistical estimate, labelled as such.
- The Turso integration resource is **disconnected** from the project (2026-11-21), so deploys no longer
  create `dpl-…` branches and `TURSO_*` vars are gone. Don't reconnect it. Turso should contain only
  `database-cyan-cable`.
- The one-time import route was removed after migrating. Vercel CLI cannot delete env vars without
  approval; use the dashboard (or overwrite with `env add … --force`).
- `scripts/push-env-to-vercel.sh` copies admin settings from `.env` to Vercel (parses with dotenv).
- Every app origin must be in Google Cloud → OAuth client "MolBhav website" → Authorised JavaScript origins.
- The old Mac-hosting launch agents are parked in `~/Library/Application Support/MolBhav/disabled-launch-agents/`.

## Good next steps
- Add password reset by email (needs an email provider key — server-side env var only).
- Add an automated test suite (e.g. node:test + supertest) covering the security rules above.
- Optional: admin "invite-only" mode, user email verification, daily SQLite backups.

## Style
Brand colours: ink `#111412`, tomato `#E2483A`, leaf `#4CAF6A`, paper `#F7F4EE`, mute `#A9AFA8`.
Keep copy short and plain. Indian context, ₹ prices.

## Google sign-in (added)
- Optional, enabled by `GOOGLE_CLIENT_ID` in `.env` (public value; no client secret is used).
- `POST /api/google` verifies Google's ID token server-side with `google-auth-library` (audience, issuer, expiry, `email_verified`), links by `google_sub`, then by verified email; the admin email is refused.
- CSP allows only `https://accounts.google.com/gsi/*`, and only when the Client ID is set.

## Look & animation (added)
- Red & black theme with a fixed red-black gradient background, drifting glow orbs and grain (`.bg-fx` in index.html, styles at the end of styles.css).
- Animations use Motion (motion.dev), served from `/vendor/motion.js` (node_modules, keeps CSP self-only) and driven by `public/motion-fx.js` (progress bar, hero parallax, word-by-word headings, staggered reveals, hover springs, pointer spotlight). It no-ops without Motion or with reduced motion; bump `?v=` on its script tag when changing it (Vercel caches).
