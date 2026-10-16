// Dual-driver database layer.
//
//   Development (laptop)  -> DB_DRIVER=sqlite  (local file, zero setup)
//   Production (TiDB Cloud) -> DB_DRIVER=tidb   (mysql2 pool, TLS on)
//
// All access is async (TiDB is network I/O, so even the SQLite path is
// wrapped in promises to keep one calling convention):
//   dbGet(sql, params) -> single row | undefined
//   dbAll(sql, params) -> rows[]
//   dbRun(sql, params) -> { changes }
//   dbExec(sql)        -> DDL / multi-statement scripts (PRAGMA/VACUUM are no-ops on TiDB)
//   dbPrepare(sql)     -> { get, all, run } for statements reused in loops
//   getSetting/setSetting, pingDb, applyViews, initDb, dbInfo
//
// SQLite-isms in app SQL are translated for TiDB in translateSql():
//   datetime('now')                -> UTC ISO-8601 string (same format the app writes)
//   julianday(x)                   -> (UNIX_TIMESTAMP(x)/86400)  (fractional-day math preserved)
//   ON CONFLICT..DO UPDATE         -> ON DUPLICATE KEY UPDATE
//   ON CONFLICT..DO NOTHING        -> INSERT IGNORE
//   a.rowid                        -> a.created_at
//   "identifiers"                  -> `identifiers`
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const rawDriver = String(process.env.DB_DRIVER || (process.env.TIDB_HOST ? 'tidb' : 'sqlite')).toLowerCase();
export const dbDriver = rawDriver === 'mysql' ? 'tidb' : rawDriver; // 'mysql' accepted as alias
export const isTidb = dbDriver === 'tidb';

if (!['sqlite', 'tidb'].includes(dbDriver)) {
  throw new Error(`Bad DB_DRIVER=${process.env.DB_DRIVER} — use "sqlite" (local dev) or "tidb" (TiDB Cloud production).`);
}

// ---------------------------------------------------------------- sqlite ---
let sqliteDb = null;
if (!isTidb) {
  const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'tally.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  sqliteDb = new DatabaseSync(dbFile);
  sqliteDb.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  sqliteDb.exec(schema);
}

// ------------------------------------------------------------------ tidb ---
let pool = null;

function sslEnabled(overrides = {}) {
  if (overrides.ssl !== undefined) return overrides.ssl !== false && overrides.ssl !== 'false';
  const v = String(process.env.TIDB_SSL ?? 'true').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no';
}

// Resolve TiDB connection options from explicit args, DATABASE_URL, or TIDB_* env.
// Callers pass {} to use env. Throws a human-readable error when incomplete.
export function tidbConfig(overrides = {}) {
  let host = overrides.host ?? process.env.TIDB_HOST;
  let port = Number(overrides.port ?? process.env.TIDB_PORT ?? 4000);
  let user = overrides.user ?? process.env.TIDB_USER;
  let password = overrides.password ?? process.env.TIDB_PASSWORD;
  let database = overrides.database ?? process.env.TIDB_DATABASE ?? 'tally';

  const url = overrides.url ?? process.env.DATABASE_URL;
  if (url && (!host || !user)) {
    const u = new URL(url);
    host = host || u.hostname;
    port = overrides.port ?? (u.port ? Number(u.port) : 4000);
    user = user || decodeURIComponent(u.username);
    password = password ?? decodeURIComponent(u.password);
    const dbFromPath = u.pathname?.replace(/^\//, '');
    if (dbFromPath) database = database && overrides.database === undefined && process.env.TIDB_DATABASE ? database : dbFromPath;
  }
  const missing = [];
  if (!host) missing.push('TIDB_HOST');
  if (!user) missing.push('TIDB_USER');
  if (!password) missing.push('TIDB_PASSWORD');
  if (missing.length) {
    throw new Error(
      `TiDB credentials incomplete — missing ${missing.join(', ')}. ` +
      `Get them from TiDB Cloud (tidbcloud.com) → your cluster → Connect, then set them in .env (dev) or the host's environment (production).`
    );
  }
  return { host, port, user, password, database, ssl: sslEnabled(overrides) };
}

async function getPool() {
  if (pool) return pool;
  let mysql;
  try {
    mysql = await import('mysql2/promise');
  } catch {
    throw new Error('mysql2 is not installed — run: npm install mysql2');
  }
  const cfg = tidbConfig();
  // 1) ensure the database exists (connect without a default db first)
  const { database, ...rest } = cfg;
  const admin = await mysql.createConnection({ ...rest, ssl: cfg.ssl ? { minVersion: 'TLSv1.2' } : undefined, connectTimeout: 10000 });
  try {
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database.replace(/`/g, '')}\` DEFAULT CHARACTER SET utf8mb4`);
  } finally {
    await admin.end();
  }
  // 2) pooled connections for everything else
  pool = mysql.createPool({
    ...rest,
    database,
    ssl: cfg.ssl ? { minVersion: 'TLSv1.2' } : undefined,
    waitForConnections: true,
    connectionLimit: 5,
    connectTimeout: 10000,
    dateStrings: true, // dates come back as 'YYYY-MM-DD [HH:MM:SS]' strings, like SQLite
  });
  return pool;
}

// One-off credential check for the admin "test connection" endpoint.
// Never touches the runtime pool.
export async function testTidbConnection(opts = {}) {
  let mysql;
  try {
    mysql = await import('mysql2/promise');
  } catch {
    throw new Error('mysql2 is not installed — run: npm install mysql2');
  }
  const cfg = tidbConfig(opts);
  const started = Date.now();
  const conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
    ssl: cfg.ssl ? { minVersion: 'TLSv1.2' } : undefined,
    connectTimeout: 8000,
  });
  try {
    await conn.query('SELECT 1');
    return { ok: true, host: cfg.host, port: cfg.port, user: cfg.user, latency_ms: Date.now() - started };
  } finally {
    await conn.end();
  }
}

// ------------------------------------------------------- sql translation ---
export function translateSql(sql) {
  if (!isTidb) return sql;
  let out = sql;
  out = out.replace(/datetime\(\s*'now'\s*\)/gi, `DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%SZ')`);
  out = out.replace(/julianday\(\s*'now'\s*\)/gi, '(UNIX_TIMESTAMP()/86400)');
  out = out.replace(/julianday\(([^)]+)\)/gi, '(UNIX_TIMESTAMP($1)/86400)');
  out = out.replace(/ON CONFLICT\s*\([^)]*\)\s*DO UPDATE SET\s+(\w+)\s*=\s*excluded\.(\w+)/gi, 'ON DUPLICATE KEY UPDATE $1=VALUES($2)');
  if (/ON CONFLICT\s*\([^)]*\)\s*DO NOTHING/i.test(out)) {
    out = out.replace(/ON CONFLICT\s*\([^)]*\)\s*DO NOTHING/i, '');
    out = out.replace(/^(\s*INSERT\s+)INTO/i, '$1IGNORE INTO');
  }
  out = out.replace(/\b[aA]\.rowid\b/g, 'a.created_at');
  out = out.replace(/"([A-Za-z_][\w$]*)"/g, '`$1`');
  // KEY is reserved in MySQL/TiDB — quote it in the app_settings queries
  out = out.replace(/app_settings\s*\(\s*key\s*,/gi, 'app_settings(`key`,');
  out = out.replace(/WHERE\s+key\s*=/gi, 'WHERE `key`=');
  return out;
}

function isNoopOnTidb(sql) {
  return /^\s*(PRAGMA|VACUUM)\b/i.test(sql);
}

// ------------------------------------------------------------- primitives ---
export async function dbGet(sql, params = []) {
  if (!isTidb) return sqliteDb.prepare(sql).get(...params);
  const p = await getPool();
  const [rows] = await p.execute(translateSql(sql), params);
  return Array.isArray(rows) ? rows[0] : undefined;
}

export async function dbAll(sql, params = []) {
  if (!isTidb) return sqliteDb.prepare(sql).all(...params);
  const p = await getPool();
  const [rows] = await p.execute(translateSql(sql), params);
  return rows;
}

export async function dbRun(sql, params = []) {
  if (!isTidb) {
    const r = sqliteDb.prepare(sql).run(...params);
    return { changes: Number(r.changes ?? 0) };
  }
  const p = await getPool();
  const [res] = await p.execute(translateSql(sql), params);
  return { changes: Number(res?.affectedRows ?? 0) };
}

export async function dbExec(sql) {
  if (!isTidb) {
    sqliteDb.exec(sql);
    return;
  }
  if (isNoopOnTidb(sql)) return; // PRAGMA / VACUUM have no TiDB equivalent
  const p = await getPool();
  for (const stmt of String(sql).split(';')) {
    const s = translateSql(stmt).trim();
    if (!s || isNoopOnTidb(s)) continue;
    await p.query(s);
  }
}

// Reusable statement for tight loops (INSERT batches). SQLite prepares once;
// TiDB re-executes through the pool per call (same call signature).
export function dbPrepare(sql) {
  if (!isTidb) {
    const stmt = sqliteDb.prepare(sql);
    return {
      get: async (...params) => stmt.get(...params),
      all: async (...params) => stmt.all(...params),
      run: async (...params) => {
        const r = stmt.run(...params);
        return { changes: Number(r.changes ?? 0) };
      },
    };
  }
  const tsql = translateSql(sql);
  const execPool = async (params) => (await getPool()).execute(tsql, params);
  return {
    get: async (...params) => { const [rows] = await execPool(params); return Array.isArray(rows) ? rows[0] : undefined; },
    all: async (...params) => { const [rows] = await execPool(params); return rows; },
    run: async (...params) => { const [res] = await execPool(params); return { changes: Number(res?.affectedRows ?? 0) }; },
  };
}

export async function getSetting(key) {
  const row = await dbGet('SELECT value FROM app_settings WHERE key=?', [key]);
  return row?.value ?? null;
}

export async function setSetting(key, value) {
  await dbRun('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, value]);
}

export async function pingDb() {
  const started = Date.now();
  await dbGet('SELECT 1 AS ok');
  return { ok: true, latency_ms: Date.now() - started };
}

// Driver-aware DDL + reporting views. Safe to run on every boot:
// tables are CREATE IF NOT EXISTS; views are dropped + recreated so edits win.
export async function applyViews() {
  const file = isTidb ? 'views.tidb.sql' : 'views.sql';
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', file), 'utf8');
  const names = [...sql.matchAll(/CREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)].map(m => m[1]);
  if (!isTidb) {
    for (const n of names) { try { sqliteDb.exec(`DROP VIEW IF EXISTS ${n}`); } catch {} }
    sqliteDb.exec(sql);
    return names;
  }
  const p = await getPool();
  for (const n of names) { try { await p.query(`DROP VIEW IF EXISTS \`${n}\``); } catch {} }
  for (const stmt of sql.split(';')) {
    const s = stmt.trim();
    if (!s) continue;
    await p.query(s);
  }
  return names;
}

export async function initDb() {
  if (!isTidb) {
    await applyViews();
    return { driver: 'sqlite', file: process.env.DB_FILE || './data/tally.db' };
  }
  const cfg = tidbConfig(); // throws a helpful error when creds are missing
  await getPool();
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.tidb.sql'), 'utf8');
  await dbExec(schema);
  await applyViews();
  return { driver: 'tidb', host: cfg.host, database: cfg.database };
}

export async function dbInfo() {
  const base = { driver: dbDriver };
  if (!isTidb) return { ...base, file: process.env.DB_FILE || './data/tally.db' };
  try {
    const cfg = tidbConfig();
    return { ...base, host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, ssl: cfg.ssl };
  } catch (e) {
    return { ...base, configured: false, error: e.message };
  }
}

// Backwards-compat: some code paths import { db } for driver introspection only.
// NOTE: raw sync queries are gone — use dbGet/dbAll/dbRun/dbExec instead.
export const db = { driver: dbDriver, isTidb };
