// MyPayroll-System-V2.0 · engines/reports.js — payslips, monthly summary, payment & statutory lists, YTD, EA form
// Pure functions only (no DOM, no Supabase). Works on FINALISED pay lines.
//
// line = an eppd_pay_lines row (+ period) as saved by the payroll: items[], epf_ee … net_paid.

import { itemAmount, r2 } from './payroll.js';

const ORDER = ['BASIC', 'ALLOW_A1', 'ALLOW_A2', 'ALLOW_A3', 'LEADER', 'FIRST_AID', 'SKM1', 'SKM2', 'TRANSPORT', 'MVC', 'COMMISSION', 'INCENTIVE',
  'FULL_ATT', 'REFERRAL', 'BONUS', 'ANG_BAO', 'AL_BUYBACK', 'OT_NORMAL', 'OT_RESTDAY', 'OT_PH', 'UNPAID_LEAVE', 'CHILDCARE', 'LOAN', 'OTHER_DED'];
const orderOf = (code, sortOrder) => { const i = ORDER.indexOf(code); return i >= 0 ? i : 100 + (sortOrder ?? 0); };
const isPersonal = (i) => i.kind === 'deduction' && i.category === 'personal';
export const STAT_SUM_KEYS = ['gross', 'epf_ee', 'epf_er', 'socso_ee', 'socso_er', 'eis_ee', 'eis_er', 'pcb', 'net', 'personal_deductions', 'reimbursements', 'net_paid'];

/** Lines that count: not left out. */
export const paidLines = (lines) => (lines || []).filter((l) => !l.excluded);

/** Sum a set of lines. */
export function sumLines(lines) {
  const t = Object.fromEntries(STAT_SUM_KEYS.map((k) => [k, 0])); t.lines = 0;
  for (const l of paidLines(lines)) { t.lines += 1; for (const k of STAT_SUM_KEYS) t[k] = r2(t[k] + (Number(l[k]) || 0)); }
  t.employer_cost = r2(t.gross + t.epf_er + t.socso_er + t.eis_er);
  return t;
}

/** Items of a line grouped for a payslip, same-label items added together (e.g. two OT lines of one type stay separate by label). */
export function payslipSections(line) {
  const earn = new Map(), ded = new Map(), pers = new Map(), claims = new Map();
  for (const i of line.items || []) {
    const a = itemAmount(i); if (!a) continue;
    const target = i.category === 'reimbursement' ? claims : i.kind === 'earning' ? earn : isPersonal(i) ? pers : ded;
    const key = i.label || i.code;
    const prev = target.get(key);
    target.set(key, { label: key, code: i.code, amount: r2((prev?.amount || 0) + a), note: prev ? null : (i.note || null), order: orderOf(i.code) });
  }
  const sort = (m) => [...m.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  return { earnings: sort(earn), deductions: sort(ded), personal: sort(pers), claims: sort(claims) };
}

/**
 * Everything printed on one payslip.
 * ytdLines = this person's lines with the same company from January up to and including this month.
 */
export function payslipModel(line, ytdLines = []) {
  const s = payslipSections(line);
  const statutory = [
    { label: 'EPF (KWSP)', ee: r2(line.epf_ee), er: r2(line.epf_er) },
    { label: 'SOCSO (PERKESO)', ee: r2(line.socso_ee), er: r2(line.socso_er) },
    { label: 'EIS (SIP)', ee: r2(line.eis_ee), er: r2(line.eis_er) },
  ];
  const statEe = r2(statutory.reduce((x, r) => x + r.ee, 0));
  const statEr = r2(statutory.reduce((x, r) => x + r.er, 0));
  const totalDeductions = r2(statEe + Number(line.pcb || 0) + Number(line.personal_deductions || 0));
  return { ...s, statutory, statEe, statEr, pcb: r2(line.pcb), gross: r2(line.gross), totalDeductions, net: r2(line.net), netPaid: r2(line.net_paid),
    claimsTotal: r2(s.claims.reduce((x, c) => x + c.amount, 0)),
    ytd: sumLines(ytdLines) };
}

/**
 * Monthly summary columns: one per payment type that appears in the month (in the workbook's order),
 * then the statutory and pay columns.
 */
export function summaryColumns(lines, typesByCode = new Map()) {
  const seen = new Map();
  for (const l of paidLines(lines)) for (const i of l.items || []) if (itemAmount(i)) seen.set(i.code, { code: i.code, label: typesByCode.get(i.code)?.name || i.label || i.code, kind: i.kind, category: i.category });
  return [...seen.values()].sort((a, b) => orderOf(a.code, typesByCode.get(a.code)?.sort_order) - orderOf(b.code, typesByCode.get(b.code)?.sort_order));
}
export function itemsByCode(line) {
  const m = {};
  for (const i of line.items || []) m[i.code] = r2((m[i.code] || 0) + itemAmount(i));
  return m;
}

// ------------------------------------------------------------------ EA form (C.P.8A)
/**
 * Where an item goes on the EA form.
 *  1a: gross salary, wages or leave pay (incl. overtime) — basic, overtime, leave pay (AL buy-back), less unpaid leave
 *  1b: fees, commission or bonus
 *  1c: gross tips, perquisites, awards or other allowances
 *  F : tax-exempt allowances / perquisites (payment types with "subject to PCB" switched off)
 *  null: not on the EA form (personal deductions)
 */
export function eaSection(i) {
  if (isPersonal(i) || i.category === 'reimbursement') return null;   // claims are reimbursements, not income
  if (i.kind === 'earning' && i.category === 'compensation') return '6';  // payment in lieu of notice: compensation for loss of employment
  if (i.kind === 'earning' && i.pcb_subject === false) return 'F';
  if (['basic', 'overtime', 'leave'].includes(i.category)) return '1a';
  if (['incentive', 'bonus'].includes(i.category)) return '1b';
  if (i.kind === 'deduction') return '1a';
  return '1c';
}

/**
 * EA figures for each employee per paying company for a year.
 * lines: finalised lines of that year (with employee_id, company_id).
 * Returns [{ employee_id, company_id, months, b1a, b1b, b1c, totalB, d1_pcb, e1_epf, e2_perkeso, f_exempt, gross, firstPeriod, lastPeriod }]
 */
export function eaFigures(lines) {
  const by = new Map();
  for (const l of paidLines(lines)) {
    const key = `${l.employee_id}|${l.company_id || 0}`;
    const t = by.get(key) || { employee_id: l.employee_id, company_id: l.company_id || null, emp_name: l.emp_name, emp_code: l.emp_code,
      months: 0, b1a: 0, b1b: 0, b1c: 0, b6: 0, f_exempt: 0, d1_pcb: 0, e1_epf: 0, e2_perkeso: 0, gross: 0, firstPeriod: l.period, lastPeriod: l.period };
    t.months += 1; t.emp_name = l.emp_name || t.emp_name; t.emp_code = l.emp_code || t.emp_code;
    if (l.period < t.firstPeriod) t.firstPeriod = l.period;
    if (l.period > t.lastPeriod) t.lastPeriod = l.period;
    for (const i of l.items || []) {
      const sec = eaSection(i); if (!sec) continue;
      const a = itemAmount(i) * (i.kind === 'deduction' ? -1 : 1);
      if (sec === '1a') t.b1a += a; else if (sec === '1b') t.b1b += a; else if (sec === '1c') t.b1c += a; else if (sec === '6') t.b6 += a; else if (sec === 'F') t.f_exempt += a;
    }
    t.d1_pcb += Number(l.pcb) || 0; t.e1_epf += Number(l.epf_ee) || 0; t.e2_perkeso += (Number(l.socso_ee) || 0) + (Number(l.eis_ee) || 0);
    t.gross += Number(l.gross) || 0;
    by.set(key, t);
  }
  return [...by.values()].map((t) => {
    for (const k of ['b1a', 'b1b', 'b1c', 'b6', 'f_exempt', 'd1_pcb', 'e1_epf', 'e2_perkeso', 'gross']) t[k] = r2(t[k]);
    t.totalB = r2(t.b1a + t.b1b + t.b1c + t.b6);
    // a check: everything taxable on the form + exempt = gross pay
    t.balanced = Math.abs(r2(t.totalB + t.f_exempt) - t.gross) < 0.01;
    return t;
  }).sort((a, b) => String(a.emp_name).localeCompare(String(b.emp_name)));
}

/** Year-to-date per employee per company. */
export function ytdRows(lines) {
  const by = new Map();
  for (const l of paidLines(lines)) {
    const key = `${l.employee_id}|${l.company_id || 0}`;
    if (!by.has(key)) by.set(key, { employee_id: l.employee_id, company_id: l.company_id || null, emp_name: l.emp_name, emp_code: l.emp_code, lines: [] });
    by.get(key).lines.push(l);
  }
  return [...by.values()].map((g) => ({ ...g, months: g.lines.length, ...sumLines(g.lines) })).sort((a, b) => String(a.emp_name).localeCompare(String(b.emp_name)));
}

/** SOCSO number: the one on record, else the NRIC digits (as PERKESO uses). */
export const socsoNo = (priv) => priv?.socso_no || (priv?.nric ? String(priv.nric).replace(/\D/g, '') : '') || '';
