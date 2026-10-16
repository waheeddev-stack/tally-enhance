import jwt from 'jsonwebtoken';
import { dbGet, dbRun } from '../db.js';

const SECRET = () => process.env.JWT_SECRET || 'dev-only-change-me-long-random-string';

export function signToken(user) {
  return jwt.sign({ uid: user.id, tv: user.token_version || 1 }, SECRET(), { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
}

export async function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: 'Login required' });
  try {
    const payload = jwt.verify(tok, SECRET());
    const user = await dbGet('SELECT * FROM users WHERE id=?', [payload.uid]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (!user.active) return res.status(403).json({ error: 'Account inactive' });
    if (user.expires_on && user.expires_on < new Date().toISOString().slice(0, 10))
      return res.status(403).json({ error: 'Account expired' });
    if ((user.token_version || 1) !== (payload.tv || 1))
      return res.status(401).json({ error: 'Session revoked. Please login again.' });
    if (user.locked_until && user.locked_until > new Date().toISOString())
      return res.status(403).json({ error: 'Account locked. Contact admin.' });
    req.user = user;
    try { req.perms = user.permissions_json ? JSON.parse(user.permissions_json) : {}; } catch { req.perms = {}; }
    req.viewAs = payload.viewAs === true;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.is_admin === 1) return next();
  return res.status(403).json({ error: 'Admin only' });
}

// requirePermission('voucher.approve') — admin bypasses; view-as mode blocks writes
export function requirePermission(perm) {
  return (req, res, next) => {
    if (req.user?.is_admin === 1 && !req.viewAs) return next();
    if (req.viewAs && !perm.startsWith('view')) {
      const WRITE = ['create', 'edit', 'approve', 'cancel', 'submit', 'upload', 'ask'];
      if (WRITE.some(w => perm.includes(w))) return res.status(403).json({ error: 'View-as mode is read-only' });
    }
    const p = req.perms || {};
    const flat = p[perm];
    if (flat === true) return next();
    // support { voucher: { approve: true } } style
    const [ns, act] = perm.split('.');
    if (p[ns] && (p[ns][act] === true || p[ns] === true)) return next();
    // legacy role presets
    const role = req.user?.role_preset;
    const ROLE_ALLOW = {
      accountant: ['voucher.create', 'voucher.edit', 'voucher.submit', 'voucher.approve', 'bill.upload', 'ai.ask', 'report.view', 'ledger.create', 'export'],
      data_entry: ['voucher.create', 'bill.upload', 'report.view'],
      viewer: ['report.view'],
    };
    if (ROLE_ALLOW[role]?.includes(perm)) return next();
    return res.status(403).json({ error: `Forbidden: need ${perm}` });
  };
}

export async function audit(entity, entity_id, action, actor, diff) {
  // Fire-and-forget safe: never throws, so callers don't need to await it.
  try {
    await dbRun('INSERT INTO audit_log(id,entity,entity_id,action,actor,diff_json) VALUES(?,?,?,?,?,?)',
      [crypto.randomUUID(), entity, entity_id, action, actor, JSON.stringify(diff ?? null)]);
  } catch {}
}
