import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { z } from 'zod';
import pkg from 'node-sql-parser';
const { Parser } = pkg;
import { randomUUID } from 'node:crypto';
import { db, getSetting, setSetting } from './db.js';
import { authRequired, requireAdmin, requirePermission, signToken, audit } from './middleware/auth.js';
import { runAnomalies } from './lib_anomalies.js';
import { validRatesForHSN } from './lib_gstin.js';
import { llmStatus, mockExtract, mockTextToSQL, mockSummary, aiExtract, aiExtractText, aiChat, aiSummary, aiExplain, aiNarration, aiSuggestHSN, aiRewriteReminder, aiDigestLine, pingLlm, validateColumns } from './lib_llm.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 4000;
app.use(cors({ origin: (process.env.CORS_ORIGIN || '*').split(','), credentials: true }));
app.use(express.json({ limit: '5mb' }));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50 });

// ---------- helpers ----------
const uid = () => randomUUID();
function today() { return new Date().toISOString().slice(0, 10); }
function company() { return db.prepare('SELECT * FROM companies LIMIT 1').get(); }
function hiddenGroups(user) {
  try { return JSON.parse(user.permissions_json || '{}').hidden_groups || []; } catch { return []; }
}
function allowedTypes(user) {
  try {
    const p = JSON.parse(user.permissions_json || '{}');
    if (Array.isArray(p.voucher_types) && p.voucher_types.length) return p.voucher_types;
  } catch {}
  if (user.is_admin === 1) return ['sales', 'purchase', 'receipt', 'payment', 'journal', 'contra'];
  if (user.role_preset === 'viewer') return [];
  if (user.role_preset === 'data_entry') return ['purchase', 'sales'];
  return ['sales', 'purchase', 'receipt', 'payment', 'journal', 'contra'];
}
function canSeeLedger(user, ledger) {
  if (!ledger) return true;
  if (user.is_admin === 1) return true;
  const hg = hiddenGroups(user);
  if (!hg.length) return true;
  const g = db.prepare('SELECT name FROM ledger_groups WHERE id=?').get(ledger.group_id);
  return !hg.includes(g?.name);
}
function checkCounter(userId, kind, cap) {
  const day = today();
  let row = db.prepare('SELECT * FROM usage_counters WHERE user_id=? AND day=?').get(userId, day);
  if (!row) { db.prepare('INSERT INTO usage_counters(user_id,day,chat_count,bill_count) VALUES(?,?,0,0)').run(userId, day); row = { chat_count: 0, bill_count: 0 }; }
  return (row[kind] || 0) < cap;
}
function bumpCounter(userId, kind) {
  const day = today();
  db.prepare('INSERT INTO usage_counters(user_id,day,chat_count,bill_count) VALUES(?,?,0,0) ON CONFLICT(user_id,day) DO NOTHING').run(userId, day);
  db.prepare(`UPDATE usage_counters SET ${kind}=${kind}+1 WHERE user_id=? AND day=?`).run(userId, day);
}
function permsOf(user) { try { return JSON.parse(user.permissions_json || '{}'); } catch { return {}; } }

// ---------- views (reporting layer — single source: db/views.sql) ----------
// Drop + recreate every boot so view definition edits always take effect
// (CREATE IF NOT EXISTS would leave stale definitions behind).
(function applyViews() {
  try {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'views.sql'), 'utf8');
    const names = [...sql.matchAll(/CREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)].map(m => m[1]);
    for (const n of names) { try { db.exec(`DROP VIEW IF EXISTS ${n}`); } catch {} }
    db.exec(sql);
  } catch (e) {
    console.log('views failed to apply:', e.message);
  }
})();

// ---------- health ----------
app.get('/api/health', (req, res) => {
  let dbOk = true;
  try { db.prepare('SELECT 1').get(); } catch { dbOk = false; }
  res.json({ server: 'ok', db: dbOk ? 'ok' : 'down', llm: llmStatus(), tally_mode: process.env.TALLY_MODE || 'mock', time: new Date().toISOString() });
});

// ---------- setup (first admin only) ----------
// Shared provisioner: used by POST /setup AND by boot-from-env below.
const setupSchema = z.object({ company_name: z.string().min(2), gstin: z.string().optional().default(''), state_code: z.string().optional().default('27'), fy_start: z.string().optional().default('2025-04-01'), fy_end: z.string().optional().default('2026-03-31'), admin_name: z.string().min(2), admin_email: z.string().email(), admin_password: z.string().min(6) });
function provisionCompany(input) {
  const s = setupSchema.safeParse(input);
  if (!s.success) throw new Error(s.error.issues[0]?.message);
  const d = s.data;
  if (db.prepare('SELECT id FROM users WHERE is_admin=1 LIMIT 1').get()) throw new Error('Setup locked: admin already exists');
  const cid = uid();
  db.prepare('INSERT INTO companies(id,name,gstin,state_code,fy_start,fy_end) VALUES(?,?,?,?,?,?)').run(cid, d.company_name, d.gstin, d.state_code, d.fy_start, d.fy_end);
  // standard chart of accounts (groups only — ledgers are created by the user)
  const GROUPS = ['Sundry Debtors', 'Sundry Creditors', 'Bank Accounts', 'Cash-in-hand', 'Sales Accounts', 'Purchase Accounts', 'Duties and Taxes', 'Direct Expenses', 'Indirect Expenses', 'Direct Income', 'Indirect Income', 'Capital Account'];
  const gins = db.prepare('INSERT INTO ledger_groups(id,company_id,name) VALUES(?,?,?)');
  for (const g of GROUPS) gins.run(uid(), cid, g);
  const adminId = uid();
  db.prepare("INSERT INTO users(id,company_id,name,email,password_hash,role_preset,is_admin,permissions_json,active) VALUES(?,?,?,?,?,'admin',1,?,1)").run(adminId, cid, d.admin_name, d.admin_email.toLowerCase(), bcrypt.hashSync(d.admin_password, 10), JSON.stringify({ all: true }));
  audit('company', cid, 'setup', d.admin_email, { company: d.company_name });
  return db.prepare('SELECT * FROM users WHERE id=?').get(adminId);
}
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role_preset: u.role_preset, is_admin: u.is_admin === 1, permissions: permsOf(u), must_change_password: !!u.must_change_password, needs_approval: !!u.needs_approval, amount_limit: u.amount_limit || 0, approval_limit: u.approval_limit || 0, active: !!u.active };
}

// ---------- auth ----------
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').toLowerCase());
  if (!u) return res.status(401).json({ error: 'Invalid email or password' });
  if (u.locked_until && u.locked_until > new Date().toISOString()) return res.status(403).json({ error: `Locked after 5 failed attempts. It auto-unlocks at ${u.locked_until.replace('T', ' ').slice(0, 16)} — or the server owner can unlock instantly with: npm run unlock -- ${u.email}` });
  if (!u.active) return res.status(403).json({ error: 'Account inactive' });
  if (!bcrypt.compareSync(String(password || ''), u.password_hash)) {
    const fails = (u.failed_logins || 0) + 1;
    const lock = fails >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : u.locked_until;
    db.prepare('UPDATE users SET failed_logins=?, locked_until=? WHERE id=?').run(fails, lock, u.id);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  db.prepare("UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=datetime('now') WHERE id=?").run(u.id);
  audit('user', u.id, 'login', u.email, {});
  res.json({ token: signToken(u), user: publicUser(u) });
});
app.post('/api/auth/change-password', authRequired, (req, res) => {
  const { new_password } = req.body || {};
  if (!new_password || String(new_password).length < 6) return res.status(400).json({ error: 'Min 6 characters' });
  db.prepare('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?').run(bcrypt.hashSync(String(new_password), 10), req.user.id);
  res.json({ ok: true });
});
app.get('/api/me', authRequired, (req, res) => res.json({ user: publicUser(req.user) }));

// ---------- admin users ----------
app.get('/api/admin/users', authRequired, requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY is_admin DESC, name').all();
  res.json({ users: rows.map(u => ({ ...publicUser(u), active: !!u.active, amount_limit: u.amount_limit, approval_limit: u.approval_limit, expires_on: u.expires_on })) });
});
app.post('/api/admin/users', authRequired, requireAdmin, (req, res) => {
  const s = z.object({ name: z.string().min(2), email: z.string().email(), role_preset: z.string().default('data_entry'), temp_password: z.string().min(6), permissions: z.any().optional(), amount_limit: z.number().optional(), approval_limit: z.number().optional(), needs_approval: z.boolean().optional() }).safeParse(req.body);
  if (!s.success) return res.status(400).json({ error: s.error.issues[0]?.message });
  const d = s.data;
  const c = company();
  try {
    const id = uid();
    db.prepare('INSERT INTO users(id,company_id,name,email,password_hash,role_preset,is_admin,permissions_json,needs_approval,approval_limit,amount_limit,must_change_password,created_by) VALUES(?,?,?,?,?,?,NULL,?,?,?,?,1,?)')
      .run(id, c?.id, d.name, d.email.toLowerCase(), bcrypt.hashSync(d.temp_password, 10), d.role_preset, JSON.stringify(d.permissions || {}), d.needs_approval ? 1 : 0, d.approval_limit || 0, d.amount_limit || 0, req.user.email);
    audit('user', id, 'create', req.user.email, { email: d.email, role: d.role_preset });
    res.json({ id });
  } catch (e) { res.status(400).json({ error: 'Email already exists' }); }
});
app.patch('/api/admin/users/:id', authRequired, requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (u.is_admin === 1) return res.status(400).json({ error: 'Admin cannot be edited this way' });
  const b = req.body || {};
  const patch = {};
  if (b.name) patch.name = b.name;
  if (b.role_preset) patch.role_preset = b.role_preset;
  if (b.permissions) patch.permissions_json = JSON.stringify(b.permissions);
  if (b.amount_limit != null) patch.amount_limit = b.amount_limit;
  if (b.approval_limit != null) patch.approval_limit = b.approval_limit;
  if (b.needs_approval != null) patch.needs_approval = b.needs_approval ? 1 : 0;
  if (b.active != null) patch.active = b.active ? 1 : 0;
  if (b.expires_on !== undefined) patch.expires_on = b.expires_on;
  if (b.locked_until !== undefined) { patch.locked_until = null; patch.failed_logins = 0; }
  const keys = Object.keys(patch);
  if (keys.length) db.prepare(`UPDATE users SET ${keys.map(k => `${k}=?`).join(',')}, token_version=token_version+0 WHERE id=?`).run(...keys.map(k => patch[k]), u.id);
  // permission-affecting change bumps token_version so it applies on next request? keep session but reload perms per request — no bump needed except force logout
  audit('user', u.id, 'update', req.user.email, patch);
  res.json({ ok: true });
});
app.post('/api/admin/users/:id/reset-password', authRequired, requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u || u.is_admin === 1) return res.status(400).json({ error: 'Cannot reset admin here' });
  const tmp = req.body?.temp_password || ('Temp' + Math.floor(1000 + Math.random() * 9000));
  db.prepare('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?').run(bcrypt.hashSync(String(tmp), 10), u.id);
  audit('user', u.id, 'reset-password', req.user.email, {});
  res.json({ temp_password: String(tmp) });
});
app.post('/api/admin/users/:id/force-logout', authRequired, requireAdmin, (req, res) => {
  db.prepare('UPDATE users SET token_version=token_version+1 WHERE id=?').run(req.params.id);
  audit('user', req.params.id, 'force-logout', req.user.email, {});
  res.json({ ok: true });
});
app.post('/api/admin/users/:id/view-as', authRequired, requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const tok = jwt.sign({ uid: u.id, tv: u.token_version || 1, viewAs: true }, process.env.JWT_SECRET || 'dev-only-change-me-long-random-string', { expiresIn: `${process.env.VIEW_AS_TOKEN_MINUTES || 15}m` });
  audit('user', u.id, 'view-as', req.user.email, {});
  res.json({ token: tok, user: publicUser(u) });
});
app.get('/api/admin/audit', authRequired, requireAdmin, (req, res) => {
  const { user: fUser, action, from, to } = req.query;
  let sql = 'SELECT * FROM audit_log WHERE 1=1';
  const args = [];
  if (fUser) { sql += ' AND actor=?'; args.push(fUser); }
  if (action) { sql += ' AND action=?'; args.push(action); }
  if (from) { sql += ' AND created_at>=?'; args.push(from); }
  if (to) { sql += ' AND created_at<=?'; args.push(to); }
  sql += ' ORDER BY created_at DESC LIMIT 500';
  res.json({ rows: db.prepare(sql).all(...args) });
});

// ---------- bills ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB) || 10) * 1024 * 1024 } });
app.post('/api/bills', authRequired, requirePermission('bill.upload'), (req, res) => {
  upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: 'File too large (max 10 MB)' });
    const c = company();
    const p = permsOf(req.user);
    const cap = p.daily_bill_cap || Number(process.env.DEFAULT_DAILY_BILL_CAP) || 20;
    if (!checkCounter(req.user.id, 'bill_count', cap)) return res.status(429).json({ error: 'Daily bill-upload limit reached' });
    // support JSON demo-bill without file (sample bills)
    const demoName = req.body?.demo || req.query?.demo;
    const file = req.file;
    if (!file && !demoName) return res.status(400).json({ error: 'Attach JPG/PNG/PDF or pass ?demo=sample-1' });
    const id = uid();
    db.prepare('INSERT INTO bills(id,company_id,file_name,mime,file_blob,status,created_by) VALUES(?,?,?,?,?,?,?)')
      .run(id, c.id, file?.originalname || `${demoName}.jpg`, file?.mimetype || 'image/jpeg', file?.buffer || Buffer.from('demo'), 'uploaded', req.user.email);
    bumpCounter(req.user.id, 'bill_count');
    audit('bill', id, 'upload', req.user.email, { file: file?.originalname || demoName });
    res.json({ billId: id });
  });
});

app.post('/api/bills/:id/extract', authRequired, requirePermission('bill.upload'), async (req, res) => {
  const bill = db.prepare('SELECT * FROM bills WHERE id=?').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  const c = company();
  const demo = req.body?.demo || (bill.file_name || '');
  // OCR + AI combined: browser OCR text grounds the vision model (exact numbers),
  // digital PDFs go through pdf-parse text extraction. Both beat pixels-alone.
  const ocrText = String(req.body?.ocr_text || '').slice(0, 6000);
  let ext, ai_source = 'local', ai_note = null;
  const isImage = String(bill.mime || '').startsWith('image/') && bill.file_blob;
  const isPdf = String(bill.mime || '') === 'application/pdf' && bill.file_blob;
  if (isImage) {
    try {
      const b64 = Buffer.from(bill.file_blob).toString('base64');
      const r = await aiExtract({ imageBase64: b64, mime: bill.mime, ocrText });
      ext = r.out; ai_source = r.source;
    } catch (e) {
      ai_note = `AI providers failed (${e.message}) — local demo model used. Non-AI features unaffected.`;
    }
  } else if (isPdf) {
    try {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: Buffer.from(bill.file_blob) });
      let pdfText = '';
      try { pdfText = (await parser.getText())?.text || ''; }
      finally { try { await parser.destroy(); } catch {} }
      if (pdfText.trim().length < 20) throw new Error('no readable text — scanned PDF, photo pages not supported yet');
      const r = await aiExtractText(pdfText);
      ext = r.out; ai_source = r.source;
      ai_note = 'Digital PDF text extracted and read by AI.';
    } catch (e) {
      ai_note = `PDF read failed (${e.message}) — local demo model used.`;
    }
  }
  if (!ext) {
    if (!ai_note) ai_note = 'No AI provider configured — add a free key (GEMINI_API_KEY) in .env. Local demo model used.';
    ext = mockExtract({ fileName: demo + ' ' + (bill.file_name || '') });
  }
  db.prepare('UPDATE bills SET raw_extraction_json=?, confidence_json=?, status=? WHERE id=?')
    .run(JSON.stringify(ext), JSON.stringify(ext.confidence || {}), 'extracted', bill.id);
  // ledger mapping (fuzzy on normalized name, scoped to visible ledgers)
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const ledgers = db.prepare('SELECT * FROM ledgers WHERE company_id=?').all(c.id).filter(l => canSeeLedger(req.user, l));
  const target = norm(ext.vendor.name);
  let best = null, bestScore = 0;
  for (const l of ledgers) {
    const n = norm(l.name);
    const score = (n.includes(target.slice(0, 5)) || target.includes(n.slice(0, 5))) ? 0.9 : (n[0] === target[0] ? 0.65 : 0.2);
    if (score > bestScore) { bestScore = score; best = l; }
  }
  const inState = true; // demo company + vendors all Maharashtra
  const draftLines = ext.items.map(it => ({
    id: uid(), ledger_name: inState ? 'Purchase @18%' : 'Purchase (Interstate)', hsn: it.hsn, description: it.description,
    qty: it.qty, rate: it.rate, amount: it.amount, tax_rate: it.tax_rate,
    cgst: +(it.amount * it.tax_rate / 200).toFixed(2), sgst: +(it.amount * it.tax_rate / 200).toFixed(2), igst: 0, dc: 'Dr',
  }));
  const draft = {
    bill_id: bill.id, vendor: ext.vendor, invoice: ext.invoice, totals: ext.totals, confidence: ext.confidence,
    document_kind: ext.document_kind || 'invoice',
    suggested_ledger: bestScore > 0.6 ? { id: best.id, name: best.name, score: bestScore } : { id: null, name: ext.vendor.name, score: bestScore, new_ledger: true },
    lines: draftLines, note: ext.note,
  };
  // run anomaly preview (unsaved voucher)
  const previewVoucher = { id: 'preview', company_id: c.id, party_ledger_id: draft.suggested_ledger.id, number: ext.invoice.number, date: ext.invoice.date, total: ext.totals.grand_total, bill_id: bill.id };
  const flags = runAnomalies(previewVoucher, draftLines.map(l => ({ ...l })), { fy_start: c.fy_start, fy_end: c.fy_end, vendor_gstin: ext.vendor.gstin, ledger_gstin: best?.gstin });
  res.json({ extraction: ext, draft, anomalies: flags, ai_source, ai_note, document_kind: ext.document_kind || 'invoice' });
});

// ---------- vouchers ----------
function validateDoubleEntry(lines) {
  // For purchase/sales demo: sum(amount+tax) must equal voucher total; Dr/Cr balance trivially holds via single party credit line
  return true;
}
app.get('/api/vouchers', authRequired, (req, res) => {
  if (req.user.is_admin !== 1 && req.user.role_preset === 'viewer') return res.status(403).json({ error: 'Reports-only role: use Reports' });
  const c = company();
  const types = allowedTypes(req.user);
  let sql = `SELECT v.*, l.name AS party_name FROM vouchers v LEFT JOIN ledgers l ON l.id=v.party_ledger_id WHERE v.company_id=?`;
  const args = [c.id];
  if (req.user.is_admin !== 1 && types.length) { sql += ` AND v.type IN (${types.map(() => '?').join(',')})`; args.push(...types); }
  if (req.query.status) { sql += ' AND v.status=?'; args.push(req.query.status); }
  if (req.query.mine === '1') { sql += ' AND v.created_by=?'; args.push(req.user.email); }
  if (req.query.q) { sql += ' AND (v.number LIKE ? OR l.name LIKE ?)'; args.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  sql += ' ORDER BY v.date DESC, v.created_at DESC LIMIT 200';
  let rows = db.prepare(sql).all(...args);
  // hide ledgers
  rows = rows.map(r => {
    const led = r.party_ledger_id ? db.prepare('SELECT * FROM ledgers WHERE id=?').get(r.party_ledger_id) : null;
    if (led && !canSeeLedger(req.user, led)) return { ...r, party_name: '•••', total: r.total };
    return r;
  });
  res.json({ vouchers: rows });
});
app.post('/api/vouchers', authRequired, requirePermission('voucher.create'), (req, res) => {
  const c = company();
  const s = z.object({ type: z.string(), date: z.string(), party_ledger_id: z.string().nullable().optional(), number: z.string().optional(), narration: z.string().optional().default(''), lines: z.array(z.any()).min(1), bill_id: z.string().optional(), vendor_gstin: z.string().optional(), force_draft: z.boolean().optional() }).safeParse(req.body);
  if (!s.success) return res.status(400).json({ error: s.error.issues[0]?.message });
  const d = s.data;
  if (!allowedTypes(req.user).includes(d.type) && req.user.is_admin !== 1) return res.status(403).json({ error: `No access to ${d.type} vouchers` });
  // date lock
  const p = permsOf(req.user);
  if (p.date_lock && d.date < p.date_lock) return res.status(403).json({ error: `Date locked before ${p.date_lock}` });
  if (d.date < c.fy_start || d.date > c.fy_end) { /* flag only, still allowed */ }
  const total = d.lines.reduce((a, l) => a + Number(l.amount || 0) + Number(l.cgst || 0) + Number(l.sgst || 0) + Number(l.igst || 0), 0);
  // amount limit
  const limit = req.user.amount_limit || p.amount_limit || 0;
  const needsApproval = req.user.needs_approval || (limit && total > limit);
  // auto-number per type+FY
  const count = db.prepare('SELECT COUNT(*) n FROM vouchers WHERE company_id=? AND type=?').get(c.id, d.type).n;
  const prefix = { purchase: 'PUR', sales: 'SAL', receipt: 'RCP', payment: 'PAY', journal: 'JRN', contra: 'CTR' }[d.type] || 'V';
  const number = d.number || `${prefix}/25-26/${String(count + 1).padStart(4, '0')}`;
  const id = uid();
  // force_draft (e.g. converting a purchase order) always lands in Draft for later completion
  const status = d.force_draft ? 'draft' : ((needsApproval && req.user.is_admin !== 1) ? 'pending' : 'approved');
  db.prepare('INSERT INTO vouchers(id,company_id,type,number,date,party_ledger_id,total,narration,status,source,bill_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, c.id, d.type, number, d.date, d.party_ledger_id || null, +total.toFixed(2), d.narration, status, d.bill_id ? 'ai' : 'mock', d.bill_id || null, req.user.email);
  const ins = db.prepare('INSERT INTO voucher_lines(id,voucher_id,ledger_id,ledger_name,description,hsn,qty,rate,amount,tax_rate,cgst,sgst,igst,dc) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const l of d.lines) ins.run(uid(), id, l.ledger_id || null, l.ledger_name || '', l.description || '', l.hsn || '', l.qty || 0, l.rate || 0, l.amount || 0, l.tax_rate || 0, l.cgst || 0, l.sgst || 0, l.igst || 0, l.dc || 'Dr');
  // anomalies
  const led = d.party_ledger_id ? db.prepare('SELECT * FROM ledgers WHERE id=?').get(d.party_ledger_id) : null;
  const flags = runAnomalies({ id, company_id: c.id, party_ledger_id: d.party_ledger_id, number, date: d.date, total, bill_id: d.bill_id }, d.lines, { fy_start: c.fy_start, fy_end: c.fy_end, vendor_gstin: d.vendor_gstin, ledger_gstin: led?.gstin });
  const ains = db.prepare('INSERT INTO anomalies(id,voucher_id,bill_id,rule_code,severity,message,field_ref) VALUES(?,?,?,?,?,?,?)');
  db.prepare('DELETE FROM anomalies WHERE voucher_id=?').run(id);
  for (const f of flags) ains.run(f.id, id, d.bill_id || null, f.rule_code, f.severity, f.message, f.field_ref);
  db.prepare('INSERT INTO voucher_approvals(id,voucher_id,action,actor_id,reason) VALUES(?,?,?,?,?)').run(uid(), id, status === 'pending' ? 'submit' : status === 'draft' ? 'draft' : 'approve', req.user.id, status === 'pending' ? 'auto-submitted (needs approval)' : status === 'draft' ? 'saved as draft (e.g. from purchase order)' : 'auto-approved');
  audit('voucher', id, 'create', req.user.email, { number, total, status });
  res.json({ id, number, status, total: +total.toFixed(2), anomalies: flags });
});
app.get('/api/vouchers/:id', authRequired, (req, res) => {
  const v = db.prepare('SELECT * FROM vouchers WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  const lines = db.prepare('SELECT * FROM voucher_lines WHERE voucher_id=?').all(v.id);
  const flags = db.prepare('SELECT * FROM anomalies WHERE voucher_id=?').all(v.id);
  const bill = v.bill_id ? db.prepare('SELECT id,file_name,mime,created_at FROM bills WHERE id=?').get(v.bill_id) : null;
  res.json({ voucher: v, lines, anomalies: flags, bill });
});
app.patch('/api/vouchers/:id', authRequired, requirePermission('voucher.edit'), (req, res) => {
  const v = db.prepare('SELECT * FROM vouchers WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  if (v.status === 'approved' && req.user.is_admin !== 1 && req.user.role_preset !== 'accountant') return res.status(403).json({ error: 'Only approver/admin can alter approved vouchers' });
  const before = { ...v };
  const b = req.body || {};
  if (b.narration != null) db.prepare('UPDATE vouchers SET narration=? WHERE id=?').run(b.narration, v.id);
  if (b.date) db.prepare('UPDATE vouchers SET date=? WHERE id=?').run(b.date, v.id);
  if (Array.isArray(b.lines) && b.lines.length) {
    if (v.status === 'cancelled') return res.status(400).json({ error: 'Cancelled vouchers cannot be edited' });
    const total = b.lines.reduce((a, l) => a + Number(l.amount || 0) + Number(l.cgst || 0) + Number(l.sgst || 0) + Number(l.igst || 0), 0);
    db.prepare('DELETE FROM voucher_lines WHERE voucher_id=?').run(v.id);
    const ins = db.prepare('INSERT INTO voucher_lines(id,voucher_id,ledger_id,ledger_name,description,hsn,qty,rate,amount,tax_rate,cgst,sgst,igst,dc) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const l of b.lines) ins.run(uid(), v.id, l.ledger_id || null, l.ledger_name || '', l.description || '', l.hsn || '', l.qty || 0, l.rate || 0, l.amount || 0, l.tax_rate || 0, l.cgst || 0, l.sgst || 0, l.igst || 0, l.dc || 'Dr');
    db.prepare('UPDATE vouchers SET total=? WHERE id=?').run(+total.toFixed(2), v.id);
    // re-run anomaly rules on the edited voucher
    const led = v.party_ledger_id ? db.prepare('SELECT * FROM ledgers WHERE id=?').get(v.party_ledger_id) : null;
    const c2 = company();
    const flags = runAnomalies({ id: v.id, company_id: v.company_id, party_ledger_id: v.party_ledger_id, number: v.number, date: b.date || v.date, total, bill_id: v.bill_id }, b.lines, { fy_start: c2.fy_start, fy_end: c2.fy_end, vendor_gstin: b.vendor_gstin, ledger_gstin: led?.gstin });
    db.prepare('DELETE FROM anomalies WHERE voucher_id=?').run(v.id);
    const ains = db.prepare('INSERT INTO anomalies(id,voucher_id,bill_id,rule_code,severity,message,field_ref) VALUES(?,?,?,?,?,?,?)');
    for (const f of flags) ains.run(f.id, v.id, v.bill_id || null, f.rule_code, f.severity, f.message, f.field_ref);
  }
  audit('voucher', v.id, 'alter', req.user.email, { before: { narration: before.narration, date: before.date, total: before.total }, after: { narration: b.narration, date: b.date, lines: b.lines ? b.lines.length : undefined } });
  res.json({ ok: true });
});
// One-click deterministic fixes: correct GST rate per HSN + recompute tax math.
// Never invents data — HSN-missing and GSTIN issues still need a human.
app.post('/api/vouchers/:id/autofix', authRequired, requirePermission('voucher.edit'), (req, res) => {
  const v = db.prepare('SELECT * FROM vouchers WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  if (req.viewAs) return res.status(403).json({ error: 'View-as mode is read-only' });
  if (v.status === 'cancelled') return res.status(400).json({ error: 'Cancelled vouchers cannot be fixed' });
  if (v.status === 'approved' && req.user.is_admin !== 1 && req.user.role_preset !== 'accountant') return res.status(403).json({ error: 'Only approver/admin can fix approved vouchers' });
  const lines = db.prepare('SELECT * FROM voucher_lines WHERE voucher_id=?').all(v.id);
  let fixed = 0;
  for (const l of lines) {
    const allowed = validRatesForHSN(l.hsn);
    if (allowed && !allowed.includes(Number(l.tax_rate))) { l.tax_rate = allowed[0]; fixed++; }
    const taxable = Number(l.qty || 0) * Number(l.rate || 0) || Number(l.amount || 0);
    const t = taxable * Number(l.tax_rate || 0) / 100;
    const stated = Number(l.cgst || 0) + Number(l.sgst || 0) + Number(l.igst || 0);
    if (Math.abs(t - stated) > 1) {
      if (Number(l.igst || 0) > 0) { l.igst = +t.toFixed(2); l.cgst = 0; l.sgst = 0; }
      else { l.cgst = +(t / 2).toFixed(2); l.sgst = +(t / 2).toFixed(2); l.igst = 0; }
      fixed++;
    }
  }
  if (!fixed) return res.json({ fixed: 0, message: 'Nothing auto-fixable — remaining flags need human review.' });
  const total = lines.reduce((a, l) => a + Number(l.amount || 0) + Number(l.cgst || 0) + Number(l.sgst || 0) + Number(l.igst || 0), 0);
  const upd = db.prepare('UPDATE voucher_lines SET tax_rate=?, cgst=?, sgst=?, igst=? WHERE id=?');
  for (const l of lines) upd.run(l.tax_rate, l.cgst, l.sgst, l.igst, l.id);
  db.prepare('UPDATE vouchers SET total=? WHERE id=?').run(+total.toFixed(2), v.id);
  const c2 = company();
  const flags = runAnomalies({ id: v.id, company_id: v.company_id, party_ledger_id: v.party_ledger_id, number: v.number, date: v.date, total, bill_id: v.bill_id }, lines, { fy_start: c2.fy_start, fy_end: c2.fy_end });
  db.prepare('DELETE FROM anomalies WHERE voucher_id=?').run(v.id);
  const ains = db.prepare('INSERT INTO anomalies(id,voucher_id,bill_id,rule_code,severity,message,field_ref) VALUES(?,?,?,?,?,?,?)');
  for (const f of flags) ains.run(f.id, v.id, v.bill_id || null, f.rule_code, f.severity, f.message, f.field_ref);
  audit('voucher', v.id, 'autofix', req.user.email, { fixed });
  res.json({ fixed, total: +total.toFixed(2), anomalies: flags });
});
for (const act of ['submit', 'approve', 'reject', 'cancel']) {
  app.post(`/api/vouchers/:id/${act}`, authRequired, (req, res) => {
    const v = db.prepare('SELECT * FROM vouchers WHERE id=?').get(req.params.id);
    if (!v) return res.status(404).json({ error: 'Not found' });
    if (req.viewAs) return res.status(403).json({ error: 'View-as mode is read-only' });
    const p = permsOf(req.user);
    const isAdmin = req.user.is_admin === 1;
    const isMaker = v.created_by === req.user.email;
    const isApprover = isAdmin || req.user.role_preset === 'accountant' || p['voucher.approve'] === true || p.voucher?.approve === true;
    if (act === 'approve') {
      if (!isApprover) return res.status(403).json({ error: 'Your role cannot approve vouchers' });
      const lim = req.user.approval_limit || 0;
      if (!isAdmin && lim && v.total > lim) return res.status(403).json({ error: `Above your approval limit of ₹${Number(lim).toLocaleString('en-IN')}` });
      db.prepare("UPDATE vouchers SET status='approved', approved_by=? WHERE id=?").run(req.user.email, v.id);
    } else if (act === 'reject') {
      // approvers reject; makers recall their own pending back to draft
      if (!isApprover && !(isMaker && v.status === 'pending')) return res.status(403).json({ error: 'Only an approver (or the maker recalling own pending) can do this' });
      if (!req.body?.reason && isApprover && !isMaker) return res.status(400).json({ error: 'Rejection needs a reason' });
      db.prepare("UPDATE vouchers SET status='draft' WHERE id=?").run(v.id);
    } else if (act === 'submit') {
      if (!isMaker && !isAdmin) return res.status(403).json({ error: 'Only the maker can submit this voucher' });
      db.prepare("UPDATE vouchers SET status='pending' WHERE id=?").run(v.id);
    } else if (act === 'cancel') {
      if (req.user.is_admin !== 1 && req.user.role_preset !== 'accountant') {
        if (!p.voucher?.cancel) return res.status(403).json({ error: 'Need cancel permission' });
      }
      db.prepare('UPDATE vouchers SET status=?, cancelled_reason=? WHERE id=?').run('cancelled', req.body?.reason || '', v.id);
    }
    db.prepare('INSERT INTO voucher_approvals(id,voucher_id,action,actor_id,reason) VALUES(?,?,?,?,?)').run(uid(), v.id, act, req.user.id, req.body?.reason || '');
    audit('voucher', v.id, act, req.user.email, { reason: req.body?.reason || '' });
    res.json({ ok: true, status: act === 'approve' ? 'approved' : act === 'reject' ? 'draft' : act === 'cancel' ? 'cancelled' : 'pending' });
  });
}
app.post('/api/vouchers/:id/push-tally', authRequired, (req, res) => res.json({ ok: false, message: 'Stretch: queued for Tally outbox (mock mode).' }));
app.get('/api/approvals', authRequired, (req, res) => {
  const c = company();
  let sql = `SELECT v.*, l.name AS party_name FROM vouchers v LEFT JOIN ledgers l ON l.id=v.party_ledger_id WHERE v.company_id=? AND v.status='pending'`;
  const args = [c.id];
  if (req.query.mine === '1') { sql += ' AND v.created_by=?'; args.push(req.user.email); }
  sql += ' ORDER BY v.created_at DESC';
  const rows = db.prepare(sql).all(...args).map(v => {
    const flags = db.prepare("SELECT rule_code, severity, message FROM anomalies WHERE voucher_id=? AND resolved_at IS NULL").all(v.id);
    const bill = v.bill_id ? db.prepare('SELECT id, file_name, mime FROM bills WHERE id=?').get(v.bill_id) : null;
    const high = flags.filter(f => f.severity === 'high').length;
    return { ...v, flag_count: flags.length, high_flags: high, flags, bill };
  });
  res.json({ queue: rows });
});
app.get('/api/anomalies', authRequired, (req, res) => {
  const c = company();
  const rows = db.prepare(`SELECT a.*, v.number AS voucher_number, v.type FROM anomalies a JOIN vouchers v ON v.id=a.voucher_id WHERE v.company_id=? AND a.resolved_at IS NULL ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, a.rowid DESC LIMIT 200`).all(c.id);
  res.json({ anomalies: rows });
});
app.post('/api/anomalies/:id/resolve', authRequired, (req, res) => {
  db.prepare("UPDATE anomalies SET resolved_at=datetime('now') WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- reports ----------
function scopeTypes(user) { return allowedTypes(user); }
app.get('/api/reports/day-book', authRequired, requirePermission('report.view'), (req, res) => {
  const c = company();
  const rows = db.prepare(`SELECT v.*, l.name AS party_name FROM vouchers v LEFT JOIN ledgers l ON l.id=v.party_ledger_id WHERE v.company_id=? AND v.status<>'cancelled' ORDER BY v.date DESC LIMIT 200`).all(c.id);
  res.json({ rows });
});
app.get('/api/reports/ledger', authRequired, requirePermission('report.view'), (req, res) => {
  const { ledger_id, ledger } = req.query;
  let led = ledger_id ? db.prepare('SELECT * FROM ledgers WHERE id=?').get(ledger_id) : db.prepare('SELECT * FROM ledgers WHERE name LIKE ? LIMIT 1').get(`%${ledger || ''}%`);
  if (!led) return res.status(404).json({ error: 'Ledger not found' });
  if (!canSeeLedger(req.user, led)) return res.json({ ledger: { name: '•••' }, entries: [], hidden: true });
  const entries = db.prepare(`SELECT * FROM vouchers WHERE party_ledger_id=? AND status<>'cancelled' ORDER BY date`).all(led.id);
  res.json({ ledger: led, entries });
});
app.get('/api/reports/trial-balance', authRequired, requirePermission('report.view'), (req, res) => {
  const c = company();
  const hg = hiddenGroups(req.user);
  const groups = db.prepare('SELECT * FROM ledger_groups WHERE company_id=?').all(c.id).filter(g => !hg.includes(g.name));
  const gids = new Set(groups.map(g => g.id));
  const ledgers = db.prepare('SELECT * FROM ledgers WHERE company_id=?').all(c.id).filter(l => gids.has(l.group_id));
  const rows = ledgers.map(l => {
    const t = db.prepare(`SELECT COALESCE(SUM(total),0) s FROM vouchers WHERE party_ledger_id=? AND status='approved'`).get(l.id).s;
    const g = groups.find(g => g.id === l.group_id);
    return { ledger: l.name, group: g?.name, debit: t > 0 ? t : 0, credit: t < 0 ? -t : 0, balance: (l.opening_balance || 0) + t };
  });
  res.json({ rows });
});
app.get('/api/reports/outstandings', authRequired, requirePermission('report.view'), (req, res) => {
  const kind = req.query.kind === 'payables' ? 'v_payables' : 'v_receivables';
  const rows = db.prepare(`SELECT * FROM ${kind} WHERE outstanding>0 ORDER BY outstanding DESC LIMIT 200`).all();
  const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  for (const r of rows) { const d = r.days_overdue || 0; buckets[d <= 30 ? '0-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : '90+'] += r.outstanding || 0; }
  res.json({ rows, ageing: buckets });
});
app.get('/api/dashboard', authRequired, (req, res) => {
  const c = company();
  const recv = db.prepare('SELECT COALESCE(SUM(outstanding),0) s FROM v_receivables').get().s;
  const pay = db.prepare('SELECT COALESCE(SUM(outstanding),0) s FROM v_payables').get().s;
  const gst = db.prepare('SELECT COALESCE(SUM(total_tax),0) s FROM v_gst_summary').get().s || 0;
  const alerts = db.prepare("SELECT COUNT(*) n FROM anomalies WHERE resolved_at IS NULL").get().n;
  const high = db.prepare("SELECT COUNT(*) n FROM anomalies WHERE resolved_at IS NULL AND severity='high'").get().n;
  const recent = db.prepare(`SELECT v.date, v.number, v.type, v.total, v.status, l.name AS party FROM vouchers v LEFT JOIN ledgers l ON l.id=v.party_ledger_id ORDER BY v.created_at DESC LIMIT 8`).all();
  const ageing = db.prepare('SELECT * FROM v_receivables WHERE outstanding>0').all().reduce((b, r) => { const d = r.days_overdue || 0; b[d <= 30 ? '0-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : '90+'] += r.outstanding; return b; }, { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 });
  res.json({ receivables: recv, payables: pay, gst_payable: gst, open_alerts: alerts, recent, ageing,
    counts: {
      ledgers: db.prepare('SELECT COUNT(*) n FROM ledgers WHERE company_id=?').get(c.id).n,
      vouchers: db.prepare('SELECT COUNT(*) n FROM vouchers WHERE company_id=?').get(c.id).n,
      pending: db.prepare("SELECT COUNT(*) n FROM vouchers WHERE company_id=? AND status='pending'").get(c.id).n,
      drafts: db.prepare("SELECT COUNT(*) n FROM vouchers WHERE company_id=? AND status='draft'").get(c.id).n,
      high_flags: high,
    } });
});
// Plain-language business digest ("explain my books") — computed, no AI needed.
app.get('/api/digest', authRequired, (req, res) => {
  const c = company();
  const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN');
  const sales = db.prepare("SELECT COALESCE(COUNT(*),0) n, COALESCE(SUM(total),0) s FROM vouchers WHERE company_id=? AND type='sales' AND status='approved'").get(c.id);
  const purch = db.prepare("SELECT COALESCE(COUNT(*),0) n, COALESCE(SUM(total),0) s FROM vouchers WHERE company_id=? AND type='purchase' AND status<>'cancelled'").get(c.id);
  const topD = db.prepare('SELECT customer, outstanding, days_overdue FROM v_receivables WHERE outstanding>0 ORDER BY outstanding DESC LIMIT 3').all();
  const topP = db.prepare('SELECT vendor, outstanding, days_overdue FROM v_payables WHERE outstanding>0 ORDER BY outstanding DESC LIMIT 3').all();
  const over60 = db.prepare('SELECT COALESCE(SUM(outstanding),0) s FROM v_receivables WHERE days_overdue>60').get().s;
  const gstMonth = db.prepare('SELECT * FROM v_gst_summary ORDER BY month DESC LIMIT 1').get();
  const high = db.prepare("SELECT COUNT(*) n FROM anomalies WHERE resolved_at IS NULL AND severity='high'").get().n;
  const pending = db.prepare("SELECT COUNT(*) n FROM vouchers WHERE company_id=? AND status='pending'").get(c.id).n;
  const bullets = [
    `Sales: ${sales.n} orders worth ${inr(sales.s)} · Purchases: ${purch.n} orders worth ${inr(purch.s)}.`,
    topD.length ? `Top dues to chase: ${topD.map(r => `${r.customer} (${inr(r.outstanding)}, ${r.days_overdue}d)`).join('; ')}.` : 'Nobody owes you anything — books are clean on receivables.',
    over60 > 0 ? `${inr(over60)} is stuck over 60 days — send reminders before it goes bad.` : 'No dues older than 60 days. Nice.',
    topP.length ? `You owe: ${topP.map(r => `${r.vendor} (${inr(r.outstanding)})`).join('; ')}.` : 'You owe nobody anything.',
    gstMonth ? `Latest GST month ${gstMonth.month}: tax ${inr(gstMonth.total_tax)} (CGST ${inr(gstMonth.cgst)} + SGST ${inr(gstMonth.sgst)} + IGST ${inr(gstMonth.igst)}).` : 'No GST posted yet.',
    high > 0 ? `${high} HIGH-severity flag(s) need eyes before filing.` : 'Zero high-severity flags.',
    pending > 0 ? `${pending} voucher(s) waiting for approval — clear the queue.` : 'Approval queue is empty.',
  ];
  res.json({ company: c.name, generated_at: new Date().toISOString(), bullets });
});
app.get('/api/reports/gst-summary', authRequired, requirePermission('report.view'), (req, res) => {
  res.json({ rows: db.prepare('SELECT * FROM v_gst_summary ORDER BY month').all() });
});

// ---------- chat (NL queries, per-user scoping + SQL validation) ----------
const ALLOW_VIEWS = ['v_receivables', 'v_payables', 'v_gst_summary', 'v_sales', 'v_purchases', 'v_stock', 'v_bank_balances', 'v_order_mix'];
const parser = new Parser();
app.post('/api/chat', authRequired, requirePermission('ai.ask'), async (req, res) => {
  const p = permsOf(req.user);
  if (p.ai_off) return res.status(403).json({ error: 'AI disabled for this user' });
  const cap = p.daily_chat_cap || Number(process.env.DEFAULT_DAILY_CHAT_CAP) || 30;
  if (!checkCounter(req.user.id, 'chat_count', cap)) return res.status(429).json({ error: 'Daily AI question limit reached' });
  const q = String(req.body?.question || '').slice(0, 500);
  if (!q) return res.status(400).json({ error: 'Empty question' });
  const c = company();
  const sessionId = req.body.session_id || 'default';
  // Conversation memory (PRD FR-12): last 6 turns ride along so follow-ups
  // like "now only for Pune" resolve against what was just asked.
  let qFull = q;
  try {
    const hist = db.prepare('SELECT role, content FROM chat_messages WHERE user_id=? AND session_id=? ORDER BY created_at DESC LIMIT 6').all(req.user.id, sessionId).reverse();
    if (hist.length) qFull = `${q}\n\nEarlier in this chat:\n${hist.map(h => `${h.role}: ${String(h.content || '').slice(0, 200)}`).join('\n')}`;
  } catch {}
  // Free-AI chain first; local demo model only when all providers fail.
  let ai_source = 'local', ai_note = null, awaitedGen = null;
  try {
    const r = await aiChat(qFull, { fyStart: c.fy_start, fyEnd: c.fy_end });
    awaitedGen = { gen: r.out, source: r.source };
    ai_source = r.source;
  } catch (e) {
    ai_note = `AI providers failed (${e.message}) — local demo model used.`;
  }
  // validate + run: structural checks, exact-column check, then execute.
  // On failure the model gets ONE self-correction retry with the concrete error;
  // the known-good local query is the last resort. Users never see raw DB errors.
  const checkSql = (gen) => {
    const ast = parser.astify(gen.sql, { database: 'MySQL' });
    const stmts = Array.isArray(ast) ? ast : [ast];
    if (stmts.length !== 1 || stmts[0].type !== 'select') throw new Error('Only single SELECT allowed');
    const sqlLower = gen.sql.toLowerCase();
    if (/base_|insert|update|delete|drop|alter|;.*select|--|#|\/\*/.test(sqlLower)) throw new Error('Blocked pattern');
    const hasAllowed = ALLOW_VIEWS.some(v => sqlLower.includes(v));
    if (!hasAllowed) throw new Error('Query must use an allow-listed view');
    const viewsUsed = (sqlLower.match(/v_[a-z_]+/g) || []).filter((v, i, a) => a.indexOf(v) === i);
    const bad = viewsUsed.filter(v => !ALLOW_VIEWS.includes(v));
    if (bad.length) throw new Error('View not allowed: ' + bad.join(','));
    const col = validateColumns(gen.sql);
    if (!col.ok) throw new Error(col.error);
  };
  const runSql = (gen) => db.prepare(gen.sql.slice(0, 2000)).all().slice(0, 200);
  const hg = hiddenGroups(req.user);
  const isBankQ = g => g.sql.toLowerCase().includes('v_bank_balances');

  let gen = null, rows = null, columns = [], lastErr = '';
  const queue = [];
  if (awaitedGen) queue.push(awaitedGen);
  // self-correction round happens inside the loop via correction flag
  let corrected = false;
  queue.push({ gen: mockTextToSQL(q), source: 'local', fallback: true });
  for (let i = 0; i < queue.length && !rows; i++) {
    const cand = queue[i].gen;
    try {
      checkSql(cand);
      if (hg.includes('Bank Accounts') && isBankQ(cand))
        return res.json({ summary: 'You do not have access to bank balances.', sql: cand.sql, columns: [], rows: [], chart: 'none', title: cand.title, restricted: true, ai_source, ai_note });
      rows = runSql(cand);
      columns = rows.length ? Object.keys(rows[0]) : [];
      gen = cand;
      if (queue[i].source && queue[i].source !== 'local') ai_source = queue[i].source;
    } catch (e) {
      lastErr = e.message;
      console.log(`[chat] attempt ${i} failed: ${e.message} | sql: ${cand.sql?.slice(0, 120)}`);
      if (!corrected && ai_source !== 'local' && !queue[i].fallback) {
        corrected = true;
        try {
          const fix = await aiChat(q, { fyStart: c.fy_start, fyEnd: c.fy_end }, `Your previous SQL failed with this error: ${e.message}. Return fixed JSON.`);
          queue.splice(i + 1, 0, { gen: fix.out, source: fix.source });
        } catch {}
      }
    }
  }
  if (!rows) {
    return res.json({
      summary: `I couldn't turn that into a reliable books query. Try asking about receivables, payables, GST by month, sales, purchases, low stock or bank balances — in English or Hinglish.`,
      sql: gen?.sql || '', columns: [], rows: [], chart: 'none',
      title: 'Could not answer', restricted: false, ai_source, ai_note,
    });
  }
  {
    bumpCounter(req.user.id, 'chat_count');
    const insChat = db.prepare('INSERT INTO chat_messages(id,session_id,user_id,role,content,sql_text,result_meta) VALUES(?,?,?,?,?,?,?)');
    insChat.run(uid(), sessionId, req.user.id, 'user', q, gen.sql, JSON.stringify({ rows: rows.length }));
    let summary;
    if (ai_source !== 'local') {
      try { summary = (await aiSummary(gen.title, rows)).out; }
      catch { summary = mockSummary(rows, gen.title); ai_note = (ai_note ? ai_note + ' ' : '') + 'Summary fell back to local model.'; }
    } else summary = mockSummary(rows, gen.title);
    try { insChat.run(uid(), sessionId, req.user.id, 'assistant', summary, gen.sql, JSON.stringify({ rows: rows.length })); } catch {}
    res.json({ summary, sql: gen.sql, columns, rows, chart: gen.chart, title: gen.title, restricted: false, ai_source, ai_note });
  }
});

// ---------- AI helpers (all free-chain, all gracefully degradable) ----------
function aiGuard(req, res) {
  const p = permsOf(req.user);
  if (p.ai_off) { res.status(403).json({ error: 'AI disabled for this user' }); return null; }
  const cap = p.daily_chat_cap || Number(process.env.DEFAULT_DAILY_CHAT_CAP) || 30;
  if (!checkCounter(req.user.id, 'chat_count', cap)) { res.status(429).json({ error: 'Daily AI limit reached' }); return null; }
  return p;
}
// Plain-words explanation of a voucher's flags (rules decide, AI only explains).
app.post('/api/ai/explain', authRequired, requirePermission('ai.ask'), async (req, res) => {
  if (!aiGuard(req, res)) return;
  const v = db.prepare(`SELECT v.*, l.name AS party_name FROM vouchers v LEFT JOIN ledgers l ON l.id=v.party_ledger_id WHERE v.id=?`).get(req.body?.voucher_id);
  if (!v) return res.status(404).json({ error: 'Voucher not found' });
  const flags = db.prepare("SELECT rule_code, severity, message FROM anomalies WHERE voucher_id=? AND resolved_at IS NULL").all(v.id);
  if (!flags.length) return res.json({ points: ['No open flags on this voucher — nothing to explain.'], source: 'local' });
  try {
    const r = await aiExplain({ voucher: v, flags });
    bumpCounter(req.user.id, 'chat_count');
    res.json({ points: r.points, source: r.source });
  } catch {
    res.json({ points: flags.map(f => f.message), source: 'local', note: 'AI unavailable — showing rule text.' });
  }
});
// Tally-style narration writer.
app.post('/api/ai/narration', authRequired, requirePermission('ai.ask'), async (req, res) => {
  if (!aiGuard(req, res)) return;
  const { type = 'purchase', party = '', lines = [] } = req.body || {};
  try {
    const r = await aiNarration({ type, party, lines });
    bumpCounter(req.user.id, 'chat_count');
    res.json({ narration: r.narration, source: r.source });
  } catch {
    const first = (lines[0]?.description || lines[0]?.ledger_name || 'goods');
    res.json({ narration: `Being ${first} ${type === 'sales' ? 'sold' : 'purchased'}${party ? ' — ' + party : ''}`.slice(0, 140), source: 'local', note: 'AI unavailable — template used.' });
  }
});
// HSN suggester for a line item.
app.post('/api/ai/hsn', authRequired, requirePermission('ai.ask'), async (req, res) => {
  if (!aiGuard(req, res)) return;
  const desc = String(req.body?.description || '').slice(0, 120);
  if (!desc) return res.status(400).json({ error: 'Description required' });
  try {
    const r = await aiSuggestHSN(desc);
    bumpCounter(req.user.id, 'chat_count');
    res.json({ hsn: r.hsn, label: r.label, confidence: r.confidence, source: r.source });
  } catch {
    res.json({ hsn: '', source: 'local', note: 'AI unavailable — enter HSN manually.' });
  }
});
// Reminder tone rewrite (polite / strict / funny).
app.post('/api/ai/reminder', authRequired, requirePermission('ai.ask'), async (req, res) => {
  if (!aiGuard(req, res)) return;
  const { name = '', amount = '', days = 0, tone = 'polite' } = req.body || {};
  try {
    const r = await aiRewriteReminder({ name, amount, days, tone });
    bumpCounter(req.user.id, 'chat_count');
    res.json({ text: r.text, source: r.source });
  } catch {
    res.status(502).json({ error: 'AI unavailable for rewrite — use the built-in templates.' });
  }
});
// Digest headline + next actions.
app.post('/api/ai/digest-line', authRequired, requirePermission('ai.ask'), async (req, res) => {
  if (!aiGuard(req, res)) return;
  const bullets = Array.isArray(req.body?.bullets) ? req.body.bullets.slice(0, 10) : [];
  if (!bullets.length) return res.status(400).json({ error: 'Bullets required' });
  try {
    const r = await aiDigestLine(bullets);
    bumpCounter(req.user.id, 'chat_count');
    res.json({ headline: r.headline, next: r.next, source: r.source });
  } catch {
    res.json({ headline: "Here's your books, decoded.", next: [], source: 'local' });
  }
});

// ---------- connector (mock/live switch) ----------
app.post('/api/connector/sync', (req, res) => {
  if (req.headers['x-api-key'] !== (process.env.CONNECTOR_API_KEY || 'change-me-three')) return res.status(401).json({ error: 'Bad API key' });
  // accept batches, upsert with source='tally' — minimal for demo
  const { ledgers = [], vouchers = [] } = req.body || {};
  let up = 0;
  for (const l of ledgers) { up++; }
  audit('connector', 'sync', 'sync', 'connector', { ledgers: ledgers.length, vouchers: vouchers.length });
  res.json({ ok: true, upserted: up, mode: process.env.TALLY_MODE || 'mock' });
});
app.get('/api/connector/outbox', (req, res) => {
  if (req.headers['x-api-key'] !== (process.env.CONNECTOR_API_KEY || 'change-me-three')) return res.status(401).json({ error: 'Bad API key' });
  res.json({ outbox: [] });
});
app.post('/api/connector/ack', (req, res) => res.json({ ok: true }));
app.post('/internal/llm-endpoint', (req, res) => {
  if (req.body?.secret !== (process.env.INTERNAL_REGISTER_SECRET || 'change-me-too')) return res.status(401).json({ error: 'Bad secret' });
  const url = String(req.body.url || '').replace(/\/$/, '');
  if (!/^https:\/\//.test(url)) return res.status(400).json({ error: 'URL must be the https tunnel link' });
  setSetting('llm_base_url', url);
  setSetting('llm_updated_at', new Date().toISOString());
  refreshLlmStatus(); // immediate re-probe, non-blocking
  res.json({ ok: true });
});

// ---------- ledgers / masters ----------
app.get('/api/groups', authRequired, (req, res) => {
  const c = company();
  res.json({ groups: db.prepare('SELECT id, name FROM ledger_groups WHERE company_id=? ORDER BY name').all(c.id) });
});
app.get('/api/ledgers', authRequired, (req, res) => {
  const c = company();
  const q = req.query.q || '';
  let rows = db.prepare(`SELECT l.*, g.name AS group_name FROM ledgers l LEFT JOIN ledger_groups g ON g.id=l.group_id WHERE l.company_id=? AND l.name LIKE ? LIMIT 50`).all(c.id, `%${q}%`);
  rows = rows.filter(l => canSeeLedger(req.user, l)).map(l => ({ ...l, gstin: canSeeLedger(req.user, l) ? l.gstin : undefined }));
  res.json({ ledgers: rows });
});
app.post('/api/ledgers', authRequired, requirePermission('ledger.create'), (req, res) => {
  const c = company();
  const { name, group_name, gstin } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  let g = db.prepare('SELECT * FROM ledger_groups WHERE company_id=? AND name=?').get(c.id, group_name || 'Sundry Creditors');
  const id = uid();
  db.prepare('INSERT INTO ledgers(id,company_id,name,group_id,gstin,source) VALUES(?,?,?,?,?,?)').run(id, c.id, name, g?.id || null, gstin || null, 'mock');
  audit('ledger', id, 'create', req.user.email, { name });
  res.json({ id });
});

// ---------- Kaggle tunnel watch ----------
// The tunnel URL is random on every notebook restart and self-registers via
// /internal/llm-endpoint. LLM_BASE_URL_BOOTSTRAP only pins a first-boot URL.
// A background probe keeps /api/health honest without slowing requests.
async function refreshLlmStatus() {
  try {
    const r = await pingLlm();
    setSetting('llm_online', r.ok ? '1' : '0');
    setSetting('llm_latency_ms', r.ok ? String(r.latency_ms) : '');
    setSetting('llm_checked_at', new Date().toISOString());
  } catch { /* never crash the server for AI */ }
}
if (process.env.LLM_BASE_URL_BOOTSTRAP && !getSetting('llm_base_url')) {
  setSetting('llm_base_url', process.env.LLM_BASE_URL_BOOTSTRAP.replace(/\/$/, ''));
}
setInterval(refreshLlmStatus, 60000);
refreshLlmStatus();

// Boot-from-env: hardcoded admin credentials for self-hosted convenience.
// If no admin exists and ADMIN_EMAIL/ADMIN_PASSWORD are set (and not the
// documented placeholder), provision company + admin so login works immediately.
if (!db.prepare('SELECT id FROM users WHERE is_admin=1 LIMIT 1').get()) {
  const pw = process.env.ADMIN_PASSWORD || '';
  if (process.env.ADMIN_EMAIL && pw && !/^change-me/.test(pw)) {
    try {
      const admin = provisionCompany({
        company_name: process.env.COMPANY_NAME || 'My Company',
        gstin: process.env.COMPANY_GSTIN || '',
        state_code: process.env.COMPANY_STATE || '27',
        admin_name: process.env.ADMIN_NAME || 'Owner',
        admin_email: process.env.ADMIN_EMAIL,
        admin_password: pw,
      });
      console.log(`admin auto-created from .env: ${admin.email} (${process.env.COMPANY_NAME || 'My Company'})`);
    } catch (e) {
      console.log('env admin provisioning skipped:', e.message);
    }
  } else {
    console.log('WARNING: no admin exists and ADMIN_EMAIL/ADMIN_PASSWORD are not set — set them in .env and restart (there is no signup page).');
  }
}

app.listen(PORT, () => console.log(`tally-copilot-server on :${PORT} (Kaggle LLM via tunnel, SQLite demo)`));
