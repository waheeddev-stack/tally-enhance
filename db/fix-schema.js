// Fix + verify SQL tables and columns:  npm run db:fix
// - Creates any tables missing from the driver's schema file (IF NOT EXISTS)
// - Adds any columns missing from the schema to old tables (ALTER TABLE)
// - Drops + recreates every view from the driver's views file (latest wins)
// - Backfills anomalies.created_at for rows predating that column
// - Prints a full health report (tables, columns, views, integrity)
// Safe to run any time: never deletes data, only adds what is missing.
// Works on both drivers: sqlite (local dev) and tidb (TiDB Cloud production).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbGet, dbAll, dbRun, dbExec, initDb, applyViews, dbDriver, dbInfo } from '../src/db.js';

await initDb();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const report = [];
let fixed = 0;

// ---- 1. parse expected columns out of the driver's schema file ----
function splitTop(body) {
  const parts = [];
  let depth = 0, cur = '', q = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (q) {
      cur += ch;
      if (ch === q) q = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}
function parseSchema(sql) {
  const tables = {};
  for (const stmt of sql.split(';')) {
    const m = stmt.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`\[]?(\w+)["'`\]]?\s*\(([\s\S]*)$/i);
    if (!m) continue;
    const defs = [];
    for (let part of splitTop(m[2])) {
      part = part.trim().replace(/\)\s*$/, '');
      if (!part || part === ')') continue;
      const first = part.split(/\s+/)[0].replace(/["'`\[\]]/g, '');
      if (/^(primary|unique|foreign|check|constraint|index|key)$/i.test(first)) continue;
      defs.push({ name: first, def: part });
    }
    tables[m[1]] = defs;
  }
  return tables;
}
const schemaFile = dbDriver === 'tidb' ? 'schema.tidb.sql' : 'schema.sql';
const expected = parseSchema(fs.readFileSync(path.join(__dirname, schemaFile), 'utf8'));

// ---- 2. add missing columns ----
async function existingColumns(table) {
  if (dbDriver === 'tidb') {
    const rows = await dbAll(
      'SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    return new Set(rows.map(r => r.name));
  }
  return new Set((await dbAll(`PRAGMA table_info(\`${table}\`)`)).map(r => r.name));
}
for (const [table, cols] of Object.entries(expected)) {
  let existing;
  try {
    existing = await existingColumns(table);
  } catch {
    report.push(`TABLE ${table}: missing entirely (will be created by schema)`);
    continue;
  }
  const added = [];
  // Strip a DEFAULT clause (respecting quotes + nested parens) for fallback use.
  const stripDefault = (def) => {
    const m = def.match(/\bDEFAULT\b/i);
    if (!m) return def;
    let out = def.slice(0, m.index), i = m.index + m[0].length, q = null, depth = 0;
    // skip whitespace, then one default value: balanced (...) expr or bare token
    while (i < def.length && /\s/.test(def[i])) i++;
    if (def[i] === '(') {
      const start = i;
      for (; i < def.length; i++) {
        const ch = def[i];
        if (q) { if (ch === q) q = null; continue; }
        if (ch === "'" || ch === '"' || ch === '`') { q = ch; continue; }
        if (ch === '(') depth++;
        if (ch === ')') { depth--; if (depth === 0) { i++; break; } }
      }
      out += def.slice(i).trim() ? ' ' + def.slice(i).trim() : '';
      return out.trim().replace(/\s+\)$/, ')');
    }
    const tail = def.slice(i);
    const tok = tail.match(/^[^\s,]+/);
    const rest = tok ? tail.slice(tok[0].length) : tail;
    return (out + rest).trim();
  };
  for (const c of cols) {
    if (existing.has(c.name)) continue;
    // SQLite forbids ADD COLUMN ... NOT NULL without default on filled tables:
    // relax to nullable (fresh tables still get the strict def from CREATE TABLE).
    const safe = dbDriver === 'sqlite' && /\bNOT\s+NULL\b/i.test(c.def) && !/\bDEFAULT\b/i.test(c.def)
      ? c.def.replace(/\bNOT\s+NULL\b/i, '') + ' /* relaxed from NOT NULL by db:fix */'
      : c.def;
    try {
      await dbExec(`ALTER TABLE \`${table}\` ADD COLUMN ${safe}`);
      added.push(c.name); fixed++;
    } catch (e) {
      // SQLite also forbids ADD COLUMN with a non-constant default
      // (e.g. strftime('now')). Retry without the default, then backfill.
      if (/\bDEFAULT\b/i.test(safe)) {
        try {
          await dbExec(`ALTER TABLE \`${table}\` ADD COLUMN ${stripDefault(safe)}`);
          added.push(c.name); fixed++;
          report.push(`TABLE ${table}: added ${c.name} without default (backfilled where possible)`);
          continue;
        } catch (e2) {
          report.push(`TABLE ${table}: FAILED to add ${c.name} (${e2.message})`);
          continue;
        }
      }
      report.push(`TABLE ${table}: FAILED to add ${c.name} (${e.message})`);
    }
  }
  try {
    const n = (await dbGet(`SELECT COUNT(*) n FROM \`${table}\``)).n;
    report.push(`TABLE ${table}: ${cols.length} cols, ${n} rows${added.length ? ` — ADDED: ${added.join(', ')}` : ' — ok'}`);
  } catch (e) {
    report.push(`TABLE ${table}: exists but unreadable (${e.message})`);
  }
}

// ---- 2b. backfill anomalies.created_at for pre-column rows ----
try {
  const r = await dbRun("UPDATE anomalies SET created_at=datetime('now') WHERE created_at IS NULL");
  if (r.changes) { report.push(`TABLE anomalies: backfilled created_at on ${r.changes} row(s)`); fixed += r.changes; }
} catch (e) {
  report.push(`TABLE anomalies: backfill skipped (${e.message})`);
}

// ---- 3. rebuild views from the driver's views file ----
try {
  const names = await applyViews();
  for (const n of names) {
    try {
      const rows = (await dbGet(`SELECT COUNT(*) n FROM \`${n}\``)).n;
      report.push(`VIEW ${n}: rebuilt, ${rows} rows`);
    } catch (e) {
      report.push(`VIEW ${n}: BROKEN (${e.message})`);
    }
  }
} catch (e) {
  report.push(`VIEWS FAILED: ${e.message}`);
}

// ---- 4. integrity + invariants ----
if (dbDriver === 'tidb') {
  try {
    const info = await dbInfo();
    report.push(`INTEGRITY: TiDB connected (${info.host}/${info.database})`);
  } catch (e) { report.push(`INTEGRITY: could not check (${e.message})`); }
} else {
  try {
    const ic = await dbGet('PRAGMA integrity_check');
    report.push(`INTEGRITY: ${Object.values(ic)[0]}`);
  } catch (e) { report.push(`INTEGRITY: could not check (${e.message})`); }
}
try {
  const admins = (await dbGet('SELECT COUNT(*) n FROM users WHERE is_admin=1')).n;
  report.push(`INVARIANT single-admin: ${admins <= 1 ? `ok (${admins} admin)` : `VIOLATED (${admins} admins!)`}`);
} catch { /* fresh DB, no users yet */ }

console.log('\n===== DB FIX REPORT =====');
for (const line of report) console.log((/FAILED|BROKEN|VIOLATED/.test(line) ? '✗ ' : '✓ ') + line);
console.log(`\nDone. ${fixed} fix(es) applied. No data was deleted.`);
console.log('Edit db/schema.sql / db/schema.tidb.sql or the views files, then re-run: npm run db:fix\n');
process.exit(0);
