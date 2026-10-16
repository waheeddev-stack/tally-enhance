// Wipe EVERYTHING back to first-run state: `npm run reset`.
// Deletes all companies, users, ledgers, vouchers, bills, anomalies, logs —
// keeps the schema (tables + reporting views) and AI tunnel settings.
// After this, open /setup to create your own company + admin.
import { db } from '../src/db.js';

const TABLES = ['voucher_lines', 'vouchers', 'anomalies', 'bills', 'ledgers', 'ledger_groups', 'stock_items', 'users', 'companies', 'voucher_approvals', 'usage_counters', 'audit_log', 'chat_messages'];
db.exec('PRAGMA foreign_keys=OFF');
for (const t of TABLES) {
  try { db.prepare(`DELETE FROM ${t}`).run(); console.log('cleared', t); } catch (e) { console.log('skip', t, e.message); }
}
try { db.exec('VACUUM'); } catch {}
console.log('\nClean. Open /setup to create your company + admin (chart of accounts is created automatically).');
console.log('To restore the demo story instead: npm run seed');
