// GSTIN validation (structure + check digit) + tax math, per PRD FR-4/FR-5
const STATE_CODES = new Set(Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, '0')));

const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function gstinCheckDigit(gstin14) {
  let factor = 1, sum = 0;
  for (let i = 0; i < 14; i++) {
    const code = CHARSET.indexOf(gstin14[i]);
    if (code < 0) return null;
    let prod = code * factor;
    // sum base-36 digits
    sum += Math.floor(prod / 36) + (prod % 36);
    factor = factor === 1 ? 2 : 1;
  }
  const check = (36 - (sum % 36)) % 36;
  return CHARSET[check];
}

export function validateGSTIN(gstin) {
  if (!gstin || typeof gstin !== 'string') return { ok: false, reason: 'GSTIN missing' };
  const g = gstin.trim().toUpperCase();
  const re = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
  if (g.length !== 15) return { ok: false, reason: 'GSTIN must be 15 characters' };
  if (!re.test(g)) return { ok: false, reason: 'GSTIN structure invalid' };
  if (!STATE_CODES.has(g.slice(0, 2))) return { ok: false, reason: 'State code invalid' };
  const expected = gstinCheckDigit(g.slice(0, 14));
  if (expected !== g[14]) return { ok: false, reason: 'GSTIN check-digit mismatch' };
  return { ok: true };
}

// HSN -> valid GST rates lookup (small demo table)
export const HSN_RATES = {
  '1001': [0, 5], '1701': [5, 12], '2710': [18], '3004': [5, 12],
  '5208': [5], '6204': [5, 12], '6403': [18], '6907': [18],
  '7210': [18], '8471': [18], '8517': [18], '8708': [18, 28],
  '9403': [12, 18], '9968': [18], '9992': [18],
};
export function validRatesForHSN(hsn) {
  if (!hsn) return null;
  const h = String(hsn).replace(/\s/g, '').slice(0, 4);
  return HSN_RATES[h] ?? [0, 3, 5, 12, 18, 28];
}
