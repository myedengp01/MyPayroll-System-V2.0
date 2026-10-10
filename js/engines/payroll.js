// MyPayroll-System-V2.0 · engines/payroll.js — the monthly payroll calculation
// Pure functions only (no DOM, no Supabase) so they can be tested in Node.
//
// A pay LINE = one employee paid by one company for one month.
// Each line holds ITEMS (earnings and deductions). Auto items are rebuilt from the
// app's data every time the run is recalculated; manual items, PCB, overrides,
// exclusions and notes typed by HR are kept.

import { computeEPF, computeSOCSO, computeEIS, statutoryBases, splitSocsoTotal } from './statutory.js';
import { salaryForMonth, allowancesForMonth, lastDayOfMonth, isoToMs, addDays } from './employee.js';
import { normalHours, OT_CATEGORIES } from './ot.js';
import { computePCB, taxablePay, pcbYtd, pcbPolicy } from './pcb.js';

export const r2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const DAY = 86400000;
const n = (x) => (x === null || x === undefined || x === '' ? null : Number(x));

export const DEFAULT_PAYROLL = {
  daily_rate_divisor: 26, default_normal_hours: 8, pcb_carry_forward: true,
  rates: { OT_NORMAL: 1.5, OT_OFFDAY: 1.5, RD_HALF: 0.5, RD_FULL: 1, RD_EXCESS: 2, PH_NORMAL: 2, PH_EXCESS: 3 },
};
export const STAT_KEYS = ['epf_ee', 'epf_er', 'socso_ee', 'socso_er', 'eis_ee', 'eis_er'];
/** The statutory columns shown everywhere, each share on its own (SOCSO employee split into invalidity + NEI). */
export const STAT_COLS = [['epf_ee', 'EPF ee'], ['epf_er', 'EPF er'], ['socso_ee_inv', 'SOCSO ee Inv.'], ['socso_ee_nei', 'SOCSO ee NEI'],
  ['socso_er', 'SOCSO er'], ['eis_ee', 'EIS ee'], ['eis_er', 'EIS er']];
export const STAT_COLS_EE = STAT_COLS.filter(([k]) => !k.endsWith('_er'));
export const STAT_LEGEND = 'ee = employee share · er = employer share · Inv. = SOCSO invalidity · NEI = SOCSO non-employment injury';
/** Value of a STAT_COLS key on a line or a totals object. */
export const statVal = (x, k) => (k === 'socso_ee_inv' ? r2((Number(x?.socso_ee) || 0) - (Number(x?.socso_ee_nei) || 0)) : r2(Number(x?.[k]) || 0));
export const STAT_LABELS = { epf_ee: 'EPF (employee)', epf_er: 'EPF (employer)', socso_ee: 'SOCSO (employee)', socso_ee_inv: 'SOCSO – Invalidity (employee)', socso_ee_nei: 'SOCSO – NEI (employee)', socso_er: 'SOCSO (employer)', eis_ee: 'EIS (employee)', eis_er: 'EIS (employer)' };

export const policyOf = (policies) => {
  const p = policies?.payroll || {};
  return { ...DEFAULT_PAYROLL, ...p, rates: { ...DEFAULT_PAYROLL.rates, ...(p.rates || {}) } };
};

export const periodOf = (iso) => String(iso).slice(0, 7) + '-01';
export const daysInMonth = (period) => Number(lastDayOfMonth(period).slice(8, 10));
export const monthLabel = (period) => new Date(periodOf(period) + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
export const prevPeriod = (period) => periodOf(addDays(periodOf(period), -1));
const daysBetween = (a, b) => Math.round((isoToMs(b) - isoToMs(a)) / DAY) + 1;

/**
 * Days of the month the person was employed by this company:
 * from max(month start, join date, assignment start) to min(month end, last day, assignment end).
 * Returns null when the person was not employed at all that month.
 */
export function activeWindow(period, employment, assignment) {
  const start = periodOf(period), end = lastDayOfMonth(period);
  const from = [start, employment?.join_date, assignment?.start_date].filter(Boolean).sort().pop();
  const to = [end, employment?.resigned_date, assignment?.end_date].filter(Boolean).sort()[0];
  if (from > to) return null;
  const cal = daysInMonth(period);
  return { from, to, days: daysBetween(from, to), calDays: cal, full: from === start && to === end };
}

/**
 * Age used for the statutory tables: age on the last day of the PREVIOUS month,
 * so the age-60 rates start the month after the 60th birthday (EPF rule).
 */
export function ageForPeriod(dob, period) {
  if (!dob) return null;
  const on = addDays(periodOf(period), -1);
  const [y1, m1, d1] = dob.split('-').map(Number); const [y2, m2, d2] = on.split('-').map(Number);
  let a = y2 - y1; if (m2 < m1 || (m2 === m1 && d2 < d1)) a -= 1;
  return a;
}

/** Daily (ORP) and hourly (HRP) rates of pay, Employment Act style. */
export function ratesOfPay(salary, employment, pol = DEFAULT_PAYROLL) {
  const normal = normalHours(employment, pol.default_normal_hours || 8);
  if (!salary) return { basis: null, full: 0, orp: 0, hrp: 0, normal };
  const amt = Number(salary.amount) || 0;
  if (salary.pay_basis === 'hourly') return { basis: 'hourly', full: amt, hrp: amt, orp: r2(amt * normal), normal };
  const orp = amt / (pol.daily_rate_divisor || 26);
  return { basis: 'monthly', full: amt, orp, hrp: orp / normal, normal };
}

/** Item from a payment type row. */
export function itemFromType(type, fields) {
  return {
    code: type.code, label: fields.label || type.name, kind: type.kind, category: type.category,
    epf: !!type.subject_epf, socso: !!type.subject_socso, eis: !!type.subject_eis, pcb_subject: type.subject_pcb !== false,
    amount: r2(fields.amount || 0), qty: fields.qty ?? null, rate: fields.rate ?? null, unit: fields.unit || null,
    auto: fields.auto !== false, key: fields.key || null, note: fields.note || null, override: fields.override ?? null,
  };
}
export const itemAmount = (i) => Number(i.override ?? i.amount) || 0;

const fmt = (x, d = 2) => Number(x).toLocaleString('en-MY', { minimumFractionDigits: d, maximumFractionDigits: d });

/**
 * Build the automatic items for one line.
 * ctx = { period, employment, assignment, salary, allowances, time, unpaidDays, buybacks, types (Map code->type or id->type), policy, primary }
 *  - time / unpaidDays / buybacks are only given to the person's primary line.
 */
export function buildAutoItems(ctx) {
  const { period, employment, assignment, allowances = [], time = [], unpaidDays = 0, buybacks = [], primary = true } = ctx;
  const pol = ctx.policy || DEFAULT_PAYROLL;
  const T = (code) => ctx.types.get(code);
  const items = []; const warnings = [];
  const salary = ctx.salary;
  const win = ctx.window || activeWindow(period, employment, assignment);
  const R = ratesOfPay(salary, employment, pol);
  const add = (code, f) => { const t = T(code); if (!t) { warnings.push({ level: 'warn', text: `Payment type ${code} is missing; ${f.label || code} was left out.` }); return; } items.push(itemFromType(t, f)); };

  if (!salary) warnings.push({ level: 'warn', text: 'No salary on record for this month. Add one in the Pay tab, or type the basic pay here.' });

  // ---- basic pay ----
  if (salary && R.basis === 'monthly') {
    if (win && !win.full) {
      const unpaid = win.calDays - win.days;
      const amt = R.full - (R.full / win.calDays) * unpaid;
      const ranges = (win.ranges || [[win.from, win.to]]).map(([f, t]) => `${f.slice(8)}–${t.slice(8)}`).join(', ');
      add('BASIC', { key: 'BASIC', amount: amt, qty: win.days, unit: 'days', rate: R.full,
        note: `${win.days} of ${win.calDays} days (${ranges}); RM${fmt(R.full)} ÷ ${win.calDays} × ${win.days}` });
    } else add('BASIC', { key: 'BASIC', amount: R.full, rate: R.full, note: null });
  } else if (salary && R.basis === 'hourly') {
    const hrs = r2(time.filter((e) => e.category === 'PT_HOURS').reduce((s, e) => s + Number(e.hours || 0), 0));
    add('BASIC', { key: 'BASIC', amount: R.hrp * hrs, qty: hrs, unit: 'hours', rate: R.hrp, note: `${fmt(hrs)} h × RM${fmt(R.hrp)}` });
    if (!hrs && primary) warnings.push({ level: 'warn', text: 'Hourly-paid, but no part-time hours recorded this month (Time & leave › Overtime & hours).' });
  }

  // ---- unpaid leave (monthly-paid; calendar-day rate, as the workbook) ----
  if (unpaidDays > 0) {
    if (R.basis === 'monthly') add('UNPAID_LEAVE', { key: 'UPL', amount: (R.full / (win?.calDays || daysInMonth(period))) * unpaidDays, qty: unpaidDays, unit: 'days',
      rate: R.full / (win?.calDays || daysInMonth(period)), note: `${unpaidDays} day(s) × RM${fmt(R.full)} ÷ ${win?.calDays || daysInMonth(period)}` });
    else warnings.push({ level: 'info', text: `${unpaidDays} day(s) of unpaid leave recorded; hourly pay already excludes them.` });
  }

  // ---- overtime (Employment Act rates) ----
  const cat = (c) => time.filter((e) => e.category === c && Number(e.hours) > 0);
  const hrs = (list) => r2(list.reduce((s, e) => s + Number(e.hours || 0), 0));
  const rates = pol.rates;
  const otMult = n(employment?.ot_multiplier) ?? rates.OT_NORMAL;
  if (R.hrp > 0) {
    const otN = cat('OT_NORMAL'), otO = cat('OT_OFFDAY');
    if (otN.length) add('OT_NORMAL', { key: 'OT:OT_NORMAL', label: 'Overtime (normal day)', amount: hrs(otN) * R.hrp * otMult, qty: hrs(otN), unit: 'hours', rate: R.hrp * otMult, note: `${fmt(hrs(otN))} h × RM${fmt(R.hrp)} × ${otMult}` });
    if (otO.length) add('OT_NORMAL', { key: 'OT:OT_OFFDAY', label: 'Overtime (off day)', amount: hrs(otO) * R.hrp * rates.OT_OFFDAY, qty: hrs(otO), unit: 'hours', rate: R.hrp * rates.OT_OFFDAY, note: `${fmt(hrs(otO))} h × RM${fmt(R.hrp)} × ${rates.OT_OFFDAY}` });
    const rdH = cat('RD_HALF'), rdF = cat('RD_FULL'), rdX = cat('RD_EXCESS');
    if (rdH.length) add('OT_RESTDAY', { key: 'OT:RD_HALF', label: 'Rest day (up to half a day)', amount: rdH.length * R.orp * rates.RD_HALF, qty: rdH.length, unit: 'days', rate: R.orp * rates.RD_HALF, note: `${rdH.length} day(s) × half a day's pay (RM${fmt(R.orp)} ÷ 2)` });
    if (rdF.length) add('OT_RESTDAY', { key: 'OT:RD_FULL', label: 'Rest day (more than half a day)', amount: rdF.length * R.orp * rates.RD_FULL, qty: rdF.length, unit: 'days', rate: R.orp * rates.RD_FULL, note: `${rdF.length} day(s) × one day's pay (RM${fmt(R.orp)})` });
    if (rdX.length) add('OT_RESTDAY', { key: 'OT:RD_EXCESS', label: 'Rest day (beyond normal hours)', amount: hrs(rdX) * R.hrp * rates.RD_EXCESS, qty: hrs(rdX), unit: 'hours', rate: R.hrp * rates.RD_EXCESS, note: `${fmt(hrs(rdX))} h × RM${fmt(R.hrp)} × ${rates.RD_EXCESS}` });
    const phN = cat('PH_NORMAL'), phX = cat('PH_EXCESS');
    if (phN.length) add('OT_PH', { key: 'OT:PH_NORMAL', label: 'Public holiday (normal hours)', amount: phN.length * R.orp * rates.PH_NORMAL, qty: phN.length, unit: 'days', rate: R.orp * rates.PH_NORMAL, note: `${phN.length} day(s) × two days' pay (RM${fmt(R.orp)} × 2)` });
    if (phX.length) add('OT_PH', { key: 'OT:PH_EXCESS', label: 'Public holiday (beyond normal hours)', amount: hrs(phX) * R.hrp * rates.PH_EXCESS, qty: hrs(phX), unit: 'hours', rate: R.hrp * rates.PH_EXCESS, note: `${fmt(hrs(phX))} h × RM${fmt(R.hrp)} × ${rates.PH_EXCESS}` });
    // the workbook's "Err" checks, as warnings
    const half = R.normal / 2;
    for (const e of rdH) if (Number(e.hours) > half + 1e-9) warnings.push({ level: 'warn', text: `Rest day ${e.work_date}: ${e.hours} h is more than half a day (${half} h). Should it be "more than half a day"?` });
    for (const e of rdF) if (Number(e.hours) > R.normal + 1e-9) warnings.push({ level: 'warn', text: `Rest day ${e.work_date}: ${e.hours} h is more than a normal day (${R.normal} h). Record the extra hours as "beyond normal hours".` });
    for (const e of phN) if (Number(e.hours) > R.normal + 1e-9) warnings.push({ level: 'warn', text: `Public holiday ${e.work_date}: ${e.hours} h is more than a normal day (${R.normal} h). Record the extra hours as "beyond normal hours".` });
  } else if (time.some((e) => e.category !== 'PT_HOURS' && Number(e.hours) > 0)) {
    warnings.push({ level: 'warn', text: 'Overtime recorded, but there is no salary to work out the rate.' });
  }

  // ---- recurring allowances and personal deductions for this company ----
  for (const a of allowancesForMonth(allowances, period)) {
    const t = ctx.typesById?.get(a.payment_type_id); if (!t) continue;
    items.push(itemFromType(t, { key: `ALLOW:${a.id}`, amount: Number(a.amount) || 0, note: a.note || null }));
  }

  // ---- AL buy-back decided at year-end close, paid in January ----
  for (const b of buybacks) {
    const amt = Number(b.days) * R.orp * Number(b.buyback_pct || 100) / 100;
    add('AL_BUYBACK', { key: `BUYBACK:${b.id}`, amount: amt, qty: Number(b.days), unit: 'days', rate: R.orp * Number(b.buyback_pct || 100) / 100,
      note: `${b.days} day(s) × RM${fmt(R.orp)} × ${b.buyback_pct || 100}% (${b.close_year} year-end close)` });
  }

  // ---- Phase 6: MEG-FORMS claims (paid on top of net pay) ----
  for (const c of ctx.claims || []) {
    const code = c.form_code === 'mtcf' ? 'CLAIM_MTCF' : 'CLAIM_SCF';
    add(code, { key: `CLAIM:${c.id}`, label: `${T(code)?.name || code}${c.serial_no ? ` ${c.serial_no}` : ''}`, amount: Number(c.amount) || 0,
      note: [c.claim_date ? `claim of ${c.claim_date}` : null, c.note].filter(Boolean).join(' · ') || null });
  }
  // ---- zakat through payroll ----
  if (ctx.zakat > 0) add('ZAKAT', { key: 'ZAKAT', amount: ctx.zakat, note: 'Monthly zakat (tax details); reduces PCB' });
  // ---- company loans ----
  for (const ln of ctx.loans || []) {
    const out = Math.max(0, r2(Number(ln.principal) - Number(ln.repaid || 0)));
    if (!(out > 0)) continue;
    const all = !!ctx.settlement?.recover_loans;
    const amt = all ? out : Math.min(Number(ln.monthly_instalment), out);
    add('LOAN', { key: `LOAN:${ln.id}`, label: `Company loan${ln.description ? ` – ${ln.description}` : ''}`, amount: amt,
      note: `${all ? 'Final settlement: full balance' : 'Instalment'} · balance after this month RM${fmt(r2(out - amt))}` });
  }
  // ---- final settlement ----
  const st = ctx.settlement;
  if (st) {
    const alMode = st.al_mode || 'auto';
    let days = null, amount = null;
    if (alMode === 'auto' && st.al_balance !== null && st.al_balance !== undefined) { days = r2(st.al_balance); amount = r2(days * R.orp); }
    if (alMode === 'custom') { days = st.al_days !== null && st.al_days !== undefined && st.al_days !== '' ? Number(st.al_days) : null; amount = st.al_amount !== null && st.al_amount !== undefined && st.al_amount !== '' ? Number(st.al_amount) : (days !== null ? r2(days * R.orp) : null); }
    if (amount && amount > 0) add('AL_ENCASH', { key: 'SETTLE:AL', amount, qty: days, unit: 'days', rate: R.orp, note: `${days ?? '—'} unused day(s) × RM${fmt(R.orp)} (final settlement)` });
    if (amount && amount < 0) add('UNPAID_LEAVE', { key: 'SETTLE:AL', label: 'Annual leave taken in advance', amount: -amount, qty: days === null ? null : -days, unit: 'days', rate: R.orp,
      note: `${days === null ? '' : `${-days} day(s) `}more than earned × RM${fmt(R.orp)} (final settlement)` });
    if (alMode === 'auto' && (st.al_balance === null || st.al_balance === undefined)) warnings.push({ level: 'warn', text: 'Final settlement: annual leave balance not available; check the leave records.' });
    const nd = st.notice_days !== null && st.notice_days !== undefined && st.notice_days !== '' ? Number(st.notice_days) : null;
    const na = st.notice_amount !== null && st.notice_amount !== undefined && st.notice_amount !== '' ? Number(st.notice_amount) : (nd !== null ? r2(nd * R.orp) : null);
    if (st.notice_mode === 'employer_pays' && na > 0) add('NOTICE_PAY', { key: 'SETTLE:NOTICE', amount: na, qty: nd, unit: 'days', rate: R.orp, note: `${nd ?? '—'} day(s) of notice paid in lieu` });
    if (st.notice_mode === 'employee_pays' && na > 0) add('NOTICE_SHORT', { key: 'SETTLE:NOTICE', amount: na, qty: nd, unit: 'days', rate: R.orp, note: `${nd ?? '—'} day(s) of notice not served` });
  }

  const inputs = {
    basis: R.basis, salary: R.full, orp: r2(R.orp), hrp: r2(R.hrp), normal_hours: R.normal,
    window: win ? { from: win.from, to: win.to, days: win.days, cal_days: win.calDays } : null,
    unpaid_days: unpaidDays || 0,
  };
  return { items, inputs, warnings };
}

/**
 * Totals for one line.
 * line = { items, overrides:{epf_ee..}, pcb, mode }
 * stat = { age, statClass, period, flags:{epf_ee,epf_er,socso_ee,socso_er,eis_ee,eis_er,socso_nei_opt_out}, tables, rules }
 */
export function computeLine(line, stat) {
  const items = line.items || [];
  const isPersonal = (i) => i.kind === 'deduction' && i.category === 'personal';
  let earnings = 0, statDed = 0, personal = 0, reimb = 0;
  for (const i of items) {
    const a = itemAmount(i);
    if (i.category === 'reimbursement') reimb += a;
    else if (i.kind === 'earning') earnings += a; else if (isPersonal(i)) personal += a; else statDed += a;
  }
  const gross = r2(earnings - statDed);
  const bases = statutoryBases(items.filter((i) => !isPersonal(i) && i.category !== 'reimbursement').map((i) => ({ amount: itemAmount(i), type: { kind: i.kind, subject_epf: i.epf, subject_socso: i.socso, subject_eis: i.eis } })));
  const out = { gross, epf_wage: bases.epf, socso_wage: bases.socso, eis_wage: bases.eis, warnings: [] };
  const fl = stat.flags || {};
  let neiTable = 0;
  if (stat.tables && line.mode !== 'fixed') {
    const args = { age: stat.age ?? 0, statClass: stat.statClass || 'MY', periodDate: stat.period };
    const epf = computeEPF(stat.tables, { ...args, wage: bases.epf });
    const socso = computeSOCSO(stat.tables, { ...args, wage: bases.socso, neiOptOut: !!fl.socso_nei_opt_out });
    const eis = computeEIS(stat.tables, { ...args, wage: bases.eis }, stat.rules || {});
    for (const [k, r] of [['EPF', epf], ['SOCSO', socso], ['EIS', eis]]) if (r.missing) out.warnings.push({ level: 'warn', text: `No ${k} table in force for this month (Settings › Statutory tables).` });
    Object.assign(out, { epf_ee: epf.ee, epf_er: epf.er, socso_ee: socso.ee, socso_er: socso.er, eis_ee: eis.ee, eis_er: eis.er });
    neiTable = socso.nei || 0;
    for (const k of STAT_KEYS) if (fl[k] === false) out[k] = 0;
    if (fl.socso_ee === false) neiTable = 0;
  } else for (const k of STAT_KEYS) out[k] = 0;
  const ov = line.overrides || {};
  const has = (v) => v !== null && v !== undefined && v !== '';
  const socsoTable = out.socso_ee;
  for (const k of STAT_KEYS) if (has(ov[k])) out[k] = Number(ov[k]);
  // SOCSO employee share = invalidity + non-employment injury (NEI)
  let nei;
  if (has(ov.socso_ee)) {
    // a recorded total (imported months, or typed before the split): use the recorded split, else work it out
    if (has(ov.socso_ee_nei)) nei = Number(ov.socso_ee_nei);
    else if (line.mode === 'fixed') nei = Number(line.socso_ee_nei) || 0;
    else if (Math.abs(out.socso_ee - socsoTable) < 0.005) nei = neiTable;
    else nei = stat.tables ? (splitSocsoTotal(stat.tables, { wage: bases.socso, periodDate: stat.period, total: out.socso_ee }).nei ?? Math.min(neiTable, out.socso_ee)) : 0;
  } else if (has(ov.socso_ee_inv) || has(ov.socso_ee_nei)) {
    const inv = has(ov.socso_ee_inv) ? Number(ov.socso_ee_inv) : r2(out.socso_ee - neiTable);
    nei = has(ov.socso_ee_nei) ? Number(ov.socso_ee_nei) : neiTable;
    out.socso_ee = r2(inv + nei);
  } else nei = neiTable;
  out.socso_ee_nei = r2(Math.max(0, Math.min(Number(nei) || 0, out.socso_ee)));
  for (const k of STAT_KEYS) out[k] = r2(out[k]);
  // PCB: typed for this month › automatic (LHDN method) › typed on the line
  const pc = line.inputs?.pcb;
  if (ov.pcb !== null && ov.pcb !== undefined && ov.pcb !== '') out.pcb = r2(Number(ov.pcb) || 0);
  else if (pc?.auto && line.mode !== 'fixed') {
    const t = taxablePay(items, pcbPolicy(stat.pcbPolicy), itemAmount);
    const zakat = items.filter((i) => i.code === 'ZAKAT').reduce((x, i) => x + itemAmount(i), 0);
    const res = computePCB({ month: Number(String(stat.period).slice(5, 7)), profile: pc.profile, ytd: pc.ytd, Y1: t.Y1, Yt: t.Yt,
      epfEe: out.epf_ee, epf1: t.epf1, epft: t.epft, socsoEis: out.socso_ee + out.eis_ee, zakat, policy: stat.pcbPolicy });
    out.pcb = res.pcb;
    out.inputs = { ...(line.inputs || {}), pcb: { ...pc, lp_socso: res.lpSocso, tp1: Number(pc.profile?.tp1_monthly) || 0,
      result: { normal: res.normal, additional: res.additional, gross_pcb: res.gross_pcb, P: res.P, detail: res.detail } } };
  } else out.pcb = r2(Number(line.pcb) || 0);
  out.net = r2(gross - out.epf_ee - out.socso_ee - out.eis_ee - out.pcb);
  out.personal_deductions = r2(personal);
  out.reimbursements = r2(reimb);
  out.net_paid = r2(out.net - personal + reimb);
  out.employer_cost = r2(gross + out.epf_er + out.socso_er + out.eis_er);
  if (out.net_paid < 0) out.warnings.push({ level: 'warn', text: 'Net pay is negative.' });
  return out;
}

/** Group items for display: earnings, statutory deductions (e.g. unpaid leave), personal deductions. */
export function groupItems(items) {
  const g = { earnings: [], deductions: [], personal: [], claims: [] };
  for (const i of items || []) {
    if (i.category === 'reimbursement') g.claims.push(i);
    else if (i.kind === 'earning') g.earnings.push(i);
    else if (i.category === 'personal') g.personal.push(i);
    else g.deductions.push(i);
  }
  return g;
}

/**
 * Build (or rebuild) every line of a month.
 * D = { period, people:[{id, full_name, emp_id, dob, statClass, employments:[{..., assignments:[{..., salary_history, allowances}]}]}],
 *       time:[{employee_id, category, hours, work_date}], leave:[{employee_id, leave_type, days, date_from, status}],
 *       buybacks:[{id, employee_id, days, buyback_pct, close_year}], prevLines:[{employee_id, company_id, pcb}],
 *       existing:[lines], types:Map(code), typesById:Map(id), tables, policies, companies:Map(id) }
 * Returns { lines, skipped:[{name, reason}] }.
 */
export function buildRun(D) {
  const pol = policyOf(D.policies);
  const rules = D.policies?.statutory_rules || {};
  const period = periodOf(D.period);
  const existing = new Map((D.existing || []).map((l) => [`${l.employee_id}|${l.company_id || 0}`, l]));
  const prevPcb = new Map((D.prevLines || []).filter((l) => !l.excluded && Number(l.pcb) > 0).map((l) => [`${l.employee_id}|${l.company_id || 0}`, Number(l.pcb)]));
  const lines = []; const skipped = []; const notices = []; const seen = new Set(); const paidPeople = new Set(); const noLastDay = new Set();
  const isJan = period.slice(5, 7) === '01';
  const statFor = (age, p, flags) => ({ age, statClass: p.statClass || 'MY', period, flags, tables: D.tables, rules, pcbPolicy: D.policies?.pcb });
  // Phase 6 optional modules
  const mods = D.policies?.modules || {};
  const claimsOn = !!mods.claims?.enabled; const loansOn = !!mods.loans; const settleOn = !!mods.settlement; const pcbAuto = !!mods.pcb_auto;
  const year = Number(period.slice(0, 4));

  for (const p of D.people) {
    // every employment period × company active in this month, oldest first
    const cands = [];
    for (const em of p.employments || []) {
      // marked Resigned / Terminated / Dismissed but no last working day: never paid by the app
      if (!em.resigned_date && D.confMeta?.[em.confirmation_status]?.is_active_employment === false) {
        if (activeWindow(period, em, {})) noLastDay.add(p.full_name);
        continue;
      }
      for (const a of em.assignments || []) { const win = activeWindow(period, em, a); if (win) cands.push({ em, a, win }); }
    }
    if (!cands.length) continue;
    cands.sort((x, y) => (x.em.join_date || '').localeCompare(y.em.join_date || '') || (x.win.from).localeCompare(y.win.from));
    // one line per company: two periods in the same month (rehire, or a new assignment) add their days together;
    // the later period's assignment decides salary and statutory switches
    const byCompany = new Map();
    for (const c of cands) {
      const g = byCompany.get(c.a.company_id);
      if (!g) byCompany.set(c.a.company_id, { em: c.em, a: c.a, wins: [c.win] });
      else { g.em = c.em; g.a = c.a; g.wins.push(c.win); }
    }
    const list = [...byCompany.values()];
    for (const g of list) {
      g.window = mergeWindows(g.wins);
      g.salary = salaryForMonth(g.a.salary_history || [], period);
    }
    // primary line = the latest employment's primary company; part-time hours go to an hourly-paid line
    const latest = cands[cands.length - 1].em;
    const primary = list.find((g) => g.em === latest && g.a.is_primary) || list.find((g) => g.a.is_primary) || list[0];
    const ptLine = primary.salary?.pay_basis === 'hourly' ? primary : (list.find((g) => g.salary?.pay_basis === 'hourly') || primary);
    const time = (D.time || []).filter((e) => e.employee_id === p.id && periodOf(e.work_date) === period);
    const unpaidDays = r2((D.leave || []).filter((r) => r.employee_id === p.id && r.leave_type === 'UPL' && r.status !== 'cancelled' && periodOf(r.date_from) === period)
      .reduce((s, r) => s + Number(r.days || 0), 0));
    const buybacks = isJan ? (D.buybacks || []).filter((b) => b.employee_id === p.id && Number(b.close_year) === Number(period.slice(0, 4)) - 1) : [];
    const age = ageForPeriod(p.dob, period);

    for (const g of list) {
      const key = `${p.id}|${g.a.company_id || 0}`; seen.add(key);
      const old = existing.get(key);
      const isPrimary = g === primary;
      const flags = { epf_ee: g.a.epf_ee !== false, epf_er: g.a.epf_er !== false, socso_ee: g.a.socso_ee !== false, socso_er: g.a.socso_er !== false,
                      eis_ee: g.a.eis_ee !== false, eis_er: g.a.eis_er !== false, socso_nei_opt_out: !!g.a.socso_nei_opt_out };
      let line;
      if (old && old.mode === 'fixed') {
        line = { ...old };
      } else {
        const myTime = time.filter((e) => (e.category === 'PT_HOURS' ? g === ptLine : isPrimary));
        const profile = D.taxProfiles?.get(p.id) || null;
        const myClaims = claimsOn && isPrimary ? (D.claims || []).filter((c) => c.employee_id === p.id && c.status !== 'cancelled' && periodOf(c.pay_period) === period
          && ((c.form_code === 'scf' && mods.claims.scf !== false) || (c.form_code === 'mtcf' && mods.claims.mtcf !== false))) : [];
        const myLoans = loansOn ? (D.loans || []).filter((ln) => ln.employee_id === p.id && ln.status === 'active' && periodOf(ln.start_period) <= period
          && ((ln.company_id && ln.company_id === g.a.company_id) || (!ln.company_id && isPrimary) || (ln.company_id && isPrimary && !list.some((x) => x.a.company_id === ln.company_id)))) : [];
        const leaving = settleOn && isPrimary && g.em.resigned_date && periodOf(g.em.resigned_date) === period;
        const settlement = leaving ? { al_mode: D.policies?.settlement?.al_mode_default || 'auto', notice_mode: 'none', recover_loans: true,
          ...(D.settlements?.get(g.em.id) || {}), al_balance: D.leaverAL?.get(p.id) ?? null } : null;
        const built = buildAutoItems({ period, employment: g.em, assignment: g.a, salary: g.salary, window: g.window, allowances: g.a.allowances || [],
          time: myTime, unpaidDays: isPrimary ? unpaidDays : 0, buybacks: isPrimary ? buybacks : [],
          claims: myClaims, loans: myLoans, settlement, zakat: pcbAuto && isPrimary && profile && !profile.pcb_manual ? Number(profile.zakat_monthly) || 0 : 0,
          types: D.types, typesById: D.typesById, policy: pol, primary: isPrimary || g === ptLine });
        // keep HR's overrides on auto items, and every manual item
        const oldAuto = new Map((old?.items || []).filter((i) => i.auto && i.key).map((i) => [i.key, i]));
        const items = built.items.map((i) => { const o = oldAuto.get(i.key); return o && o.override !== null && o.override !== undefined ? { ...i, override: o.override } : i; });
        for (const i of old?.items || []) if (!i.auto) items.push(i);
        const warnings = [...built.warnings];
        if (g.wins.length > 1) warnings.push({ level: 'info', text: `Two employment periods with this company in the month; the days are added together at the current salary. Check the basic pay.` });
        if (!p.dob) warnings.push({ level: 'info', text: 'No date of birth on record: statutory rates for under-60s used.' });
        const autoPcb = pcbAuto && !(profile && profile.pcb_manual);
        let pcb = old ? Number(old.pcb) || 0 : 0;
        if (!autoPcb && !old && pol.pcb_carry_forward && prevPcb.has(key)) {
          pcb = prevPcb.get(key);
          warnings.push({ level: 'info', text: `PCB RM${fmt(pcb)} copied from last month. Check it against the LHDN calculator.` });
        }
        line = {
          employee_id: p.id, assignment_id: g.a.id, company_id: g.a.company_id, emp_name: p.full_name, emp_code: p.emp_id || null,
          mode: 'auto', excluded: old?.excluded || false, items, overrides: old?.overrides || {}, note: old?.note || null, pcb,
          inputs: { ...built.inputs, age, stat_class: p.statClass || 'MY', flags, primary: isPrimary,
            ...(autoPcb ? { pcb: { auto: true, profile: profileSnapshot(profile),
              ytd: pcbYtd((D.yearLines || []).filter((l) => l.employee_id === p.id && (l.company_id || 0) === (g.a.company_id || 0) && l.period < period && l.period >= `${year}-01-01`),
                profile, year, itemAmount, D.policies?.pcb) } } : {}),
            ...(settlement ? { settlement: { al_balance: settlement.al_balance, al_mode: settlement.al_mode, notice_mode: settlement.notice_mode } } : {}) },
          warnings,
        };
        if (autoPcb && !profile) warnings.push({ level: 'info', text: 'Automatic PCB with default tax details (single, no children). Add their tax details in the Pay tab.' });
        if (pcbAuto && profile?.pcb_manual) warnings.push({ level: 'info', text: 'PCB typed by hand for this person (tax details: manual PCB).' });
      }
      const tot = computeLine(line, statFor(age, p, flags));
      Object.assign(line, tot, { warnings: [...(line.mode === 'fixed' ? (old.warnings || []).filter((w) => !w.calc) : line.warnings), ...tot.warnings.map((w) => ({ ...w, calc: true }))] });
      lines.push(line); paidPeople.add(p.id);
    }
  }
  // lines from before for people no longer employed this month
  for (const [key, l] of existing) if (!seen.has(key)) {
    if (l.mode === 'fixed') { lines.push(l); continue; }
    const manual = (l.items || []).filter((i) => !i.auto);
    if (!manual.length) { skipped.push({ name: l.emp_name, reason: 'Not employed this month any more; line removed.' }); continue; }
    // keep only what HR typed; the automatic pay (basic, allowances, overtime …) no longer applies
    const kept = { ...l, items: manual, warnings: [{ level: 'warn', text: 'Not employed this month according to their records: automatic pay was removed and only the items you added are kept. Check the employment dates or remove this line.' }] };
    const tot = computeLine(kept, { age: l.inputs?.age, statClass: l.inputs?.stat_class, period, flags: l.inputs?.flags || {}, tables: D.tables, rules });
    Object.assign(kept, tot, { warnings: [...kept.warnings, ...tot.warnings.map((w) => ({ ...w, calc: true }))] });
    lines.push(kept);   // (a kept line never carries the buy-back, so it does not count as paid)
  }
  // year-end buy-backs for people with no January line (left before January)
  if (isJan) {
    const names = new Map((D.people || []).map((p) => [p.id, p.full_name]));
    for (const b of D.buybacks || []) if (Number(b.close_year) === Number(period.slice(0, 4)) - 1 && !paidPeople.has(b.employee_id))
      notices.push(`${names.get(b.employee_id) || `Employee ${b.employee_id}`}: ${b.days} day(s) of ${b.close_year} AL buy-back, but they are not employed in January. Pay it in their final month (add an AL Buy Back item) if it is due.`);
  }
  if (noLastDay.size) notices.unshift(`Left out: ${[...noLastDay].sort().join(', ')}. They are marked as no longer employed but have no last working day. Add it in their Employment tab (Edit); if they did work this month, Recalculate afterwards.`);
  lines.sort((a, b) => a.emp_name.localeCompare(b.emp_name) || String(a.company_id).localeCompare(String(b.company_id)));
  return { lines, skipped, notices };
}

/** Tax details kept on the line (so the calculation can be repeated exactly). */
export function profileSnapshot(p) {
  if (!p) return { category: 1, children: 0, resident: true };
  const k = ['resident', 'category', 'children', 'child_relief_extra', 'disabled', 'spouse_disabled', 'tp1_monthly', 'zakat_monthly', 'prev_year', 'prev_gross', 'prev_epf', 'prev_pcb', 'prev_zakat'];
  return Object.fromEntries(k.map((x) => [x, p[x]]));
}

/** Several windows in one month for the same company -> one window with the days added together. */
export function mergeWindows(wins) {
  if (wins.length === 1) return wins[0];
  const sorted = [...wins].sort((a, b) => a.from.localeCompare(b.from));
  const calDays = sorted[0].calDays;
  const days = Math.min(calDays, sorted.reduce((s, w) => s + w.days, 0));
  return { from: sorted[0].from, to: sorted[sorted.length - 1].to, days, calDays, full: days === calDays, ranges: sorted.map((w) => [w.from, w.to]) };
}

/** Recalculate one line's totals after HR edits it. */
export function recomputeLine(line, D) {
  const inp = line.inputs || {};
  const tot = computeLine(line, { age: inp.age, statClass: inp.stat_class, period: D.period, flags: inp.flags || {}, tables: D.tables, rules: D.policies?.statutory_rules || {}, pcbPolicy: D.policies?.pcb });
  const keep = (line.warnings || []).filter((w) => !w.calc);
  return { ...line, ...tot, warnings: [...keep, ...tot.warnings.map((w) => ({ ...w, calc: true }))] };
}

const SUM_KEYS = ['gross', 'epf_ee', 'epf_er', 'socso_ee', 'socso_ee_nei', 'socso_er', 'eis_ee', 'eis_er', 'pcb', 'net', 'personal_deductions', 'reimbursements', 'net_paid', 'employer_cost'];
/** Run totals: whole run and per company (excluded lines left out). */
export function runTotals(lines) {
  const blank = () => Object.fromEntries([['lines', 0], ...SUM_KEYS.map((k) => [k, 0])]);
  const all = blank(); const companies = {};
  for (const l of lines) {
    if (l.excluded) continue;
    const c = (companies[l.company_id || 0] ||= blank());
    const v = (k) => (k === 'employer_cost' ? Number(l.gross) + Number(l.epf_er) + Number(l.socso_er) + Number(l.eis_er) : Number(l[k])) || 0;
    for (const t of [all, c]) { t.lines += 1; for (const k of SUM_KEYS) t[k] = r2(t[k] + v(k)); }
  }
  return { all, companies };
}

/** Item summary used by tables: basic, overtime, allowances & others, unpaid leave. */
export function lineSummary(line) {
  const s = { basic: 0, overtime: 0, other: 0, unpaid: 0, claims: 0 };
  for (const i of line.items || []) {
    const a = itemAmount(i);
    if (i.code === 'BASIC') s.basic += a;
    else if (i.category === 'reimbursement') s.claims += a;
    else if (i.category === 'overtime') s.overtime += a;
    else if (i.kind === 'earning') s.other += a;
    else if (i.category !== 'personal') s.unpaid += a;
  }
  for (const k of Object.keys(s)) s[k] = r2(s[k]);
  return s;
}

export { OT_CATEGORIES };
