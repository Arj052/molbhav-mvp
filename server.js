// MolBhav early-access site + private admin panel.
// Secrets live only in environment variables (.env locally, host's secret settings in production).
require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const db = require('./db');
const { getPrices, backfill, storeCurrent } = require('./prices');

// ---------- configuration (fail fast if anything sensitive is missing) ----------
const {
  ADMIN_EMAIL,
  ADMIN_PASSWORD_HASH,
  ADMIN_PATH,
  ADMIN_TOTP_SECRET, // optional: enables 2-step codes for the admin login
  GOOGLE_CLIENT_ID, // optional: shows "Continue with Google" (public value, not a secret)
  PORT = 3000,
  NODE_ENV = 'development',
} = process.env;

function fatal(msg) {
  console.error(`\n[config] ${msg}\nRun "npm run setup-admin" and copy the values into .env (or the host's environment settings)\n`);
  if (require.main === module) process.exit(1);
  throw new Error('[config] ' + msg); // on Vercel: fail the function instead of killing the process
}
if (!ADMIN_EMAIL) fatal('ADMIN_EMAIL is missing.');
if (!ADMIN_PASSWORD_HASH || !ADMIN_PASSWORD_HASH.startsWith('$2')) fatal('ADMIN_PASSWORD_HASH is missing or not a bcrypt hash.');
if (!ADMIN_PATH || !/^\/[A-Za-z0-9_-]{16,}$/.test(ADMIN_PATH)) fatal('ADMIN_PATH must look like /something-long-and-random (16+ letters, digits, - or _).');

if (GOOGLE_CLIENT_ID && !/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(GOOGLE_CLIENT_ID)) {
  fatal('GOOGLE_CLIENT_ID does not look like a Google OAuth Client ID (…apps.googleusercontent.com). Leave it empty to turn Google sign-in off.');
}
const googleClient = GOOGLE_CLIENT_ID ? new (require('google-auth-library').OAuth2Client)(GOOGLE_CLIENT_ID) : null;
const GSI = 'https://accounts.google.com/gsi/';
const GSI_STYLE_HASHES = ["'sha256-88QphsXJQwxKP9xXR175ZSMzpaq6Swzj9u3QQ+G2Wig='", "'sha256-0XbXxDziHuSSx+6TUE+FAaDsbSyh3wmRLaFKB5hZFbI='", "'sha256-hgbRMsQMUDZBacla5b1vKB8A7KZsFAXmRoHW/edmKAE='", "'sha256-qhuPdMIyitsie5l+rVqi1rLMM5kKX8GH2i6ece7IvkY='"];

const IS_PROD = NODE_ENV === 'production';
const USER_COOKIE = IS_PROD ? '__Host-mb_session' : 'mb_session';
const ADMIN_COOKIE = 'mb_admin';
const USER_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days
const ADMIN_TTL_MS = 8 * 3600 * 1000; // 8 hours
const BUSINESS_TYPES = ['Independent restaurant', 'Cloud kitchen', 'Café', 'Small food business', 'Other'];
// Used so a login for an unknown email takes as long as a real one (no account probing by timing).
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

// Express 4 doesn't catch errors thrown inside async handlers; route them to the error handler instead of crashing.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

const app = express();
app.disable('x-powered-by');
// Wait for the database before routes that use it. Pages, files and prices don't need it, so the
// site still loads (and retries the database on the next request) during a database hiccup.
const NO_DB = new Set(['/', '/api/options', '/vendor/lightweight-charts.js', '/vendor/motion.js']);
app.use((req, res, next) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && (NO_DB.has(req.path) || /\.[a-z0-9]+$/i.test(req.path))) return next();
  db.ready().then(() => next(), next);
});
if (IS_PROD) app.set('trust proxy', 1); // behind the host's HTTPS proxy

// ---------- security headers ----------
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      // Google's sign-in button is the only outside code allowed, and only when GOOGLE_CLIENT_ID is set.
      'script-src': ["'self'", ...(googleClient ? [GSI + 'client'] : [])],
      // Google's button sets three small inline styles; allow exactly those (by hash), nothing else.
      'style-src': ["'self'", ...(googleClient ? [GSI + 'style', "'unsafe-hashes'", ...GSI_STYLE_HASHES] : [])],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'", ...(googleClient ? [GSI] : [])],
      'frame-src': googleClient ? [GSI] : ["'none'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      'base-uri': ["'none'"],
      'object-src': ["'none'"],
      'upgrade-insecure-requests': IS_PROD ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  // Google's sign-in popup needs these two relaxed slightly; still blocks other sites.
  crossOriginOpenerPolicy: { policy: googleClient ? 'same-origin-allow-popups' : 'same-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: IS_PROD ? { maxAge: 31536000, includeSubDomains: true } : false,
}));
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

// ---------- CSRF defence: state-changing requests must be same-origin JSON ----------
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // A custom header can't be added by another website without a CORS preflight, which this server never allows.
  if (req.get('x-mb-request') !== '1') return res.status(403).json({ error: 'Forbidden.' });
  const hasBody = Number(req.get('content-length') || 0) > 0 || req.get('transfer-encoding');
  if (hasBody && !req.is('application/json')) return res.status(415).json({ error: 'Unsupported request.' });
  const origin = req.get('origin');
  if (origin) {
    const host = req.get('host');
    try {
      if (new URL(origin).host !== host) return res.status(403).json({ error: 'Forbidden.' });
    } catch { return res.status(403).json({ error: 'Forbidden.' }); }
  }
  next();
});

// ---------- helpers ----------
const now = () => new Date().toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const audit = (action, detail) => db.run('INSERT INTO audit_log(action, detail, at) VALUES (?,?,?)', action, detail || null, now());

async function createSession(res, { userId = null, isAdmin = false }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = isAdmin ? ADMIN_TTL_MS : USER_TTL_MS;
  await db.batch([
    ['DELETE FROM sessions WHERE expires_at < ?', now()], // tidy up expired sessions as we go
    ['INSERT INTO sessions(token_hash, user_id, is_admin, created_at, expires_at) VALUES (?,?,?,?,?)',
      sha256(token), userId, isAdmin ? 1 : 0, now(), new Date(Date.now() + ttl).toISOString()],
  ]);
  res.cookie(isAdmin ? ADMIN_COOKIE : USER_COOKIE, token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'strict',
    maxAge: ttl,
    path: isAdmin ? ADMIN_PATH : '/', // the admin cookie is only ever sent to the secret admin path
  });
}

async function readSession(req, isAdmin) {
  const token = req.cookies[isAdmin ? ADMIN_COOKIE : USER_COOKIE];
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const row = await db.get('SELECT * FROM sessions WHERE token_hash = ?', sha256(token));
  if (!row || row.expires_at < now() || Boolean(row.is_admin) !== isAdmin) return null;
  return row;
}

async function endSession(req, res, isAdmin) {
  const token = req.cookies[isAdmin ? ADMIN_COOKIE : USER_COOKIE];
  if (token && typeof token === 'string') await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  res.clearCookie(isAdmin ? ADMIN_COOKIE : USER_COOKIE, { path: isAdmin ? ADMIN_PATH : '/', secure: IS_PROD, sameSite: 'strict', httpOnly: true });
}

const publicUser = (u) => ({
  name: u.name, email: u.email, business: u.business, businessType: u.business_type, city: u.city,
  joinedAt: u.created_at, viaGoogle: Boolean(u.google_sub),
  needsProfile: !u.business || !u.business_type, // e.g. after Google sign-up: ask for business details
});

function recordLogin(userId) {
  const t = now();
  return db.batch([
    ['UPDATE users SET last_login_at = ?, login_count = login_count + 1 WHERE id = ?', t, userId],
    ['INSERT INTO login_events(user_id, at) VALUES (?,?)', userId, t],
  ]);
}

async function getStats() {
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const c = async (sql, ...a) => (await db.get(sql, ...a)).c;
  const [totalUsers, newThisWeek, loginsToday, activeNow, totalLogins, byType, recentLogins] = await Promise.all([
    c('SELECT COUNT(*) c FROM users'),
    c('SELECT COUNT(*) c FROM users WHERE created_at >= ?', weekAgo),
    c('SELECT COUNT(*) c FROM login_events WHERE at >= ?', dayAgo),
    c('SELECT COUNT(DISTINCT user_id) c FROM sessions WHERE is_admin = 0 AND expires_at > ?', now()),
    c('SELECT COALESCE(SUM(login_count),0) c FROM users'),
    db.all("SELECT COALESCE(business_type,'Not given') type, COUNT(*) count FROM users GROUP BY 1 ORDER BY 2 DESC"),
    // newest logins, so the live dashboard can say who just logged in
    db.all('SELECT e.id, u.name, e.at FROM login_events e JOIN users u ON u.id = e.user_id ORDER BY e.id DESC LIMIT 5'),
  ]);
  return { totalUsers, newThisWeek, loginsToday, activeNow, totalLogins, byType, recentLogins };
}

// ---------- rate limits ----------
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts. Try again in a few minutes.' } });
const adminLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts. Try again later.' } });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });

// =====================================================================
// PUBLIC SITE  (link 1:  https://your-domain/ )
// =====================================================================
app.use('/api', apiLimiter);

app.post('/api/signup', authLimiter, wrap(async (req, res) => {
  const name = clean(req.body.name, 80);
  const email = clean(req.body.email, 254).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const business = clean(req.body.business, 100);
  const businessType = clean(req.body.businessType, 40);
  const city = clean(req.body.city, 60);

  if (!name) return res.status(400).json({ error: 'Please enter your name.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email.' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be 8–128 characters.' });
  if (businessType && !BUSINESS_TYPES.includes(businessType)) return res.status(400).json({ error: 'Please choose a business type.' });
  if (email === ADMIN_EMAIL.toLowerCase()) return res.status(400).json({ error: 'This email cannot be used here.' });

  const hash = await bcrypt.hash(password, 12);
  try {
    const info = await db.run('INSERT INTO users(name, email, password_hash, business, business_type, city, created_at) VALUES (?,?,?,?,?,?,?)',
      name, email, hash, business || null, businessType || null, city || null, now());
    await recordLogin(info.lastInsertRowid);
    await createSession(res, { userId: info.lastInsertRowid });
    const u = await db.get('SELECT * FROM users WHERE id = ?', info.lastInsertRowid);
    return res.status(201).json({ user: publicUser(u) });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
    console.error(e);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}));

app.post('/api/login', authLimiter, wrap(async (req, res) => {
  const email = clean(req.body.email, 254).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password.slice(0, 128) : '';
  const u = await db.get('SELECT * FROM users WHERE email = ?', email);
  const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) return res.status(401).json({ error: 'Invalid email or password.' });
  await recordLogin(u.id);
  await createSession(res, { userId: u.id });
  res.json({ user: publicUser(u) });
}));

// Sign in / sign up with Google. The browser sends Google's signed ID token; we verify it here
// (signature, audience = our Client ID, issuer, expiry) and never trust anything the browser claims.
app.post('/api/google', authLimiter, wrap(async (req, res) => {
  if (!googleClient) return res.status(404).json({ error: 'Google sign-in is not enabled.' });
  const credential = typeof req.body.credential === 'string' ? req.body.credential : '';
  if (!credential || credential.length > 4096) return res.status(400).json({ error: 'Google sign-in failed. Please try again.' });
  let p;
  try {
    p = (await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID })).getPayload();
  } catch (e) {
    return res.status(401).json({ error: 'Google sign-in failed. Please try again.' });
  }
  if (!p || !p.sub || !p.email || p.email_verified !== true) return res.status(401).json({ error: 'Your Google email is not verified.' });
  const email = String(p.email).toLowerCase().slice(0, 254);
  if (email === ADMIN_EMAIL.toLowerCase()) return res.status(400).json({ error: 'This email cannot be used here.' });

  let u = await db.get('SELECT * FROM users WHERE google_sub = ?', p.sub);
  if (!u) {
    u = await db.get('SELECT * FROM users WHERE email = ?', email);
    if (u && u.google_sub && u.google_sub !== p.sub) return res.status(409).json({ error: 'This email is linked to a different Google account.' });
    if (u) {
      // Google has verified they own this email, so link it to the existing account.
      await db.run('UPDATE users SET google_sub = ? WHERE id = ?', p.sub, u.id);
    } else {
      const name = clean(p.name || email.split('@')[0], 80) || 'Google user';
      // No password for Google accounts: store a hash of random bytes so password login can never match.
      const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      const info = await db.run('INSERT INTO users(name, email, password_hash, google_sub, city, created_at) VALUES (?,?,?,?,?,?)',
        name, email, unusable, p.sub, 'Pune', now());
      await audit('user_signup_google', `id=${info.lastInsertRowid}`);
      u = { id: info.lastInsertRowid };
    }
    u = await db.get('SELECT * FROM users WHERE id = ?', u.id);
  }
  await recordLogin(u.id);
  await createSession(res, { userId: u.id });
  res.json({ user: publicUser(u) });
}));

app.post('/api/logout', wrap(async (req, res) => { await endSession(req, res, false); res.json({ ok: true }); }));

app.get('/api/me', wrap(async (req, res) => {
  // Signed out is a normal state for the public page, so answer 200 with user: null (no console error).
  const s = await readSession(req, false);
  const u = s ? await db.get('SELECT * FROM users WHERE id = ?', s.user_id) : null;
  res.json({ user: u ? publicUser(u) : null });
}));

// Signed-in users add or edit their business details (asked right after Google sign-up).
app.post('/api/profile', wrap(async (req, res) => {
  const s = await readSession(req, false);
  if (!s) return res.status(401).json({ error: 'Please log in again.' });
  const business = clean(req.body.business, 100);
  const businessType = clean(req.body.businessType, 40);
  const city = clean(req.body.city, 60);
  if (!business) return res.status(400).json({ error: 'Please enter your business name.' });
  if (!BUSINESS_TYPES.includes(businessType)) return res.status(400).json({ error: 'Please choose a business type.' });
  await db.run('UPDATE users SET business = ?, business_type = ?, city = ? WHERE id = ?', business, businessType, city || null, s.user_id);
  const u = await db.get('SELECT * FROM users WHERE id = ?', s.user_id);
  if (!u) return res.status(401).json({ error: 'Please log in again.' });
  res.json({ user: publicUser(u) });
}));

// Real Pune mandi prices (AGMARKNET via data.gov.in), stored in our DB and refreshed automatically.
// Cached on Vercel's network for 5 minutes so the page stays fast and survives brief database blips
// (never cache an empty answer, e.g. while the very first prices are still being fetched).
app.get('/api/prices', wrap(async (req, res) => {
  const data = await getPrices();
  if (data.veg.length) {
    // browsers always re-check (so live updates show up); only Vercel's network keeps a 2-minute shared copy
    res.set('Cache-Control', 'no-cache');
    res.set('Vercel-CDN-Cache-Control', 'max-age=120, stale-while-revalidate=600');
  } else res.set('Cache-Control', 'no-store');
  res.json(data);
}));

app.get('/api/options', (req, res) => res.json({ businessTypes: BUSINESS_TYPES, googleClientId: GOOGLE_CLIENT_ID || null }));

// TradingView's open-source chart library, served from our own server so the CSP stays 'self'-only.
// Motion (motion.dev) animation library, also served from our own server.
app.get('/vendor/motion.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'node_modules', 'motion', 'dist', 'motion.js'));
});
app.get('/vendor/lightweight-charts.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.js'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html', dotfiles: 'deny',
  // photos never change: let browsers and Vercel's network keep them (fast tab switching, quick loads)
  setHeaders: (res, file) => { if (/[\\/]img[\\/]/.test(file)) res.set('Cache-Control', 'public, max-age=86400, s-maxage=604800'); },
}));

// =====================================================================
// ADMIN PANEL  (link 2:  https://your-domain/<ADMIN_PATH> — only you know it)
// =====================================================================
const admin = express.Router();

const requireAdmin = wrap(async (req, res, next) => {
  const s = await readSession(req, true);
  if (!s) return res.status(401).json({ error: 'Admin sign-in required.' });
  req.adminSession = s;
  next();
});

admin.post('/api/login', adminLoginLimiter, wrap(async (req, res) => {
  const email = clean(req.body.email, 254).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password.slice(0, 128) : '';
  const code = clean(req.body.code, 10).replace(/\s/g, '');
  const emailOk = crypto.timingSafeEqual(Buffer.from(sha256(email)), Buffer.from(sha256(ADMIN_EMAIL.toLowerCase())));
  const passOk = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  const codeOk = ADMIN_TOTP_SECRET ? authenticator.check(code, ADMIN_TOTP_SECRET) : true;
  if (!(emailOk && passOk && codeOk)) {
    await audit('admin_login_failed', `ip=${req.ip}`);
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  await createSession(res, { isAdmin: true });
  await audit('admin_login', `ip=${req.ip}`);
  res.json({ ok: true });
}));

admin.get('/api/config', (req, res) => res.json({ twoFactor: Boolean(ADMIN_TOTP_SECRET) }));

// Admin-only: fetch missing days of real mandi prices (used to fill ~3 months of history).
// Does a small chunk per call; call again until "remaining" is 0.
admin.post('/api/prices/backfill', requireAdmin, wrap(async (req, res) => {
  const days = Math.min(90, Math.max(1, Number.parseInt(req.body.days, 10) || 90));
  const maxTasks = Math.min(30, Math.max(1, Number.parseInt(req.body.maxTasks, 10) || 15));
  // newest day first (from the daily feed), then older days from the history feed
  const latest = await Promise.all(['tomato', 'onion', 'potato'].map((k) => storeCurrent(k).catch(() => 0)));
  res.json({ latestRows: latest.reduce((a, b) => a + b, 0), ...(await backfill(days, maxTasks, false)) }); // newest days come from the daily feed above
}));

// Admin-only health check: which database the site is using.
admin.get('/api/health', requireAdmin, wrap(async (req, res) => res.json({
  database: db.where(), users: (await db.get('SELECT COUNT(*) c FROM users')).c,
  envSeen: { TURSO_DATABASE_URL: Boolean(process.env.TURSO_DATABASE_URL), TURSO_AUTH_TOKEN: Boolean(process.env.TURSO_AUTH_TOKEN), DATABASE_URL: Boolean(process.env.DATABASE_URL) },
})));

admin.post('/api/logout', wrap(async (req, res) => { await endSession(req, res, true); res.json({ ok: true }); }));

admin.get('/api/session', requireAdmin, (req, res) => res.json({ ok: true }));

// The dashboard polls this every few seconds for its live numbers (quick Cloudflare tunnels can't stream).
admin.get('/api/stats', requireAdmin, wrap(async (req, res) => res.json(await getStats())));

admin.get('/api/users', requireAdmin, wrap(async (req, res) => {
  const q = clean(req.query.q, 100);
  const like = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
  const rows = await db.all(`
    SELECT id, name, email, business, business_type AS businessType, city, created_at AS joinedAt,
           last_login_at AS lastLoginAt, login_count AS loginCount, (google_sub IS NOT NULL) AS viaGoogle
    FROM users
    WHERE (? = '' OR name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR business LIKE ? ESCAPE '\\' OR city LIKE ? ESCAPE '\\')
    ORDER BY created_at DESC LIMIT 500`, q, like, like, like, like);
  res.json({ users: rows });
}));

admin.delete('/api/users/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Bad id.' });
  const u = await db.get('SELECT email FROM users WHERE id = ?', id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  // delete sessions + login history explicitly (hosted databases may not enforce cascades), so they are signed out at once
  await db.batch([
    ['DELETE FROM sessions WHERE user_id = ?', id],
    ['DELETE FROM login_events WHERE user_id = ?', id],
    ['DELETE FROM users WHERE id = ?', id],
  ]);
  await audit('user_removed', `id=${id}`);
  res.json({ ok: true });
}));

admin.get('/api/audit', requireAdmin, wrap(async (req, res) => {
  res.json({ events: await db.all('SELECT action, detail, at FROM audit_log ORDER BY id DESC LIMIT 50') });
}));

admin.use('/static', express.static(path.join(__dirname, 'admin'), { dotfiles: 'deny', index: false }));
admin.get('/', (req, res) => {
  if (!req.originalUrl.split('?')[0].endsWith('/')) return res.redirect(301, ADMIN_PATH + '/');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(__dirname, 'admin', 'admin.html'));
});

app.use(ADMIN_PATH, admin);

// Everything else, including guesses like /admin, gets a plain 404.
app.use((req, res) => res.status(404).type('text').send('Not found'));

// Never leak stack traces.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'Bad request.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

// Run as a normal server on the Mac (`node server.js`); on Vercel the app is exported instead (api/index.js).
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`MolBhav running on http://localhost:${PORT} (database: ${db.isFile ? 'local file' : 'hosted'})`);
    console.log(`Admin panel is at your secret ADMIN_PATH (not printed here).`);
  });
}
module.exports = app;
