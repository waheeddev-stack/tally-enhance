// Deterministic anomaly engine — PRD section 11.3. LLM only explains; rules decide.
import { dbGet, dbAll, dbPrepare } from './db.js';
import { validateGSTIN, validRatesForHSN } from './lib_gstin.js';
import { randomUUID } from 'node:crypto';

export async function runAnomalies(voucher, lines = [], opts = {}) {
  const flags = [];
  const push = (rule_code, severity, message, field_ref = '') =>
    flags.push({ id: randomUUID(), voucher_id: voucher.id ?? null, bill_id: voucher.bill_id ?? null, rule_code, severity, message, field_ref });

  const companyId = voucher.company_id;
  const fyStart = opts.fy_start, fyEnd = opts.fy_end;

  // duplicate invoice: same vendor + invoice no (narration/number), or vendor+amount+date±3d
  if (voucher.party_ledger_id && voucher.number) {
    const dup = await dbGet(
      `SELECT id FROM vouchers WHERE company_id=? AND party_ledger_id=? AND number=? AND id<>? AND status<>'cancelled' LIMIT 1`,
      [companyId, voucher.party_ledger_id, voucher.number, voucher.id || 'none']);
    if (dup) push('duplicate_invoice', 'high', `Duplicate invoice no. ${voucher.number} for this vendor.`, 'number');
    else if (voucher.total) {
      const near = await dbGet(
        `SELECT id FROM vouchers WHERE company_id=? AND party_ledger_id=? AND ABS(total-?)<0.01 AND ABS(julianday(date)-julianday(?))<=3 AND id<>? AND status<>'cancelled' LIMIT 1`,
        [companyId, voucher.party_ledger_id, voucher.total, voucher.date, voucher.id || 'none']);
      if (near) push('duplicate_invoice', 'high', 'Same vendor, amount and date (±3 days) already exists — possible duplicate.', 'total');
    }
  }
  // GSTIN invalid / mismatch
  if (opts.vendor_gstin) {
    const v = validateGSTIN(opts.vendor_gstin);
    if (!v.ok) push('gstin_invalid', 'high', `Vendor GSTIN ${opts.vendor_gstin}: ${v.reason}.`, 'vendor_gstin');
    if (opts.ledger_gstin && opts.vendor_gstin.toUpperCase() !== String(opts.ledger_gstin).toUpperCase())
      push('gstin_mismatch', 'high', 'Bill GSTIN differs from GSTIN saved on the ledger.', 'vendor_gstin');
  }
  // per-line checks
  const VALID_RATES = new Set([0, 0.1, 0.25, 1.5, 3, 5, 12, 18, 28]);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const ref = `items[${i}]`;
    if (!ln.hsn) push('missing_hsn', 'medium', `Line ${i + 1} (${ln.description || 'item'}) has no HSN/SAC.`, ref);
    const allowed = validRatesForHSN(ln.hsn);
    if (allowed && ln.tax_rate != null && !allowed.includes(Number(ln.tax_rate)))
      push('wrong_gst_rate', 'high', `Line ${i + 1}: ${ln.tax_rate}% is unusual for HSN ${ln.hsn} (expected ${allowed.join('/')}).`, ref);
    else if (ln.tax_rate != null && !VALID_RATES.has(Number(ln.tax_rate)) && !(allowed || []).includes(Number(ln.tax_rate)))
      push('wrong_gst_rate', 'high', `Line ${i + 1}: GST rate ${ln.tax_rate}% is not a valid slab.`, ref);
    const taxable = Number(ln.qty || 0) * Number(ln.rate || 0) || Number(ln.amount || 0);
    const stated = Number(ln.cgst || 0) + Number(ln.sgst || 0) + Number(ln.igst || 0);
    const computed = taxable * Number(ln.tax_rate || 0) / 100;
    if (ln.tax_rate && Math.abs(computed - stated) > 1)
      push('tax_math_error', 'high', `Line ${i + 1}: tax ₹${stated.toFixed(2)} ≠ ${ln.tax_rate}% of taxable (₹${computed.toFixed(2)}).`, ref);
  }
  // unusual amount: > mean + 3σ for vendor
  if (voucher.party_ledger_id && voucher.total) {
    const rows = await dbAll(`SELECT total FROM vouchers WHERE company_id=? AND party_ledger_id=? AND status='approved' LIMIT 50`, [companyId, voucher.party_ledger_id]);
    if (rows.length >= 5) {
      const vals = rows.map(r => r.total);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 0;
      if (Number(voucher.total) > mean + 3 * sd && sd > 0)
        push('unusual_amount', 'medium', `₹${Number(voucher.total).toLocaleString('en-IN')} is unusually large for this vendor (avg ₹${Math.round(mean).toLocaleString('en-IN')}).`, 'total');
    }
  }
  // date outside FY
  if (fyStart && fyEnd && voucher.date && (voucher.date < fyStart || voucher.date > fyEnd))
    push('date_outside_fy', 'medium', `Date ${voucher.date} is outside FY ${fyStart}–${fyEnd}.`, 'date');
  // odd ledger heuristic
  if (opts.odd_ledger) push('odd_ledger', 'low', opts.odd_ledger, 'ledger');

  return flags;
}

export function persistAnomalies(flags) {
  const ins = dbPrepare(`INSERT INTO anomalies(id,voucher_id,bill_id,rule_code,severity,message,field_ref,created_at) VALUES(?,?,?,?,?,?,?,?)`);
  const del = voucherId => dbPrepare('DELETE FROM anomalies WHERE voucher_id=?').run(voucherId);
  return { ins, del };
}
