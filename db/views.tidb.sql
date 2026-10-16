-- Reporting views for TiDB Cloud (production) — SINGLE SOURCE OF TRUTH for tidb.
-- Loaded by src/db.js on boot and rebuilt by `npm run db:fix`.
-- Same view/column names as db/views.sql so AI chat + reports work unchanged.
-- NOTE: GROUP BY lists every non-aggregated column (TiDB enforces
-- ONLY_FULL_GROUP_BY); results match the SQLite views for single-company data.
CREATE VIEW v_receivables AS
SELECT l.name AS customer, l.name AS name, COALESCE(SUM(v.total),0) AS outstanding,
       COALESCE(MAX(DATEDIFF(UTC_TIMESTAMP(), v.date)),0) AS days_overdue,
       'Mumbai' AS city, v.company_id AS company_id
FROM ledgers l LEFT JOIN vouchers v ON v.party_ledger_id=l.id AND v.type='sales' AND v.status='approved' GROUP BY l.id, l.name, v.company_id;
CREATE VIEW v_payables AS
SELECT l.name AS vendor, COALESCE(SUM(v.total),0) AS outstanding,
       COALESCE(MAX(DATEDIFF(UTC_TIMESTAMP(), v.date)),0) AS days_overdue,
       v.company_id AS company_id
FROM ledgers l LEFT JOIN vouchers v ON v.party_ledger_id=l.id AND v.type='purchase' AND v.status='approved' GROUP BY l.id, l.name, v.company_id;
CREATE VIEW v_gst_summary AS
SELECT SUBSTRING(v.date,1,7) AS month, SUM(vl.cgst) AS cgst, SUM(vl.sgst) AS sgst, SUM(vl.igst) AS igst,
       SUM(vl.cgst+vl.sgst+vl.igst) AS total_tax, v.company_id AS company_id
FROM vouchers v JOIN voucher_lines vl ON vl.voucher_id=v.id WHERE v.status='approved' GROUP BY month, v.company_id;
CREATE VIEW v_sales AS
SELECT v.date AS date, v.number AS number, COALESCE(l.name,'') AS party, v.total AS total, v.company_id AS company_id, v.id AS id
FROM vouchers v LEFT JOIN ledgers l ON l.id=v.party_ledger_id WHERE v.type='sales' AND v.status='approved';
CREATE VIEW v_purchases AS
SELECT v.date AS date, v.number AS number, COALESCE(l.name,'') AS party, COALESCE(l.name,'') AS vendor, v.total AS total, v.company_id AS company_id, v.id AS id
FROM vouchers v LEFT JOIN ledgers l ON l.id=v.party_ledger_id WHERE v.type='purchase' AND v.status<>'cancelled';
CREATE VIEW v_stock AS
SELECT name, hsn, closing_qty, reorder_level, company_id FROM stock_items;
CREATE VIEW v_bank_balances AS
SELECT l.name AS ledger, l.opening_balance AS balance, l.company_id AS company_id FROM ledgers l JOIN ledger_groups g ON g.id=l.group_id WHERE g.name='Bank Accounts';
CREATE VIEW v_order_mix AS
SELECT 'sales' AS kind, COUNT(*) AS orders, COALESCE(SUM(total),0) AS amount, company_id FROM vouchers WHERE type='sales' AND status<>'cancelled' GROUP BY company_id
UNION ALL
SELECT 'purchase' AS kind, COUNT(*) AS orders, COALESCE(SUM(total),0) AS amount, company_id FROM vouchers WHERE type='purchase' AND status<>'cancelled' GROUP BY company_id;
