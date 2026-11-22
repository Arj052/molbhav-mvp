# MolBhav MVP — early-access site + private admin panel

Two links, one small app:

| Link | Who | What it does |
|---|---|---|
| `https://your-domain/` | Anyone you share it with | One-page MolBhav site. People sign up / log in and see their own details. |
| `https://your-domain/admin-XXXXXXXX/` | **Only you** | Admin panel: count of people, logins, search, export CSV, remove people. |

The admin link is a long random path that only you know, and it is still locked behind your
email + password (+ a 6-digit authenticator code if you turn it on). Guessing `/admin` just returns "Not found".

## Run it on your laptop

```bash
npm install
npm run setup-admin        # asks for your admin email + password, prints secrets
cp .env.example .env       # paste the printed lines into .env
npm start                  # open http://localhost:3000
```

Your admin panel is at `http://localhost:3000` + the `ADMIN_PATH` value from `.env`.

## Put it online (Render — free to start)

1. Push this folder to a **private** GitHub repo (`.env` and the database are already git-ignored).
2. On render.com: **New → Web Service**, pick the repo.
   - Build command: `npm install`  · Start command: `npm start`
3. **Environment** tab — add these (values from `npm run setup-admin`):
   `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`, `ADMIN_PATH`, `ADMIN_TOTP_SECRET` (optional),
   `NODE_ENV=production`, `DB_PATH=/var/data/molbhav.db`
4. **Disks** tab — add a disk mounted at `/var/data` so sign-ups survive restarts
   (Render's free tier has no disk; the cheapest paid instance does. Railway or Fly.io volumes work the same way).
5. Share `https://<your-app>.onrender.com/` with people. Keep `https://<your-app>.onrender.com/<ADMIN_PATH>/` to yourself.

## What keeps it secure

- **No secrets in the browser.** The site's HTML/JS contains no keys, hashes or the admin path.
  Everything sensitive lives in environment variables on the server.
- **Passwords** are hashed with bcrypt (cost 12). Your admin password is never stored, only its hash.
- **Sessions** are random 256-bit tokens in `HttpOnly`, `SameSite=Strict`, `Secure` (in production) cookies;
  only a SHA-256 of each token is stored. User and admin sessions are completely separate:
  the admin cookie is only ever sent to the secret admin path, and a user cookie can never reach admin data.
- **Optional 2-step login** for admin with any authenticator app (Google Authenticator, Authy).
- **Removing a person** deletes their account and signs them out instantly on every device.
- **Brute-force protection:** 5 admin sign-in attempts / 15 min per IP, 20 for users.
- **Forgery protection:** every change needs a same-origin JSON request with a custom header that other websites cannot send.
- **Strict security headers** (Content-Security-Policy, no framing, HSTS in production), no stack traces leaked,
  parameterised SQL everywhere, and every name/email is rendered as plain text (no script injection).
- **Audit log** in the admin panel shows admin sign-ins, failed attempts and removals.

## Change things

- Price / copy on the public page: `public/index.html`
- Sign-up fields: `public/index.html` + `/api/signup` in `server.js`
- Admin table columns: `admin/admin.html` + `admin/admin.js`

Rotating your admin password: run `npm run setup-admin` again and update the variables on your host.

## Optional: "Continue with Google" button

The button only appears once you add a Google Client ID. It's free.

1. Go to https://console.cloud.google.com → create a project (e.g. "MolBhav").
2. **APIs & Services → OAuth consent screen**: choose **External**, app name "MolBhav", your email as support + developer contact. Save. Under **Audience**, click **Publish app** so anyone can sign in (basic sign-in needs no Google review).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** → type **Web application**.
4. Under **Authorised JavaScript origins**, add your site address exactly, with no path or trailing slash, e.g.
   `https://your-site.onrender.com` (and `http://localhost:3000` for local testing). Redirect URIs: leave empty.
5. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) into `.env` as `GOOGLE_CLIENT_ID=…`, then restart (`npm start`).

The Client ID is public — Google shows it in the browser. There is **no client secret** to store: the server
verifies every Google sign-in token itself (signature, audience, expiry, verified email).

Note: a `trycloudflare.com` address changes every time you restart the tunnel, and each new address must be added
to step 4 again. A fixed address (Render) avoids this.
