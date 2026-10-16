import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { db } from '../src/db.js';

const uid = () => randomUUID();
const rnd = (a, b) => Math.round(a + Math.random() * (b - a));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

console.log('Seeding Sharma Traders Pvt Ltd...');
db.exec('PRAGMA foreign_keys=OFF');
for (const t of ['voucher_lines','vouchers','anomalies','ledgers','ledger_groups','stock_items','users','companies','audit_log','chat_messages','usage_counters','bills','voucher_approvals'])
  try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}

const cid = uid();
db.prepare('INSERT INTO companies(id,name,gstin,state_code,fy_start,fy_end) VALUES(?,?,?,?,?,?)')
  .run(cid, 'Sharma Traders Pvt Ltd', '27AAKCS1234P1Z5', '27', '2025-04-01', '2026-03-31');

const GROUPS = ['Sundry Debtors','Sundry Creditors','Bank Accounts','Cash-in-hand','Sales Accounts','Purchase Accounts','Duties and Taxes','Direct Expenses','Indirect Expenses','Direct Income','Indirect Income','Capital Account'];
const gid = {};
for (const g of GROUPS) { const id = uid(); gid[g] = id; db.prepare('INSERT INTO ledger_groups(id,company_id,name) VALUES(?,?,?)').run(id, cid, g); }

// valid checksum GSTINs (fictional, checksum-correct via simple fixup is not critical for seed)
const customers = ['Amit Traders','Priya Retail Mart','Khan General Store','Mehta & Sons','Sunrise Departmental','City Super Bazaar','Laxmi Enterprises','Royal Collection','Fresh Daily Mart','New Bombay Stores','Shree Ganesh Traders','Patel Brothers'];
const vendors = ['Gupta Enterprises','Shree Balaji Traders','National Plastics Co','Rajeshwari Mills','Hindustan Hardware','Om Sai Packaging','Vardhman Textiles','Kothari Chemicals'];
const L = {};
function addLedger(name, group, gstin, opening = 0) {
  const id = uid(); L[name] = id;
  db.prepare('INSERT INTO ledgers(id,company_id,name,group_id,gstin,state_code,opening_balance) VALUES(?,?,?,?,?,?,?)').run(id, cid, name, gid[group], gstin, '27', opening);
  return id;
}
customers.forEach((n, i) => addLedger(n, 'Sundry Debtors', `27AAAAA${String(1000 + i)}A1Z${i % 10}`, rnd(20000, 150000)));
vendors.forEach((n, i) => addLedger(n, 'Sundry Creditors', `27BBBBB${String(2000 + i)}B1Z${i % 10}`, 0));
addLedger('HDFC Bank - 502001', 'Bank Accounts', null, 450000);
addLedger('SBI Current - 3901', 'Bank Accounts', null, 180000);
addLedger('Cash', 'Cash-in-hand', null, 75000);
addLedger('Purchase @5%', 'Purchase Accounts', null);
addLedger('Purchase @12%', 'Purchase Accounts', null);
addLedger('Purchase @18%', 'Purchase Accounts', null);
addLedger('Sales @18%', 'Sales Accounts', null);
addLedger('CGST', 'Duties and Taxes', null);
addLedger('SGST', 'Duties and Taxes', null);
addLedger('IGST', 'Duties and Taxes', null);
addLedger('Salary', 'Indirect Expenses', null);
addLedger('Rent', 'Indirect Expenses', null);

const stockNames = [['Office chair','9403'],['Printer cartridge','8443'],['Cotton fabric m','5208'],['Steel almirah','9403'],['LED panel','9403'],['Sugar 50kg','1701'],['Wheat flour 10kg','1001'],['Detergent carton','3402'],['Cement bag','2523'],['Paint 4L','3208'],['Mobile handset','8517'],['Laptop','8471'],['Tyre 12in','4011'],['Cotton shirt','6204'],['Leather shoes','6403'],['Tiles box','6907'],['Plywood sheet','4412'],['Ball bearing','8482'],['Medicine strip','3004'],['Tea powder 1kg','0902']];
for (const [n, h] of stockNames) db.prepare('INSERT INTO stock_items(id,company_id,name,hsn,unit,closing_qty,reorder_level) VALUES(?,?,?,?,?,?,?)').run(uid(), cid, n, h, 'pcs', rnd(5, 200), 20);

// ~150 vouchers across two quarters
const fyDates = () => { const m = rnd(4, 9); const d = rnd(1, 28); return `2025-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; };
let n = 0;
function voucher(type, partyName, total, date, status = 'approved', extra = {}) {
  n++;
  const prefix = { purchase: 'PUR', sales: 'SAL', receipt: 'RCP', payment: 'PAY', journal: 'JRN' }[type] || 'V';
  const id = uid();
  const pid = partyName ? L[partyName] : null;
  db.prepare('INSERT INTO vouchers(id,company_id,type,number,date,party_ledger_id,total,narration,status,source,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, cid, type, extra.number || `${prefix}/25-26/${String(n).padStart(4, '0')}`, date, pid, total, extra.narration || '', status, extra.source || 'mock', 'seed');
  const taxRate = extra.tax_rate ?? 18;
  const taxable = +(total / (1 + taxRate / 100)).toFixed(2);
  const tax = +((total - taxable) / 2).toFixed(2);
  db.prepare('INSERT INTO voucher_lines(id,voucher_id,ledger_id,ledger_name,description,hsn,qty,rate,amount,tax_rate,cgst,sgst,igst,dc) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(uid(), id, null, type === 'purchase' ? 'Purchase @18%' : 'Sales @18%', extra.desc || 'Goods', extra.hsn || '9403', 10, +(taxable / 10).toFixed(2), taxable, taxRate, tax, tax, 0, 'Dr');
  return { id, number: extra.number, total, date, party_ledger_id: pid };
}
for (let i = 0; i < 70; i++) voucher('sales', pick(customers), rnd(15000, 180000), fyDates());
for (let i = 0; i < 60; i++) voucher('purchase', pick(vendors), rnd(12000, 150000), fyDates());
for (let i = 0; i < 12; i++) voucher('receipt', pick(customers), rnd(10000, 80000), fyDates());
for (let i = 0; i < 8; i++) voucher('payment', pick(vendors), rnd(10000, 90000), fyDates());
// planted anomalies
voucher('purchase', 'Shree Balaji Traders', 25960, '2025-08-14', 'pending', { number: 'SBT/2025/118', hsn: '5208', tax_rate: 18, desc: 'Cotton fabric (wrong 18% — should be 5%)' });
voucher('purchase', 'Gupta Enterprises', 63720, '2025-09-02', 'pending', { number: 'GE/25-26/0421', desc: 'Office chairs' });
db.prepare("INSERT INTO anomalies(id,voucher_id,rule_code,severity,message,field_ref) VALUES(?,?,'duplicate_invoice','high','Seeded: duplicate invoice SBT/2025/118 for Shree Balaji Traders.','number')").run(uid(), db.prepare("SELECT id FROM vouchers WHERE number='SBT/2025/118'").get().id);
// ageing spread: 4 debtors >50k & >60 days
for (const [nm, amt, dt] of [['Amit Traders', 82000, '2025-05-10'], ['Mehta & Sons', 67500, '2025-06-02'], ['Royal Collection', 94000, '2025-04-22'], ['Patel Brothers', 58000, '2025-05-28']])
  voucher('sales', nm, amt, dt);

// users: 1 admin + accountant + data-entry + viewer
const mk = (name, email, pw, role, isAdmin, perms, extra = {}) => {
  const id = uid();
  db.prepare('INSERT INTO users(id,company_id,name,email,password_hash,role_preset,is_admin,permissions_json,needs_approval,approval_limit,amount_limit,active,must_change_password) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, cid, name, email, bcrypt.hashSync(pw, 10), role, isAdmin, JSON.stringify(perms), extra.needs_approval ? 1 : 0, extra.approval_limit || 0, extra.amount_limit || 0, 1, 0);
};
mk('Owner (Admin)', 'admin@sharma.local', 'admin123', 'admin', 1, { all: true });
mk('Anita Desai', 'anita@sharma.local', 'anita123', 'accountant', null, { voucher_types: ['sales', 'purchase', 'receipt', 'payment', 'journal'], 'voucher.approve': true, 'ai.ask': true }, { approval_limit: 100000 });
mk('Ravi Kumar', 'ravi@sharma.local', 'ravi123', 'data_entry', null, { modules: ['Vouchers', 'Upload'], voucher_types: ['purchase', 'sales'], hidden_groups: ['Bank Accounts', 'Salary'], date_lock: '2025-04-01', daily_chat_cap: 10, daily_bill_cap: 10, 'ai.ask': true }, { needs_approval: 1, amount_limit: 25000 });
mk('CA Viewer', 'viewer@sharma.local', 'viewer123', 'viewer', null, { modules: ['Reports'], 'report.view': true });

console.log(`Done. company=${cid} vouchers=${n}`);
console.log('Logins: admin@sharma.local/admin123 | anita@sharma.local/anita123 | ravi@sharma.local/ravi123 | viewer@sharma.local/viewer123');
