// MyPayroll-System-V2.0 · engines/payimport.js
// One-time import of past months from PayrollSMRY2026 as finalised ("fixed") pay lines,
// plus a comparison with what the new engine calculates for the same month.
// Uses the values Excel last calculated (cached cell values), never re-evaluates formulas.

import { excelSerialToIso } from './employee.js';
import { splitSocsoTotal } from './statutory.js';
import { itemFromType, computeLine, activeWindow, periodOf, r2, lineSummary, runTotals, STAT_KEYS, monthLabel, buildRun, recomputeLine } from './payroll.js';

export const PAYROLL_SHEET = 'PayrollSMRY2026';

// workbook column -> payment type code (earnings unless noted)
const ITEM_COLS = [
  ['NT', 'ALLOW_A1'], ['NZ', 'ALLOW_A2'], ['OF', 'ALLOW_A3'], ['OL', 'AL_BUYBACK'], ['OR', 'LEADER'], ['OX', 'MVC'],
  ['PD', 'COMMISSION'], ['PJ', 'FIRST_AID'], ['PP', 'SKM1'], ['PV', 'SKM2'], ['QB', 'TRANSPORT'],
  ['QN', 'OT_NORMAL'], ['QT', 'OT_RESTDAY'], ['QZ', 'OT_PH'], ['RD', 'BONUS'], ['RJ', 'ANG_BAO'],
];
const PERSONAL_COLS = [['VN', 'CHILDCARE'], ['VT', 'LOAN'], ['VZ', 'OTHER_DED']];
const STAT_COLS = { epf_ee: 'SB', epf_er: 'SN', socso_ee: 'SZ', socso_er: 'TL', eis_ee: 'TX', eis_er: 'UJ' };
const READ = ['O', 'U', 'SQ', 'LF', 'LR', 'LX', 'LL', 'NB', 'NH', 'KT', 'RP', 'NN', 'VB', 'VH', 'WL',
  ...ITEM_COLS.map((c) => c[0]), ...PERSONAL_COLS.map((c) => c[0]), ...Object.values(STAT_COLS)];

const cell = (ws, addr) => ws[addr] || null;
const isErr = (c) => c && (c.t === 'e' || (typeof c.v === 'string' && /^#/.test(c.v)));
const num = (c) => (c && !isErr(c) && typeof c.v === 'number' && isFinite(c.v) ? c.v : null);
const clean = (s) => String(s || '').toUpperCase().replace(/\s*\((OLD|1ST EMPLOYED|[^)]*EMPLOYED[^)]*)\)\s*$/i, '').replace(/\s+/g, ' ').trim();
const fmt = (x) => Number(x).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function readPayrollRows(sheets) {
  const ws = sheets[PAYROLL_SHEET];
  if (!ws) throw new Error(`Sheet “${PAYROLL_SHEET}” was not found in this file.`);
  const rows = [];
  for (let r = 10; r <= 5000; r++) {
    const name = cell(ws, `U${r}`)?.v; const mo = num(cell(ws, `O${r}`));
    if (!name || !mo) { if (r > 1500) break; continue; }
    const row = { row: r, name: clean(name), period: periodOf(excelSerialToIso(mo)), c: {}, errors: [] };
    for (const col of READ.slice(2)) {
      const c = cell(ws, `${col}${r}`);
      if (isErr(c)) row.errors.push(col);
      row.c[col] = col === 'LR' ? (c?.v ?? null) : num(c);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * people: same shape as payroll.buildRun D.people (employments → assignments)
 * types: Map(code → payment type)
 * Returns { months:[{period, lines, totals}], issues, summary }
 */
export function buildPayHistory(sheets, people, types, { fromPeriod = '2026-01-01', tables = null } = {}) {
  const rows = readPayrollRows(sheets);
  const byName = new Map();
  for (const p of people) { const k = clean(p.full_name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(p); }
  const issues = []; const unmatched = new Map(); const errorRows = new Map();
  const lines = []; const early = new Map(); const seenKeys = new Set();

  for (const r of rows) {
    if (r.period < fromPeriod) { early.set(r.period, (early.get(r.period) || 0) + 1); continue; }
    const c = r.c;
    if (r.errors.includes('NN') || c.NN === null) { errorRows.set(r.period, (errorRows.get(r.period) || 0) + 1); continue; }
    const list = byName.get(r.name);
    const p = list && list.length === 1 ? list[0] : null;
    if (!p) { unmatched.set(r.name, (unmatched.get(r.name) || 0) + 1); continue; }

    // the company that employed them that month (primary first)
    let pick = null;
    for (const em of p.employments || []) for (const a of em.assignments || []) {
      if (!activeWindow(r.period, em, a)) continue;
      if (!pick || (a.is_primary && !pick.a.is_primary)) pick = { em, a };
    }
    const warnings = [];
    if (!pick) {
      const em = (p.employments || [])[0]; const a = em?.assignments?.find((x) => x.is_primary) || em?.assignments?.[0];
      if (a) pick = { em, a };
      warnings.push({ level: 'warn', text: 'Paid in a month outside their employment dates in the app.' });
    }

    const dupKey = `${p.id}|${pick?.a?.company_id ?? 0}|${r.period}`;
    if (seenKeys.has(dupKey)) { issues.push({ level: 'check', message: `${r.name}, ${monthLabel(r.period)}: a second row for the same company (row ${r.row}) was not imported. Add it by hand if both rows were paid.` }); continue; }
    seenKeys.add(dupKey);
    const items = [];
    const T = (code) => types.get(code);
    const basic = c.NH ?? r2((c.LL ?? 0) + (c.NB ?? 0));
    const hourly = String(c.LR || '').toUpperCase() === 'Y';
    if (T('BASIC')) items.push(itemFromType(T('BASIC'), { auto: false, amount: basic, qty: hourly ? c.LX : null, unit: hourly ? 'hours' : null, rate: c.LF,
      note: hourly ? `${c.LX ?? 0} h × RM${fmt(c.LF ?? 0)} (workbook)` : (c.NB ? `RM${fmt(c.LF ?? 0)} less RM${fmt(-c.NB)} for days not employed (workbook)` : null) }));
    for (const [col, code] of ITEM_COLS) if (c[col] && T(code)) items.push(itemFromType(T(code), { auto: false, amount: c[col] }));
    if (c.RP && T('UNPAID_LEAVE')) items.push(itemFromType(T('UNPAID_LEAVE'), { auto: false, amount: c.RP, qty: c.KT, unit: 'days' }));
    for (const [col, code] of PERSONAL_COLS) if (c[col] && T(code)) items.push(itemFromType(T(code), { auto: false, amount: c[col] }));

    const overrides = {}; for (const [k, col] of Object.entries(STAT_COLS)) overrides[k] = r2(c[col] ?? 0);
    // the workbook keeps one employee SOCSO figure; split it into invalidity + NEI using the table for that month
    if (tables) {
      const sp = splitSocsoTotal(tables, { wage: c.SQ ?? c.NN, periodDate: r.period, total: overrides.socso_ee });
      overrides.socso_ee_nei = sp.nei ?? 0;
      if (!sp.matched) warnings.push({ level: 'warn', text: `Employee SOCSO RM${fmt(overrides.socso_ee)} matches no SOCSO table row, so it could not be split into invalidity and NEI; all of it is shown as invalidity.` });
    }
    const line = {
      employee_id: p.id, assignment_id: pick?.a?.id ?? null, company_id: pick?.a?.company_id ?? null,
      emp_name: p.full_name, emp_code: p.emp_id || null, mode: 'fixed', excluded: false, items, overrides,
      pcb: r2(c.VB ?? 0), note: `Imported from ${PAYROLL_SHEET} row ${r.row}`,
      inputs: { workbook_row: r.row, basis: hourly ? 'hourly' : 'monthly', salary: c.LF, unpaid_days: c.KT || 0 },
      warnings, period: r.period, wb: { gross: c.NN, net: c.VH, net_paid: c.WL ?? c.VH },
    };
    Object.assign(line, computeLine(line, { period: r.period, flags: {} }));
    if (Math.abs(line.gross - c.NN) > 0.01) warnings.push({ level: 'warn', text: `Workbook gross RM${fmt(c.NN)}; the items add up to RM${fmt(line.gross)}.` });
    if (c.VH !== null && Math.abs(line.net - c.VH) > 0.01) warnings.push({ level: 'warn', text: `Workbook net RM${fmt(c.VH)}; recalculated RM${fmt(line.net)}.` });
    if (hourly && (c.LF ?? 0) >= 100) warnings.push({ level: 'warn', suspicious: true, text: `Marked hourly-paid at RM${fmt(c.LF)} an hour (${c.LX ?? 0} h = RM${fmt(basic)}). This looks like a monthly salary with the hourly flag set by mistake.` });
    lines.push(line);
  }

  // unusually large months for the same person
  const byEmp = new Map();
  for (const l of lines) { if (!byEmp.has(l.employee_id)) byEmp.set(l.employee_id, []); byEmp.get(l.employee_id).push(l); }
  for (const list of byEmp.values()) {
    const g = list.map((l) => l.gross).sort((a, b) => a - b); const med = g[Math.floor(g.length / 2)];
    for (const l of list) if (list.length >= 3 && l.gross > 5000 && l.gross > med * 3 && !l.warnings.some((w) => w.suspicious))
      l.warnings.push({ level: 'warn', suspicious: true, text: `Gross RM${fmt(l.gross)} is more than three times their usual month (RM${fmt(med)}).` });
  }
  for (const l of lines) if (l.warnings.some((w) => w.suspicious)) l.excluded = true;   // left out by default; HR can include

  const months = [...new Set(lines.map((l) => l.period))].sort().map((period) => {
    const ls = lines.filter((l) => l.period === period);
    return { period, lines: ls, totals: runTotals(ls) };
  });
  for (const [name, k] of unmatched) issues.push({ level: 'check', message: `${name}: ${k} month(s) of pay, but no employee with this name. Not imported.` });
  for (const [period, k] of [...errorRows].sort()) issues.push({ level: 'check', message: `${monthLabel(period)}: ${k} row(s) show a formula error (#VALUE!) in the workbook, so there are no figures to import.` });
  for (const [period, k] of [...early].sort()) issues.push({ level: 'info', message: `${monthLabel(period)}: ${k} row(s) are before ${monthLabel(fromPeriod)} and are not imported (year-to-date totals start in January).` });
  const skippedErr = [...errorRows.values()].reduce((s, x) => s + x, 0);
  return { months, issues, summary: { rows: rows.length, lines: lines.length, months: months.length, unmatched: unmatched.size, errorRows: skippedErr,
    suspicious: lines.filter((l) => l.excluded).length, mismatched: lines.filter((l) => l.warnings.some((w) => !w.suspicious)).length } };
}

/** Payload for eppd_import_pay_history (only the database fields). */
export function historyPayload(months) {
  const pick = (l) => ({ employee_id: l.employee_id, assignment_id: l.assignment_id, company_id: l.company_id, emp_name: l.emp_name, emp_code: l.emp_code,
    mode: 'fixed', excluded: !!l.excluded, items: l.items, overrides: l.overrides, inputs: l.inputs, warnings: l.warnings, note: l.note,
    gross: l.gross, epf_wage: l.epf_wage, socso_wage: l.socso_wage, eis_wage: l.eis_wage, ...Object.fromEntries(STAT_KEYS.map((k) => [k, l[k]])),
    socso_ee_nei: l.socso_ee_nei || 0, pcb: l.pcb, net: l.net, personal_deductions: l.personal_deductions, net_paid: l.net_paid });
  return { source: 'MEG-EPPD workbook', runs: months.map((m) => ({ period: m.period, totals: runTotals(m.lines), lines: m.lines.map(pick) })) };
}

/**
 * Compare a workbook line with what the engine calculates for the same person and month.
 * Returns [{ field, label, wb, app }] for every difference above 1 sen.
 */
export function compareLines(wb, app) {
  const out = [];
  const a = lineSummary(wb), b = lineSummary(app);
  const parts = [['basic', 'Basic'], ['overtime', 'Overtime'], ['other', 'Allowances & others'], ['unpaid', 'Unpaid leave']];
  for (const [k, label] of parts) if (Math.abs(a[k] - b[k]) > 0.01) out.push({ field: k, label, wb: a[k], app: b[k] });
  for (const [k, label] of [['gross', 'Gross'], ['epf_ee', 'EPF'], ['socso_ee', 'SOCSO'], ['socso_ee_nei', 'SOCSO NEI'], ['eis_ee', 'EIS'], ['epf_er', 'EPF (employer)'], ['socso_er', 'SOCSO (employer)'], ['eis_er', 'EIS (employer)']])
    if (Math.abs((Number(wb[k]) || 0) - (Number(app[k]) || 0)) > 0.01) out.push({ field: k, label, wb: r2(wb[k]), app: r2(app[k]) });
  return out;
}

const ENGINE_CODES = new Set(['BASIC', 'UNPAID_LEAVE', 'OT_NORMAL', 'OT_RESTDAY', 'OT_PH']);
/**
 * Run the engine for an imported month and compare line by line.
 * One-off items (bonus, commission, MVC, A1–A3, buy-back …) are copied from the workbook so that only the
 * rules the engine applies (basic, part month, unpaid leave, overtime, recurring allowances, statutory) are compared.
 * D = buildRun context for the month (without `existing`). Returns [{ line, app, diffs }].
 */
export function compareMonth(month, D) {
  const run = buildRun({ ...D, period: month.period, existing: [], prevLines: [] });
  const byKey = new Map(run.lines.map((l) => [`${l.employee_id}|${l.company_id || 0}`, l]));
  return month.lines.map((wb) => {
    let app = byKey.get(`${wb.employee_id}|${wb.company_id || 0}`) || null;
    if (app) {
      const recurring = new Set(app.items.filter((i) => i.auto).map((i) => i.code));
      const extra = wb.items.filter((i) => !ENGINE_CODES.has(i.code) && !recurring.has(i.code)).map((i) => ({ ...i, auto: false }));
      app = recomputeLine({ ...app, items: [...app.items, ...extra], pcb: wb.pcb }, { ...D, period: month.period });
    }
    return { line: wb, app, diffs: app ? compareLines(wb, app) : [{ field: 'missing', label: 'Not employed this month in the app', wb: wb.gross, app: 0 }] };
  });
}
