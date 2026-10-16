// Unlock a locked-out account WITHOUT logging in:  npm run unlock -- <email>
// No email  -> lists all currently locked accounts.
// With email -> clears failed logins + lockout, writes an audit row.
// This is the escape hatch when the only admin gets locked (there is no other admin to ask).
import { db } from '../src/db.js';
import { randomUUID } from 'node:crypto';

const email = (process.argv[2] || '').toLowerCase();
if (!email) {
  const rows = db.prepare("SELECT email, name, failed_logins, locked_until FROM users WHERE locked_until IS NOT NULL AND locked_until > datetime('now')").all();
  if (!rows.length) console.log('No locked accounts right now.');
  else { console.log('Locked accounts:'); for (const r of rows) console.log(` - ${r.email} (${r.name}) fails=${r.failed_logins} until=${r.locked_until}`); }
  console.log('\nUsage: npm run unlock -- <email>');
} else {
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!u) { console.log(`No such user: ${email}`); process.exit(1); }
  db.prepare('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=?').run(u.id);
  try {
    db.prepare('INSERT INTO audit_log(id,entity,entity_id,action,actor,diff_json) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), 'user', u.id, 'unlock', 'cli', JSON.stringify({ by: 'npm run unlock' }));
  } catch {}
  console.log(`Unlocked ${u.email} — they can log in immediately.`);
}
