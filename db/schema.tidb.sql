-- Tally AI Copilot schema for TiDB Cloud (production).
-- Applied by src/db.js on boot (CREATE IF NOT EXISTS, split per statement).
-- Mirrors db/schema.sql. Dates/timestamps are VARCHAR(32) ISO-8601 UTC
-- ('YYYY-MM-DD' for dates, 'YYYY-MM-DDTHH:MM:SSZ' for timestamps) so that
-- string comparisons in the app behave EXACTLY like the SQLite dev database.
-- NOTE: `key`/`value` in app_settings are quoted below because KEY is reserved
-- in MySQL/TiDB — src/db.js translates the app's unquoted SQL automatically.

CREATE TABLE IF NOT EXISTS companies (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  gstin VARCHAR(20),
  state_code VARCHAR(4),
  fy_start VARCHAR(12),
  fy_end VARCHAR(12)
);

CREATE TABLE IF NOT EXISTS ledger_groups (
  id CHAR(36) PRIMARY KEY,
  company_id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  parent_id CHAR(36),
  INDEX idx_ledger_groups_company (company_id)
);

CREATE TABLE IF NOT EXISTS ledgers (
  id CHAR(36) PRIMARY KEY,
  company_id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  group_id CHAR(36),
  gstin VARCHAR(20),
  state_code VARCHAR(4),
  opening_balance DOUBLE DEFAULT 0,
  credit_days INT DEFAULT 0,
  tally_guid VARCHAR(64),
  tally_alter_id INT DEFAULT 0,
  source VARCHAR(16) DEFAULT 'mock',
  INDEX idx_ledgers_company (company_id)
);

CREATE TABLE IF NOT EXISTS bills (
  id CHAR(36) PRIMARY KEY,
  company_id CHAR(36) NOT NULL,
  file_name VARCHAR(255),
  mime VARCHAR(64),
  file_blob LONGBLOB,
  raw_extraction_json MEDIUMTEXT,
  confidence_json TEXT,
  status VARCHAR(16) DEFAULT 'uploaded',
  created_by VARCHAR(255),
  created_at VARCHAR(32) DEFAULT (DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%SZ')),
  INDEX idx_bills_company (company_id)
);

CREATE TABLE IF NOT EXISTS vouchers (
  id CHAR(36) PRIMARY KEY,
  company_id CHAR(36) NOT NULL,
  type VARCHAR(16) NOT NULL,
  number VARCHAR(64) NOT NULL,
  date VARCHAR(12) NOT NULL,
  party_ledger_id CHAR(36),
  total DOUBLE DEFAULT 0,
  narration VARCHAR(1000) DEFAULT '',
  status VARCHAR(16) DEFAULT 'draft',
  source VARCHAR(16) DEFAULT 'mock',
  bill_id CHAR(36),
  created_by VARCHAR(255),
  approved_by VARCHAR(255),
  cancelled_reason VARCHAR(500),
  created_at VARCHAR(32) DEFAULT (DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%SZ')),
  INDEX idx_vouchers_company (company_id),
  INDEX idx_vouchers_party (party_ledger_id)
);

CREATE TABLE IF NOT EXISTS voucher_lines (
  id CHAR(36) PRIMARY KEY,
  voucher_id CHAR(36) NOT NULL,
  ledger_id CHAR(36),
  ledger_name VARCHAR(255),
  description VARCHAR(500) DEFAULT '',
  hsn VARCHAR(32) DEFAULT '',
  qty DOUBLE DEFAULT 0,
  rate DOUBLE DEFAULT 0,
  amount DOUBLE DEFAULT 0,
  tax_rate DOUBLE DEFAULT 0,
  cgst DOUBLE DEFAULT 0,
  sgst DOUBLE DEFAULT 0,
  igst DOUBLE DEFAULT 0,
  dc VARCHAR(4) DEFAULT 'Dr',
  INDEX idx_voucher_lines_voucher (voucher_id)
);

CREATE TABLE IF NOT EXISTS stock_items (
  id CHAR(36) PRIMARY KEY,
  company_id CHAR(36) NOT NULL,
  name VARCHAR(255),
  hsn VARCHAR(32),
  unit VARCHAR(16),
  closing_qty DOUBLE DEFAULT 0,
  reorder_level DOUBLE DEFAULT 0,
  INDEX idx_stock_company (company_id)
);

CREATE TABLE IF NOT EXISTS anomalies (
  id CHAR(36) PRIMARY KEY,
  voucher_id CHAR(36),
  bill_id CHAR(36),
  rule_code VARCHAR(64),
  severity VARCHAR(16),
  message TEXT,
  field_ref VARCHAR(255),
  resolved_at VARCHAR(32),
  created_at VARCHAR(32) DEFAULT (DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%SZ')),
  INDEX idx_anomalies_voucher (voucher_id)
);

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY,
  company_id CHAR(36),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role_preset VARCHAR(32) DEFAULT 'viewer',
  is_admin INT DEFAULT NULL,
  permissions_json MEDIUMTEXT,
  needs_approval INT DEFAULT 0,
  approval_limit DOUBLE DEFAULT 0,
  amount_limit DOUBLE DEFAULT 0,
  active INT DEFAULT 1,
  expires_on VARCHAR(32),
  must_change_password INT DEFAULT 0,
  failed_logins INT DEFAULT 0,
  locked_until VARCHAR(32),
  token_version INT DEFAULT 1,
  last_login_at VARCHAR(32),
  created_by VARCHAR(255),
  UNIQUE KEY uq_single_admin (is_admin)
);

CREATE TABLE IF NOT EXISTS voucher_approvals (
  id CHAR(36) PRIMARY KEY,
  voucher_id CHAR(36) NOT NULL,
  action VARCHAR(32) NOT NULL,
  actor_id CHAR(36),
  reason VARCHAR(500) DEFAULT '',
  created_at VARCHAR(32) DEFAULT (DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%SZ')),
  INDEX idx_approvals_voucher (voucher_id)
);

CREATE TABLE IF NOT EXISTS usage_counters (
  user_id CHAR(36) NOT NULL,
  day VARCHAR(12) NOT NULL,
  chat_count INT DEFAULT 0,
  bill_count INT DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS app_settings (
  `key` VARCHAR(191) PRIMARY KEY,
  `value` MEDIUMTEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id CHAR(36) PRIMARY KEY,
  entity VARCHAR(64),
  entity_id CHAR(36),
  action VARCHAR(64),
  actor VARCHAR(255),
  diff_json MEDIUMTEXT,
  created_at VARCHAR(32) DEFAULT (DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%SZ'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id CHAR(36) PRIMARY KEY,
  session_id VARCHAR(64),
  user_id CHAR(36),
  role VARCHAR(16),
  content MEDIUMTEXT,
  sql_text TEXT,
  result_meta TEXT,
  created_at VARCHAR(32) DEFAULT (DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%SZ')),
  INDEX idx_chat_user_session (user_id, session_id)
);
