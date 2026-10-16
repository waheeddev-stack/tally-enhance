-- Tally AI Copilot schema (SQLite for local demo; TiDB/MySQL compatible intent)
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gstin TEXT,
  state_code TEXT,
  fy_start TEXT,
  fy_end TEXT
);

CREATE TABLE IF NOT EXISTS ledger_groups (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id TEXT
);

CREATE TABLE IF NOT EXISTS ledgers (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  group_id TEXT,
  gstin TEXT,
  state_code TEXT,
  opening_balance REAL DEFAULT 0,
  credit_days INTEGER DEFAULT 0,
  tally_guid TEXT,
  tally_alter_id INTEGER DEFAULT 0,
  source TEXT DEFAULT 'mock'
);

CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  file_name TEXT,
  mime TEXT,
  file_blob BLOB,
  raw_extraction_json TEXT,
  confidence_json TEXT,
  status TEXT DEFAULT 'uploaded',
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vouchers (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  type TEXT NOT NULL,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  party_ledger_id TEXT,
  total REAL DEFAULT 0,
  narration TEXT DEFAULT '',
  status TEXT DEFAULT 'draft',
  source TEXT DEFAULT 'mock',
  bill_id TEXT,
  created_by TEXT,
  approved_by TEXT,
  cancelled_reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS voucher_lines (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL,
  ledger_id TEXT,
  ledger_name TEXT,
  description TEXT DEFAULT '',
  hsn TEXT DEFAULT '',
  qty REAL DEFAULT 0,
  rate REAL DEFAULT 0,
  amount REAL DEFAULT 0,
  tax_rate REAL DEFAULT 0,
  cgst REAL DEFAULT 0,
  sgst REAL DEFAULT 0,
  igst REAL DEFAULT 0,
  dc TEXT DEFAULT 'Dr'
);

CREATE TABLE IF NOT EXISTS stock_items (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT,
  hsn TEXT,
  unit TEXT,
  closing_qty REAL DEFAULT 0,
  reorder_level REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS anomalies (
  id TEXT PRIMARY KEY,
  voucher_id TEXT,
  bill_id TEXT,
  rule_code TEXT,
  severity TEXT,
  message TEXT,
  field_ref TEXT,
  resolved_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  company_id TEXT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role_preset TEXT DEFAULT 'viewer',
  is_admin INTEGER DEFAULT NULL,
  permissions_json TEXT,
  needs_approval INTEGER DEFAULT 0,
  approval_limit REAL DEFAULT 0,
  amount_limit REAL DEFAULT 0,
  active INTEGER DEFAULT 1,
  expires_on TEXT,
  must_change_password INTEGER DEFAULT 0,
  failed_logins INTEGER DEFAULT 0,
  locked_until TEXT,
  token_version INTEGER DEFAULT 1,
  last_login_at TEXT,
  created_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_single_admin ON users(is_admin);

CREATE TABLE IF NOT EXISTS voucher_approvals (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT,
  reason TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usage_counters (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  chat_count INTEGER DEFAULT 0,
  bill_count INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  entity TEXT,
  entity_id TEXT,
  action TEXT,
  actor TEXT,
  diff_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  user_id TEXT,
  role TEXT,
  content TEXT,
  sql_text TEXT,
  result_meta TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
