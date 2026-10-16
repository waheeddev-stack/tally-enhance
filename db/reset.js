// Wipe EVERYTHING back to first-run state: `npm run reset`.
// Deletes all companies, users, ledgers, vouchers, bills, anomalies, logs —
// keeps the schema (tables + reporting views) and AI tunnel settings.
// After this, open /setup to create your own company + admin.
import { dbRun, dbExec, initDb } from '../src/db.js';

await initDb();

const TABLES = ['voucher_lines', 'vouchers', 'anomalies', 'bills', 'ledgers', 'ledger_groups', 'stock_items', 'users', 'companies', 'voucher_approvals', 'usage_counters', 'audit_log', 'chat_messages'];
await dbExec('PRAGMA foreign_keys=OFF');
for (const t of TABLES) {
  try { await dbRun(`DELETE FROM ${t}`); console.log('cleared', t); } catch (e) { console.log('skip', t, e.message); }
}
try { await dbExec('VACUUM'); } catch {}
console.log('\nClean. Open /setup to create your company + admin (chart of accounts is created automatically).');
console.log('To restore the demo story instead: npm run seed');
process.exit(0);
