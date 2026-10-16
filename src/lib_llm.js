// llmClient — ordered provider chain for FREE demo AI. First working answer wins.
//   gemini     Google AI Studio, free/no-card: vision + SQL + summaries (primary)
//   groq       console.groq.com, free/no-card: text only, ~1s answers
//   openrouter openrouter.ai :free models (no credits): backup vision + text
//   kaggle     your own notebook via quick-tunnel (see tally-copilot-model/)
// Anything unconfigured is skipped; when every provider fails the caller falls
// back to the deterministic local demo model below (offline-safe).

import { getSetting, setSetting } from './db.js';

// ---------- config ----------
function chain() {
  const raw = process.env.LLM_PROVIDERS || process.env.LLM_PROVIDER || 'gemini,kaggle';
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}
const GEMINI_MODEL = () => process.env.GEMINI_MODEL || 'gemini-flash-latest';
const GROQ_MODEL = () => process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const OR_MODEL = () => process.env.OPENROUTER_MODEL || 'qwen/qwen2.5-vl-72b-instruct:free';
const KAGGLE_MODEL = () => process.env.LLM_MODEL || 'tally-vl';
const timeoutMs = () => Number(process.env.LLM_TIMEOUT_MS) || 60000;
const baseUrl = async () => (await getSetting('llm_base_url') || process.env.LLM_BASE_URL_BOOTSTRAP || '').replace(/\/$/, '');

export async function llmStatus() {
  return {
    providers: chain(),
    last_source: await getSetting('llm_last_source') || null,
    base_url: await baseUrl() || null, // kaggle tunnel when registered
    online: await getSetting('llm_online') === '1',
    latency_ms: await getSetting('llm_latency_ms') ? Number(await getSetting('llm_latency_ms')) : null,
    checked_at: await getSetting('llm_checked_at') || null,
    tunnel_updated_at: await getSetting('llm_updated_at') || null,
  };
}

// Lightweight reachability probe for the background checker (kaggle tunnel only).
export async function pingLlm(ms = 8000) {
  const base = await baseUrl();
  if (!base) return { ok: false, reason: 'no tunnel registered' };
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    const res = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${process.env.LLM_API_KEY || ''}` }, signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

function parseJson(text) {
  const clean = String(text).replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('no JSON in AI reply');
  return JSON.parse(clean.slice(start, end + 1));
}

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const errMsg = e => (e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e)));

// ---------- transport: Gemini REST ----------
async function geminiCall({ system, text, imageBase64, mime, json, maxTokens }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY missing');
  const parts = [];
  if (imageBase64) parts.push({ inline_data: { mime_type: mime || 'image/jpeg', data: imageBase64 } });
  if (text) parts.push({ text });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs());
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL()}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ parts }],
        generationConfig: { temperature: 0, maxOutputTokens: maxTokens || 1500, ...(json ? { responseMimeType: 'application/json' } : {}) },
      }),
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
    const data = await res.json();
    const out = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    if (!out) throw new Error('empty Gemini reply (safety block or quota?)');
    return out;
  } finally { clearTimeout(t); }
}

// ---------- transport: OpenAI-compatible chat (groq / openrouter / kaggle) ----------
async function openaiChat({ base, key, modelName, messages, json, maxTokens, referer }) {
  if (!key) throw new Error('API key missing');
  if (!base) throw new Error('no endpoint');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs());
  // reasoning models (gpt-oss etc.) burn tokens thinking — guarantee room for the answer
  const budget = /gpt-oss|deepseek-r1/i.test(modelName || '') ? Math.max(maxTokens || 0, 1200) : (maxTokens || 1500);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...(referer ? { 'HTTP-Referer': process.env.APP_URL || 'http://localhost:5173', 'X-Title': 'Tally Copilot Demo' } : {}) },
      body: JSON.stringify({ model: modelName, temperature: 0, max_tokens: budget, ...(json ? { response_format: { type: 'json_object' } } : {}), messages }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('empty reply');
    return text;
  } finally { clearTimeout(t); }
}

// ---------- prompts (shared by every provider) ----------
const EXTRACT_SYSTEM = `You read Indian purchase bills AND purchase orders. Reply with JSON ONLY, exactly this shape, no other text:
{"document_kind":"invoice|purchase_order|receipt|other","vendor":{"name":"","gstin":"","address":"","state":""},"invoice":{"number":"","date":"YYYY-MM-DD"},"items":[{"description":"","hsn":"","qty":0,"rate":0,"amount":0,"tax_rate":0}],"totals":{"taxable":0,"cgst":0,"sgst":0,"igst":0,"grand_total":0},"confidence":{"vendor":0.0,"invoice":0.0,"items":0.0,"totals":0.0}}
Rules: document_kind is purchase_order for POs (put the PO number in invoice.number; PO totals usually have zero tax — transcribe as printed). tax_rate is one of 0,3,5,12,18,28. HSN is digits only. Transcribe numbers EXACTLY as printed — never round, never invent. If OCR pre-read text is provided alongside the photo, trust its numbers, GSTIN and HSN over pixels. confidence is 0-1 per section; if unsure, guess and lower confidence.`;

const VIEWS_DDL = `Views (MySQL, all scoped to the company):
v_receivables(customer, outstanding, days_overdue, city)
v_payables(vendor, outstanding, days_overdue)
v_gst_summary(month, cgst, sgst, igst, total_tax)
v_sales(date, number, party, total)
v_purchases(date, number, vendor, total)
v_stock(name, closing_qty, reorder_level)
v_bank_balances(name, balance)
v_order_mix(kind, orders, amount) — one row per kind ('sales','purchase'); use for counts, ratios, shares, "orders" questions
Vocabulary: orders = sales + purchase vouchers; bills/inward bills = purchases; sales/bikri = sales; udhaar = receivables; stock/maal = inventory.`;

const textSqlSystem = ({ fyStart, fyEnd }) => {
  const today = new Date().toISOString().slice(0, 10);
  return `You write one MySQL SELECT for Indian accounting questions. Reply with JSON ONLY: {"sql":"...","chart":"table|bar|line|none","title":"..."}. ${VIEWS_DDL} Today is ${today}, FY ${fyStart} to ${fyEnd}. Rules: single SELECT, only the listed views, always add LIMIT 200. NEVER invent columns: there is no "type" column anywhere, no "amount" column (use outstanding/total), no "name" column (use customer/vendor/ledger/party as listed), v_receivables uses customer never vendor, v_payables uses vendor never customer, v_purchases and v_sales have date/number/party|vendor/total only. Examples: "Which customers owe me more than 50k for over 60 days?" -> {"sql":"SELECT customer, outstanding AS amount, days_overdue, city FROM v_receivables WHERE outstanding > 50000 AND days_overdue > 60 ORDER BY outstanding DESC LIMIT 200","chart":"table","title":"Customers owing more than ₹50,000 for over 60 days"}. "60 din se zyada se paise dene wale grahak kaun hain?" -> {"sql":"SELECT customer, outstanding AS amount, days_overdue, city FROM v_receivables WHERE days_overdue > 60 ORDER BY outstanding DESC LIMIT 200","chart":"table","title":"60+ din se pending grahak"}. "GST summary by month" -> {"sql":"SELECT month, cgst, sgst, igst, total_tax FROM v_gst_summary ORDER BY month LIMIT 200","chart":"bar","title":"GST summary by month"}. "What is the ratio of my orders?" -> {"sql":"SELECT kind, orders, amount FROM v_order_mix LIMIT 200","chart":"bar","title":"Sales vs purchase orders"}.`;
};

// Exact columns per reporting view. The validator rejects anything else BEFORE
// it reaches the database, so a hallucinated column can never 500 the query.
export const VIEW_COLUMNS = {
  v_receivables: ['customer', 'outstanding', 'days_overdue', 'city', 'company_id'],
  v_payables: ['vendor', 'outstanding', 'days_overdue', 'company_id'],
  v_gst_summary: ['month', 'cgst', 'sgst', 'igst', 'total_tax', 'company_id'],
  v_sales: ['date', 'number', 'party', 'total', 'company_id', 'id'],
  v_purchases: ['date', 'number', 'party', 'vendor', 'total', 'company_id', 'id'],
  v_stock: ['name', 'closing_qty', 'reorder_level', 'company_id'],
  v_bank_balances: ['ledger', 'balance', 'company_id'],
  v_order_mix: ['kind', 'orders', 'amount', 'company_id'],
};
const SQL_WORDS = new Set('select,from,where,and,or,order,by,desc,asc,limit,group,having,count,sum,avg,max,min,as,on,join,inner,left,outer,distinct,between,like,in,not,null,is,case,when,then,else,end,cast,table,bar,line,none'.split(','));

export function validateColumns(sql) {
  const views = (String(sql).toLowerCase().match(/v_[a-z_]+/g) || []).filter((v, i, a) => a.indexOf(v) === i);
  const known = views.filter(v => VIEW_COLUMNS[v]);
  if (!known.length) return { ok: false, error: 'query uses no known reporting view' };
  const allowed = new Set();
  known.forEach(v => VIEW_COLUMNS[v].forEach(c => allowed.add(c)));
  // aliases the query itself defines (SELECT x AS y, FROM view t)
  const aliases = new Set();
  const low = String(sql);
  let m;
  const asRe = /\bas\s+([a-z_][a-z0-9_]*)/gi;
  while ((m = asRe.exec(low))) aliases.add(m[1].toLowerCase());
  const fromRe = /\b(?:from|join)\s+(v_[a-z_]+)\s+([a-z_][a-z0-9_]*)/gi;
  while ((m = fromRe.exec(low))) { if (!VIEW_COLUMNS[m[2].toLowerCase()]) aliases.add(m[2].toLowerCase()); }
  // strip string literals, function calls fn(, and table qualifiers t.
  const stripped = low.replace(/'[^']*'/g, "''").replace(/([a-z_][a-z0-9_]*)\s*\(/g, '').replace(/([a-z_][a-z0-9_]*)\./g, '');
  const words = stripped.match(/[a-z_][a-z0-9_]*/g) || [];
  const bad = [];
  for (const w of words) {
    if (SQL_WORDS.has(w) || aliases.has(w) || known.includes(w)) continue;
    if (!allowed.has(w) && !bad.includes(w)) bad.push(w);
  }
  if (!bad.length) return { ok: true };
  const dict = known.map(v => `${v}(${VIEW_COLUMNS[v].join(', ')})`).join('; ');
  return { ok: false, error: `unknown column(s) ${bad.map(b => `"${b}"`).join(', ')}. Usable columns — ${dict}. Rewrite using ONLY these.` };
}

const ocrBlock = ocrText => (ocrText && String(ocrText).trim() ? `\n\nOCR PRE-READ — an OCR engine already read this document. Trust its numbers, GSTIN and HSN over pixels; use the photo to fix OCR garbling:\n${String(ocrText).slice(0, 6000)}` : '');

const visionMessages = (imageBase64, mime, ocrText) => ([
  { role: 'system', content: EXTRACT_SYSTEM },
  { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } }, { type: 'text', text: 'Extract this bill as JSON.' + ocrBlock(ocrText) }] },
]);

function coerceExtraction(j) {
  if (!j.vendor?.name || !j.invoice?.number || !Array.isArray(j.items) || !j.items.length || j.totals?.grand_total == null)
    throw new Error('incomplete extraction JSON');
  j.items = j.items.map(it => ({ description: String(it.description || 'Item'), hsn: String(it.hsn || ''), qty: num(it.qty, 1), rate: num(it.rate), amount: num(it.amount, num(it.qty, 1) * num(it.rate)), tax_rate: num(it.tax_rate) }));
  const t = j.totals;
  j.totals = { taxable: num(t.taxable), cgst: num(t.cgst), sgst: num(t.sgst), igst: num(t.igst), grand_total: num(t.grand_total) };
  j.confidence = { vendor: num(j.confidence?.vendor, 0.8), invoice: num(j.confidence?.invoice, 0.8), items: num(j.confidence?.items, 0.8), totals: num(j.confidence?.totals, 0.8) };
  j.invoice.date = /^\d{4}-\d{2}-\d{2}$/.test(j.invoice.date || '') ? j.invoice.date : new Date().toISOString().slice(0, 10);
  const KINDS = ['invoice', 'purchase_order', 'receipt', 'other'];
  j.document_kind = KINDS.includes(String(j.document_kind || '').toLowerCase()) ? String(j.document_kind).toLowerCase() : 'invoice';
  return j;
}

function coerceTextSql(j, question) {
  if (!j.sql || !/select/i.test(j.sql)) throw new Error('no SQL in AI reply');
  return { sql: j.sql, chart: ['table', 'bar', 'line', 'none'].includes(j.chart) ? j.chart : 'table', title: String(j.title || question).slice(0, 140) };
}

// ---------- chain runner ----------
const SUPPORTED = ['gemini', 'groq', 'openrouter', 'kaggle'];
const VISION_OK = { gemini: true, openrouter: true, kaggle: true, groq: false }; // groq free tier: text only
async function providerReady(p) {
  if (p === 'gemini') return !!process.env.GEMINI_API_KEY;
  if (p === 'groq') return !!process.env.GROQ_API_KEY;
  if (p === 'openrouter') return !!process.env.OPENROUTER_API_KEY;
  if (p === 'kaggle') return !!(await baseUrl());
  return false;
}

async function runChain(kind, fn) {
  const errs = [];
  for (const p of chain()) {
    if (!SUPPORTED.includes(p) || !await providerReady(p)) continue;
    if (kind === 'extract' && !VISION_OK[p]) continue; // e.g. groq can't read bill photos
    try {
      const out = await fn(p);
      try { await setSetting('llm_last_source', p); } catch {}
      return { out, source: p };
    } catch (e) {
      errs.push(`${p}: ${errMsg(e)}`);
    }
  }
  throw new Error(errs.length ? errs.join(' | ') : 'no AI provider configured — add a free key (GEMINI_API_KEY) in .env');
}

export async function aiExtract({ imageBase64, mime, ocrText }) {
  return runChain('extract', async p => {
    if (p === 'gemini') return coerceExtraction(parseJson(await geminiCall({ system: EXTRACT_SYSTEM, text: 'Extract this bill as JSON.' + ocrBlock(ocrText), imageBase64, mime, json: true, maxTokens: 2000 })));
    if (p === 'kaggle') return coerceExtraction(parseJson(await openaiChat({ base: await baseUrl(), key: process.env.LLM_API_KEY || '', modelName: KAGGLE_MODEL(), messages: visionMessages(imageBase64, mime, ocrText), json: true, maxTokens: 2000 })));
    // openrouter
    return coerceExtraction(parseJson(await openaiChat({ base: 'https://openrouter.ai/api', key: process.env.OPENROUTER_API_KEY || '', modelName: OR_MODEL(), messages: visionMessages(imageBase64, mime, ocrText), json: true, maxTokens: 2000, referer: true })));
  });
}

// Text-only extraction for digital PDFs (pdf-parse output) — every provider can do it.
export async function aiExtractText(ocrText) {
  const text = String(ocrText || '').slice(0, 6000);
  if (text.trim().length < 20) throw new Error('no readable text in document');
  const user = `Extract this bill from its text (no photo available):\n\n${text}`;
  return runChain('text-extract', async p => {
    if (p === 'gemini') return coerceExtraction(parseJson(await geminiCall({ system: EXTRACT_SYSTEM, text: user, json: true, maxTokens: 2000 })));
    const base = p === 'groq' ? 'https://api.groq.com/openai' : p === 'kaggle' ? await baseUrl() : 'https://openrouter.ai/api';
    const key = p === 'groq' ? (process.env.GROQ_API_KEY || '') : p === 'kaggle' ? (process.env.LLM_API_KEY || '') : (process.env.OPENROUTER_API_KEY || '');
    const modelName = p === 'groq' ? GROQ_MODEL() : p === 'kaggle' ? KAGGLE_MODEL() : OR_MODEL();
    return coerceExtraction(parseJson(await openaiChat({ base, key, modelName, messages: [{ role: 'system', content: EXTRACT_SYSTEM }, { role: 'user', content: user }], json: true, maxTokens: 2000, referer: p === 'openrouter' })));
  });
}

export async function aiChat(question, ctx, correction) {
  const ask = q => (correction ? `${q}\n\nCORRECTION REQUIRED — follow it exactly:\n${correction}` : q);
  return runChain('chat', async p => {
    if (p === 'gemini') return coerceTextSql(parseJson(await geminiCall({ system: textSqlSystem(ctx), text: ask(question), json: true, maxTokens: 1500 })), question);
    if (p === 'groq') return coerceTextSql(parseJson(await openaiChat({ base: 'https://api.groq.com/openai', key: process.env.GROQ_API_KEY || '', modelName: GROQ_MODEL(), messages: [{ role: 'system', content: textSqlSystem(ctx) }, { role: 'user', content: ask(question) }], json: true, maxTokens: 800 })), question);
    if (p === 'kaggle') return coerceTextSql(parseJson(await openaiChat({ base: await baseUrl(), key: process.env.LLM_API_KEY || '', modelName: KAGGLE_MODEL(), messages: [{ role: 'system', content: textSqlSystem(ctx) }, { role: 'user', content: ask(question) }], json: true, maxTokens: 800 })), question);
    // openrouter
    return coerceTextSql(parseJson(await openaiChat({ base: 'https://openrouter.ai/api', key: process.env.OPENROUTER_API_KEY || '', modelName: OR_MODEL(), messages: [{ role: 'system', content: textSqlSystem(ctx) }, { role: 'user', content: ask(question) }], json: true, maxTokens: 800, referer: true })), question);
  });
}

export async function aiSummary(title, rows) {  const sample = JSON.stringify((rows || []).slice(0, 30)).slice(0, 3000);
  return runChain('summary', async p => {
    const sys = 'Answer in one or two plain sentences for a shop owner. Reply with plain text only, no JSON.';
    const user = `${title}. Data: ${sample}`;
    if (p === 'gemini') return (await geminiCall({ system: sys, text: user, maxTokens: 1000 })).trim().slice(0, 400);
    const base = p === 'groq' ? 'https://api.groq.com/openai' : p === 'kaggle' ? await baseUrl() : 'https://openrouter.ai/api';
    const key = p === 'groq' ? (process.env.GROQ_API_KEY || '') : p === 'kaggle' ? (process.env.LLM_API_KEY || '') : (process.env.OPENROUTER_API_KEY || '');
    const modelName = p === 'groq' ? GROQ_MODEL() : p === 'kaggle' ? KAGGLE_MODEL() : OR_MODEL();
    return (await openaiChat({ base, key, modelName, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], maxTokens: 200, referer: p === 'openrouter' })).trim().slice(0, 400);
  });
}

// ---------- generic text generation (every provider, chain order) ----------
export async function aiText({ system, user, json = false, maxTokens = 400 }) {
  return runChain('text', async p => {
    if (p === 'gemini') return (await geminiCall({ system, text: user, json, maxTokens })).trim();
    const base = p === 'groq' ? 'https://api.groq.com/openai' : p === 'kaggle' ? await baseUrl() : 'https://openrouter.ai/api';
    const key = p === 'groq' ? (process.env.GROQ_API_KEY || '') : p === 'kaggle' ? (process.env.LLM_API_KEY || '') : (process.env.OPENROUTER_API_KEY || '');
    const modelName = p === 'groq' ? GROQ_MODEL() : p === 'kaggle' ? KAGGLE_MODEL() : OR_MODEL();
    return (await openaiChat({ base, key, modelName, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], json, maxTokens, referer: p === 'openrouter' })).trim();
  });
}

// Anomaly explanations: rules decide, the model only writes friendly words (PRD 11.3).
export async function aiExplain({ voucher, flags }) {
  const ctx = `Voucher ${voucher.number} (${voucher.type}, total ${voucher.total}, party ${voucher.party_name || '—'}). Flags:\n` +
    flags.map(f => `- [${f.severity}] ${f.rule_code}: ${f.message}`).join('\n');
  const r = await aiText({
    system: 'You are an accountant explaining to an Indian shop owner in simple words. For EACH flag, write exactly one friendly sentence: what went wrong and how to fix it. No jargon, no moralising. Reply JSON ONLY: {"points":["..."]}.',
    user: ctx, json: true, maxTokens: 800,
  });
  const j = parseJson(r.out);
  if (!Array.isArray(j.points) || !j.points.length) throw new Error('no points');
  return { points: j.points.map(String).slice(0, 10), source: r.source };
}

export async function aiNarration({ type, party, lines }) {
  const desc = (lines || []).slice(0, 5).map(l => `${l.qty || 1}x ${l.description || l.ledger_name || 'goods'} (${l.amount || 0})`).join('; ').slice(0, 300);
  const r = await aiText({
    system: 'Write a Tally-style voucher narration: under 100 characters, format "Being ...". Plain text only, no quotes, no JSON.',
    user: `${type} voucher, party ${party || '—'}. Lines: ${desc}`, maxTokens: 120,
  });
  return { narration: r.out.replace(/^["']|["']$/g, '').slice(0, 140), source: r.source };
}

export async function aiSuggestHSN(description) {
  const r = await aiText({
    system: 'Suggest the single best Indian GST HSN code (4 to 8 digits) for the item. Reply JSON ONLY: {"hsn":"...","label":"...","confidence":0.0-1.0}.',
    user: `Item: ${String(description || '').slice(0, 120)}`, json: true, maxTokens: 200,
  });
  const j = parseJson(r.out);
  const hsn = String(j.hsn || '').replace(/\D/g, '').slice(0, 8);
  if (hsn.length < 4) throw new Error('no usable HSN');
  return { hsn, label: String(j.label || ''), confidence: num(j.confidence, 0.7), source: r.source };
}

export async function aiRewriteReminder({ name, amount, days, tone }) {
  const tones = { polite: 'warm and polite', strict: 'firm and strict (still professional)', funny: 'light and funny with Gen Z energy (still respectful)' };
  const r = await aiText({
    system: `Rewrite a shop payment reminder in a ${tones[tone] || tones.polite} tone. Keep the customer name, amount and days EXACTLY. Under 60 words. Plain text only.`,
    user: `Customer: ${name}. Amount pending: ${amount}. Days overdue: ${days}.`, maxTokens: 250,
  });
  return { text: r.out.slice(0, 500), source: r.source };
}

export async function aiDigestLine(bullets) {
  const r = await aiText({
    system: 'Given business-summary bullets for an Indian shop owner, write a fun one-line headline plus 2 concrete next actions. Reply JSON ONLY: {"headline":"...","next":["...","..."]}.',
    user: bullets.join('\n'), json: true, maxTokens: 400,
  });
  const j = parseJson(r.out);
  if (!j.headline) throw new Error('no headline');
  return { headline: String(j.headline).slice(0, 160), next: (Array.isArray(j.next) ? j.next : []).map(String).slice(0, 3), source: r.source };
}
// ---------------------------------------------------------------------------
// Local demo model — deterministic stand-in used ONLY when every provider
// fails or none is configured. Keeps the demo story runnable offline.
// ---------------------------------------------------------------------------
export function mockExtract({ fileName = 'bill.jpg' } = {}) {
  const flawed = /flawed|wrong|demo-6/i.test(fileName);
  if (flawed) {
    return {
      document_kind: 'invoice',
      vendor: { name: 'Shree Balaji Traders', gstin: '27ABCDE1234F1Z9', address: 'Kalbadevi, Mumbai', state: 'Maharashtra' },
      invoice: { number: 'SBT/2025/118', date: '2025-08-14' },
      items: [{ description: 'Cotton fabric', hsn: '5208', qty: 100, rate: 220, amount: 22000, tax_rate: 18 }],
      totals: { taxable: 22000, cgst: 1980, sgst: 1980, igst: 0, grand_total: 25960 },
      confidence: { vendor: 0.93, invoice: 0.88, items: 0.71, totals: 0.8 },
      note: 'DEMO-FLAWED: 18% on HSN 5208 (should be 5%) + GSTIN check-digit wrong.',
    };
  }
  if (/\bpo\b|purchase.order|demo-po/i.test(fileName)) {
    return {
      document_kind: 'purchase_order',
      vendor: { name: 'National Plastics Co', gstin: '27BBBCB2001C1Z2', address: 'MIDC Bhosari, Pune', state: 'Maharashtra' },
      invoice: { number: 'PO/25-26/077', date: '2025-09-10' },
      items: [
        { description: 'Plastic crates', hsn: '3923', qty: 200, rate: 240, amount: 48000, tax_rate: 0 },
      ],
      totals: { taxable: 48000, cgst: 0, sgst: 0, igst: 0, grand_total: 48000 },
      confidence: { vendor: 0.95, invoice: 0.95, items: 0.92, totals: 0.94 },
      note: 'SAMPLE-PO: purchase order — convert to a draft voucher, no tax posts until the real bill arrives.',
    };
  }
  return {
    document_kind: 'invoice',
    vendor: { name: 'Gupta Enterprises', gstin: '27AAKCG1234P1Z5', address: 'Andheri East, Mumbai', state: 'Maharashtra' },
    invoice: { number: 'GE/25-26/0421', date: '2025-09-02' },
    items: [
      { description: 'Office chairs', hsn: '9403', qty: 10, rate: 4500, amount: 45000, tax_rate: 18 },
      { description: 'Printer cartridges', hsn: '8443', qty: 5, rate: 1800, amount: 9000, tax_rate: 18 },
    ],
    totals: { taxable: 54000, cgst: 4860, sgst: 4860, igst: 0, grand_total: 63720 },
    confidence: { vendor: 0.96, invoice: 0.94, items: 0.9, totals: 0.93 },
  };
}

export function mockTextToSQL(q) {
  const s = q.toLowerCase();
  const has = (...ws) => ws.some(w => s.includes(w));
  if (has('ratio', 'share', 'mix', 'comparison', 'compare') || (has('orders', 'order') && !has('purchase', 'sales', 'kharid', 'bikri'))) {
    return { title: 'Sales vs purchase orders', chart: 'bar', sql: `SELECT kind, orders, amount FROM v_order_mix LIMIT 200` };
  }
  if (has('owe', 'receivable', 'udhaar', 'baki', 'bakaya') && has('customer', 'client', 'grahak', 'debtors') || (has('owe me') || has('kaun') && has('paisa'))) {
    const amt = (s.match(/(\d[\d,]*)\s*k/) ? Number(s.match(/(\d[\d,]*)\s*k/)[1].replace(/,/g, '')) * 1000 : 50000);
    const days = s.match(/(\d+)\s*days?/) ? Number(s.match(/(\d+)\s*days?/)[1]) : 60;
    return { title: `Customers owing more than ₹${amt.toLocaleString('en-IN')} for over ${days} days`, chart: 'table',
      sql: `SELECT customer, outstanding AS amount, days_overdue, city FROM v_receivables WHERE outstanding > ${amt} AND days_overdue > ${days} ORDER BY outstanding DESC LIMIT 200` };
  }
  if (has('payable', 'supplier', 'vendor', 'dena hai', 'creditor')) {
    return { title: 'Top payables by vendor', chart: 'bar', sql: `SELECT vendor, outstanding AS amount, days_overdue FROM v_payables ORDER BY outstanding DESC LIMIT 200` };
  }
  if (has('gst')) {
    return { title: 'GST summary by month', chart: 'bar', sql: `SELECT month, cgst, sgst, igst, total_tax FROM v_gst_summary ORDER BY month LIMIT 200` };
  }
  if (has('sales') || has('bikri') || has('becha')) {
    return { title: 'Sales this quarter', chart: 'line', sql: `SELECT date, total FROM v_sales ORDER BY date DESC LIMIT 200` };
  }
  if (has('purchase') || has('kharid')) {
    return { title: 'Recent purchases', chart: 'table', sql: `SELECT date, vendor, total FROM v_purchases ORDER BY date DESC LIMIT 200` };
  }
  if (has('stock') || has('inventory', 'maal')) {
    return { title: 'Low stock items', chart: 'table', sql: `SELECT name, closing_qty, reorder_level FROM v_stock WHERE closing_qty <= reorder_level LIMIT 200` };
  }
  if (has('bank') && has('balance')) {
    return { title: 'Bank balances', chart: 'table', sql: `SELECT ledger AS name, balance FROM v_bank_balances LIMIT 200` };
  }
  return { title: 'Recent vouchers', chart: 'table', sql: `SELECT date, number, vendor, total FROM v_purchases ORDER BY date DESC LIMIT 200` };
}

export function mockSummary(rows, title) {
  if (!rows || !rows.length) return 'No rows found for this question on the current data.';
  return `${title}: ${rows.length} row(s). Top result: ${JSON.stringify(rows[0]).slice(0, 160)}.`;
}
