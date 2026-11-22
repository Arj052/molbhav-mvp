// Database access. Works with a local SQLite file (on your Mac) or a hosted Turso/libSQL database
// (on Vercel), chosen by DATABASE_URL. All queries use bound parameters (no string-built SQL).
//   local (default): file:./data/molbhav.db
//   hosted:          DATABASE_URL=libsql://<db>.turso.io  +  DATABASE_AUTH_TOKEN=...
// (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN, as set by the Vercel–Turso integration, also work.)
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

// DATABASE_URL + DATABASE_AUTH_TOKEN (a fixed database) win over TURSO_* — on Vercel the Turso
// integration points TURSO_* at a fresh branch per deployment, which would lose data on every deploy.
const fixed = process.env.DATABASE_URL && process.env.DATABASE_AUTH_TOKEN;
const url = (fixed ? process.env.DATABASE_URL : process.env.TURSO_DATABASE_URL)
  || 'file:' + (process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, 'data', 'molbhav.db'));
const authToken = fixed ? process.env.DATABASE_AUTH_TOKEN : process.env.TURSO_AUTH_TOKEN;
const isFile = url.startsWith('file:');
// On Vercel a local file would live in a throwaway server copy and silently lose data. Refuse.
if (isFile && process.env.VERCEL) throw new Error('[db] No hosted database configured (TURSO_DATABASE_URL / DATABASE_URL missing).');
if (isFile) fs.mkdirSync(path.dirname(url.slice(5)), { recursive: true });

const client = createClient({ url, authToken });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  business      TEXT,
  business_type TEXT,
  city          TEXT,
  created_at    TEXT NOT NULL,
  last_login_at TEXT,
  login_count   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  is_admin   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  detail TEXT,
  at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mandi_prices (
  day    TEXT NOT NULL,   -- YYYY-MM-DD (arrival date)
  veg    TEXT NOT NULL,   -- tomato | onion | potato
  market TEXT NOT NULL,   -- e.g. APMC Pune
  modal  REAL NOT NULL,   -- ₹/kg
  min    REAL,
  max    REAL,
  PRIMARY KEY (day, veg, market)
);
CREATE TABLE IF NOT EXISTS mandi_checked (
  day  TEXT NOT NULL,
  veg  TEXT NOT NULL,
  rows INTEGER NOT NULL,
  at   TEXT NOT NULL,
  PRIMARY KEY (day, veg)
);
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_login_events_at ON login_events(at);
`;

async function init() {
  if (isFile) await client.execute('PRAGMA journal_mode = WAL');
  await client.executeMultiple(SCHEMA);
  // Added later: Google sign-in id. Upgrade older databases in place.
  const has = await client.execute("SELECT 1 FROM pragma_table_info('users') WHERE name = 'google_sub'");
  if (!has.rows.length) {
    // two server copies can start at once; if the other one added the column first, that's fine
    try { await client.execute('ALTER TABLE users ADD COLUMN google_sub TEXT'); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
  await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub)');
}
// Set up the schema once per server copy. If it fails (e.g. a network blip to the hosted database),
// forget the failure so the next request tries again, instead of failing every request from then on.
let readyPromise = null;
function ready() {
  if (!readyPromise) {
    readyPromise = init().then(async () => {
      const n = (await client.execute('SELECT COUNT(*) AS n FROM users')).rows[0].n;
      console.log(`[db] ready: ${isFile ? 'local file' : 'hosted ' + url.split('://')[0] + ' ' + url.replace(/^[a-z]+:\/\//, '').split('/')[0].replace(/^([^.-]{3})[^.]*/, '$1***')}, users=${n}`);
    }).catch((e) => {
      console.error('[db] setup failed, will retry on next request:', e.message);
      readyPromise = null;
      throw e;
    });
  }
  return readyPromise;
}
ready().catch(() => {}); // start connecting straight away

// The site runs in Mumbai (data.gov.in only accepts Indian connections) and the database is in the US,
// so retry a query once or twice on a brief network error instead of failing the request.
// Reads retry on any brief network error; writes only when the connection never opened (so nothing
// could have been saved twice).
const why = (e) => String(e && (e.message + ' ' + (e.cause ? (e.cause.code || '') + ' ' + (e.cause.message || '') : '')));
const transient = (e) => /fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|timeout/i.test(why(e));
const neverConnected = (e) => /ECONNREFUSED|EAI_AGAIN|ENOTFOUND|connect ETIMEDOUT/i.test(why(e));
async function withRetry(fn, isRead) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (isFile || attempt >= 2 || !(isRead ? transient(e) : neverConnected(e))) throw e;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
}
const exec = (sql, args) => withRetry(() => client.execute({ sql, args }), /^\s*select/i.test(sql));
module.exports = {
  ready,
  isFile,
  // where the data lives, for the admin health check (host only, never the token)
  where: () => (isFile ? 'local file' : 'hosted: ' + url.replace(/^libsql:\/\/|^https:\/\//, '').split('/')[0].replace(/^([^.-]{3})[^.]*/, '$1***')),
  get: async (sql, ...args) => (await exec(sql, args)).rows[0],
  all: async (sql, ...args) => (await exec(sql, args)).rows,
  run: async (sql, ...args) => { const r = await exec(sql, args); return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid) }; },
  // several writes that must all succeed or fail together
  batch: (stmts) => withRetry(() => client.batch(stmts.map(([sql, ...args]) => ({ sql, args })), 'write'), false),
  client,
};
