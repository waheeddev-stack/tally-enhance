// Fix + verify SQL tables and columns:  npm run db:fix
// - Creates any tables missing from db/schema.sql (IF NOT EXISTS)
// - Adds any columns missing from db/schema.sql to old tables (ALTER TABLE)
// - Drops + recreates every view from db/views.sql (latest definitions win)
// - Prints a full health report (tables, columns, views, integrity)
// Safe to run any time: never deletes data, only adds what is missing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../src/db.js'; // applies schema.sql (tables) on import

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const report = [];
let fixed = 0;

// ---- 1. parse expected columns out of schema.sql ----
function splitTop(body) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of body) {
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
      if (/^(primary|unique|foreign|check|constraint)$/i.test(first)) continue;
      defs.push({ name: first, def: part });
    }
    tables[m[1]] = defs;
  }
  return tables;
}
const expected = parseSchema(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// ---- 2. add missing columns ----
for (const [table, cols] of Object.entries(expected)) {
  let existing;
  try {
    existing = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(r => r.name));
  } catch {
    report.push(`TABLE ${table}: missing entirely (will be created by schema)`);
    continue;
  }
  const added = [];
  for (const c of cols) {
    if (existing.has(c.name)) continue;
    // SQLite forbids ADD COLUMN ... NOT NULL without default on filled tables:
    // relax to nullable (fresh tables still get the strict def from CREATE TABLE).
    const safe = /\bNOT\s+NULL\b/i.test(c.def) && !/\bDEFAULT\b/i.test(c.def)
      ? c.def.replace(/\bNOT\s+NULL\b/i, '') + ' /* relaxed from NOT NULL by db:fix */'
      : c.def;
    try {
      db.prepare(`ALTER TABLE "${table}" ADD COLUMN ${safe}`).run();
      added.push(c.name); fixed++;
    } catch (e) {
      report.push(`TABLE ${table}: FAILED to add ${c.name} (${e.message})`);
    }
  }
  try {
    const n = db.prepare(`SELECT COUNT(*) n FROM "${table}"`).get().n;
    report.push(`TABLE ${table}: ${cols.length} cols, ${n} rows${added.length ? ` — ADDED: ${added.join(', ')}` : ' — ok'}`);
  } catch (e) {
    report.push(`TABLE ${table}: exists but unreadable (${e.message})`);
  }
}

// ---- 3. rebuild views from db/views.sql ----
try {
  const vsql = fs.readFileSync(path.join(__dirname, 'views.sql'), 'utf8');
  const names = [...vsql.matchAll(/CREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)].map(m => m[1]);
  for (const n of names) { try { db.exec(`DROP VIEW IF EXISTS ${n}`); } catch {} }
  db.exec(vsql);
  for (const n of names) {
    try {
      const rows = db.prepare(`SELECT COUNT(*) n FROM "${n}"`).get().n;
      report.push(`VIEW ${n}: rebuilt, ${rows} rows`);
    } catch (e) {
      report.push(`VIEW ${n}: BROKEN (${e.message})`);
    }
  }
} catch (e) {
  report.push(`VIEWS FAILED: ${e.message}`);
}

// ---- 4. integrity + invariants ----
try {
  const ic = db.prepare('PRAGMA integrity_check').get();
  report.push(`INTEGRITY: ${Object.values(ic)[0]}`);
} catch (e) { report.push(`INTEGRITY: could not check (${e.message})`); }
try {
  const admins = db.prepare('SELECT COUNT(*) n FROM users WHERE is_admin=1').get().n;
  report.push(`INVARIANT single-admin: ${admins <= 1 ? `ok (${admins} admin)` : `VIOLATED (${admins} admins!)`}`);
} catch { /* fresh DB, no users yet */ }

console.log('\n===== DB FIX REPORT =====');
for (const line of report) console.log((/FAILED|BROKEN|VIOLATED/.test(line) ? '✗ ' : '✓ ') + line);
console.log(`\nDone. ${fixed} column(s) added. No data was deleted.`);
console.log('Edit db/schema.sql or db/views.sql, then re-run: npm run db:fix\n');
