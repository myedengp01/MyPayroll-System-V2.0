// MyPayroll-System-V2.0 · engines/leaveimport.js
// One-time import of 2026 leave, replacement leave, AL buy-back, OT and part-time hours from the
// MEG-EPPD workbook (ALMC_PT_2025 + StaffPersonalData), with a reconciliation against PayrollSMRY2026.

import { excelSerialToIso } from './employee.js';
import { leaveBalances } from './leave.js';

export const ALMC_SHEET = 'ALMC_PT_2025';
export const STAFF_SHEET = 'StaffPersonalData';
export const PAYROLL_SHEET = 'PayrollSMRY2026';

// column offsets from AJP (the workbook's "Fill Up Data Sheet" key column), as used by PayrollSMRY2026's VLOOKUPs
const OFF = { AL: 21, RL_EARN: 42, RL_TAKEN: 43, HPL: 63, MTL: 84, PTL: 105, CPL: 126, SL: 147, UPL: 168, PTH: 189, BUYBACK: 210,
  OT_N: 290, RD_HALF: [294, 8], RD_FULL: [306, 8], RD_EXCESS: [320, 8], PH_NORMAL: [333, 5], PH_EXCESS: [342, 5] };
const LEAVE_TYPES = { AL: 'AL', SL: 'SL', HPL: 'HPL', MTL: 'MTL', PTL: 'PTL', CPL: 'CPL', UPL: 'UPL', RL_TAKEN: 'RL' };
const SLOT_CATS = { RD_HALF: 'RD_HALF', RD_FULL: 'RD_FULL', RD_EXCESS: 'RD_EXCESS', PH_NORMAL: 'PH_NORMAL', PH_EXCESS: 'PH_EXCESS' };

const colIndex = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const colName = (i) => { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const AJP = colIndex('AJP');
const val = (ws, addr) => { const c = ws[addr]; return c && c.t !== 'e' && c.v !== undefined ? c.v : null; };
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const clean = (s) => String(s || '').toUpperCase().replace(/\s*\((OLD|1ST EMPLOYED|[^)]*EMPLOYED[^)]*)\)\s*$/i, '').replace(/\s+/g, ' ').trim();
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const monthLabel = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export function readLeaveSheets(sheets, year) {
  const a = sheets[ALMC_SHEET];
  if (!a) throw new Error(`Sheet “${ALMC_SHEET}” was not found in this file.`);
  const rows = [];
  for (let r = 5; r <= 3000; r++) {
    const key = val(a, `AJP${r}`);
    if (typeof key !== 'string') { if (r > 1200) break; continue; }
    const m = /^(.*?)(\d{5})$/.exec(key); if (!m) continue;
    const month = excelSerialToIso(Number(m[2]));
    if (!month || Number(month.slice(0, 4)) !== year) continue;
    const row = { row: r, name: clean(m[1]), month: month.slice(0, 7) + '-01', v: {} };
    for (const [k, off] of Object.entries(OFF)) {
      const list = Array.isArray(off) ? Array.from({ length: off[1] }, (_, i) => off[0] + i) : [off];
      const vals = list.map((o) => num(val(a, `${colName(AJP + o)}${r}`))).filter((x) => x !== null && x !== 0);
      if (vals.length) row.v[k] = vals;
    }
    if (Object.keys(row.v).length) rows.push(row);
  }
  const s = sheets[STAFF_SHEET]; const staff = [];
  if (s) for (let r = 6; r <= 2000; r++) {
    const n = val(s, `B${r}`); if (!n) { if (r > 400) break; continue; }
    staff.push({ row: r, name: clean(n), join: excelSerialToIso(num(val(s, `CD${r}`))), bf: num(val(s, `FZ${r}`)), typedEntitled: num(val(s, `GA${r}`)), sl: num(val(s, `SP${r}`)) });
  }
  const p = sheets[PAYROLL_SHEET]; const pay = [];
  if (p) for (let r = 10; r <= 5000; r++) {
    const n = val(p, `U${r}`), mo = excelSerialToIso(num(val(p, `O${r}`)));
    if (!n || !mo) { if (r > 1200) break; continue; }
    pay.push({ name: clean(n), month: mo, DK: num(val(p, `DK${r}`)), DE: num(val(p, `DE${r}`)), DT: num(val(p, `DT${r}`)),
               EI: num(val(p, `EI${r}`)), EO: num(val(p, `EO${r}`)), CG: num(val(p, `CG${r}`)), CS: num(val(p, `CS${r}`)) });
  }
  return { rows, staff, pay };
}

/**
 * employees: [{ id, full_name, gender, employment:{join_date, resigned_date, job_status, weekly_hours, confirmation_status} }]
 * policies: { al_entitlement, leave_rules, part_time }
 */
export function buildLeaveImport(sheets, employees, policies, { year = 2026, asOf } = {}) {
  const { rows, staff, pay } = readLeaveSheets(sheets, year);
  const byName = new Map();
  for (const e of employees) { const k = clean(e.full_name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(e); }
  const issues = []; const unmatched = new Map();
  const payload = { source: 'MEG-EPPD workbook', records: [], adjustments: [], time: [] };
  const counts = { rows: rows.length, people: new Set(), records: 0, adjustments: 0, time: 0 };
  const resolve = (name) => { const list = byName.get(name); return list && list.length === 1 ? list[0] : null; };

  for (const r of rows) {
    const emp = resolve(r.name);
    if (!emp) { unmatched.set(r.name, (unmatched.get(r.name) || 0) + 1); continue; }
    counts.people.add(emp.id);
    const label = monthLabel(r.month);
    for (const [k, type] of Object.entries(LEAVE_TYPES)) {
      const d = r.v[k]; if (!d) continue;
      payload.records.push({ employee_id: emp.id, leave_type: type, date_from: r.month, date_to: r.month, days: r2(d.reduce((s, x) => s + x, 0)), note: `Workbook total for ${label}` });
    }
    if (r.v.RL_EARN) payload.adjustments.push({ employee_id: emp.id, leave_type: 'RL', year, kind: 'earned', days: r2(r.v.RL_EARN[0]), effective_date: r.month, note: `Replacement leave earned, ${label} (workbook)` });
    if (r.v.BUYBACK) {
      // January buy-backs pay out the previous year's leftover (above the carry-forward cap); later ones are leavers' payouts
      const prior = r.month.slice(5, 7) === '01';
      payload.adjustments.push({ employee_id: emp.id, leave_type: 'AL', year: prior ? year - 1 : year, kind: 'buyback', days: r2(r.v.BUYBACK[0]), buyback_pct: 100,
        effective_date: prior ? `${year - 1}-12-31` : r.month,
        note: prior ? `${year - 1} leftover bought back in the ${label} payroll (workbook)` : `AL buy-back paid in the ${label} payroll (workbook)` });
    }
    if (r.v.OT_N) payload.time.push({ employee_id: emp.id, work_date: r.month, category: 'OT_NORMAL', hours: r2(r.v.OT_N[0]), note: `Workbook total for ${label}` });
    if (r.v.PTH) payload.time.push({ employee_id: emp.id, work_date: r.month, category: 'PT_HOURS', hours: r2(r.v.PTH[0]), note: `Workbook total for ${label}` });
    for (const [k, cat] of Object.entries(SLOT_CATS)) (r.v[k] || []).forEach((h, i) =>
      payload.time.push({ employee_id: emp.id, work_date: r.month, category: cat, hours: r2(h), note: `Workbook ${label}, day ${i + 1}` }));
  }
  for (const [name, n] of unmatched) issues.push({ level: 'check', code: 'unmatched', message: `${name}: ${n} month(s) of leave/OT data, but no employee with this name. Not imported.` });

  // brought forward from 2025: the latest StaffPersonalData row for each person
  const latestRow = new Map();
  for (const s of staff) { const prev = latestRow.get(s.name); if (!prev || (s.join || '') >= (prev.join || '')) latestRow.set(s.name, s); }
  for (const [name, s] of latestRow) {
    if (!s.bf) continue;
    const emp = resolve(name); if (!emp) continue;
    payload.adjustments.push({ employee_id: emp.id, leave_type: 'AL', year, kind: 'opening', days: r2(s.bf), effective_date: `${year}-01-01`, note: `Brought forward from ${year - 1} (workbook)` });
  }
  counts.records = payload.records.length; counts.adjustments = payload.adjustments.length; counts.time = payload.time.length;

  // ---- reconcile with the latest payroll month in the workbook ----
  const lastMonth = pay.reduce((m, p) => (p.month > m ? p.month : m), '');
  const recon = [];
  for (const p of pay.filter((x) => x.month === lastMonth)) {
    const emp = resolve(p.name); if (!emp) continue;
    const recs = payload.records.filter((x) => x.employee_id === emp.id && x.date_from <= lastMonth);
    const adjs = payload.adjustments.filter((x) => x.employee_id === emp.id && (x.effective_date || '') <= lastMonth);
    const bal = leaveBalances({ employment: emp.employment || {}, gender: emp.gender, year, asOf: asOf || `${lastMonth.slice(0, 7)}-28`,
      records: recs.map((x) => ({ ...x, status: 'taken' })), adjustments: adjs, policies });
    const alTakenApp = bal.AL.taken; const bf = bal.AL.carried;
    const rlBal = bal.RL.balance;
    const typed = p.DK ?? 0;
    const reasons = [];
    if (Math.abs(alTakenApp - (p.EI ?? 0)) > 0.01) reasons.push('AL taken differs');
    if (Math.abs(bf - (p.DE ?? 0)) > 0.01) reasons.push('Brought-forward differs');
    if (Math.abs(bal.AL.entitled - typed) > 0.01) reasons.push(typed === 0 ? 'Workbook entitlement left at 0' : 'Entitlement differs');
    if (bal.AL.buyback > 0 && bal.AL.balance < 0) reasons.push(`Bought back ${bal.AL.buyback} days, more than the balance`);
    if ((p.CG ?? 0) && Math.abs(bal.SL.entitled - p.CG) > 0.01) reasons.push(`Sick leave: workbook ${p.CG} days, Employment Act ${bal.SL.entitled}`);
    recon.push({ employee_id: emp.id, name: emp.full_name, month: lastMonth,
      wb: { entitled: typed, bf: p.DE ?? 0, rl: p.DT ?? 0, taken: p.EI ?? 0, balance: p.EO ?? 0, slTotal: p.CG ?? 0, slTaken: p.CS ?? 0 },
      app: { entitled: bal.AL.entitled, bf, rl: rlBal, taken: alTakenApp, buyback: bal.AL.buyback, balance: r2(bal.AL.balance + rlBal), slTotal: bal.SL.entitled, slTaken: bal.SL.taken, needsHours: bal.AL.needsHours },
      reasons });
  }
  return { payload, issues, recon, summary: { ...counts, people: counts.people.size, unmatched: unmatched.size, reconMonth: lastMonth,
    takenMatches: recon.filter((r) => !r.reasons.includes('AL taken differs')).length, reconRows: recon.length } };
}
