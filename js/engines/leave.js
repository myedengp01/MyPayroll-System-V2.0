// MyPayroll-System-V2.0 · engines/leave.js — leave entitlements, day counting, balances, year-end close
// Pure functions (no DOM, no network) so they can be tested in Node against the workbook.

import { isoToMs, msToIso, addDays, serviceLength, todayIso } from './employee.js';

const DAY = 86400000;
const dow = (iso) => new Date(isoToMs(iso)).getUTCDay();          // 0 = Sunday … 6 = Saturday
const ymd = (iso) => String(iso).slice(0, 10).split('-').map(Number);
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
export const halfUp = (x) => Math.floor(x) + (x - Math.floor(x) >= 0.5 - 1e-9 ? 1 : 0);   // workbook: INT(x)+(MOD(x,1)>=0.5)

/** Excel EDATE: same day n months later, clamped to the month end. */
export function edate(iso, months) {
  const [y, m, d] = ymd(iso);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const ny = t.getUTCFullYear(), nm = t.getUTCMonth() + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, daysInMonth(ny, nm))).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- working days
/**
 * Leave days between two dates inclusive.
 * opts: { holidays:Set<'YYYY-MM-DD'>, restDays:[0], offDays:[6], calendar:false, halfDay:'none'|'am'|'pm' }
 * Calendar mode (maternity, paternity) counts every day.
 */
export function countLeaveDays(from, to, opts = {}) {
  if (!from || !to || to < from) return 0;
  if (opts.calendar) return Math.round((isoToMs(to) - isoToMs(from)) / DAY) + 1;
  const skip = new Set([...(opts.restDays ?? [0]), ...(opts.offDays ?? [6])]);
  const hol = opts.holidays || new Set();
  let n = 0;
  for (let t = isoToMs(from); t <= isoToMs(to); t += DAY) {
    const iso = msToIso(t);
    if (skip.has(new Date(t).getUTCDay()) || hol.has(iso)) continue;
    n += 1;
  }
  if (opts.halfDay && opts.halfDay !== 'none' && from === to && n === 1) return 0.5;
  return n;
}

// ---------------------------------------------------------------- annual leave (workbook AL calculator)
/**
 * Months counted for a period (AL CALCULATOR v.042026):
 *   same month   -> 1 if it starts on/before the 15th and ends on/after the 15th, else 0
 *   otherwise    -> (start day <= 15 ? 1 : 0) + whole months between + (end day >= 15 ? 1 : 0)
 * legacy:true reproduces the older StaffPersonalData formula (no same-month rule).
 */
export function countedMonths(start, finish, { legacy = false } = {}) {
  const [y1, m1, d1] = ymd(start), [y2, m2, d2] = ymd(finish);
  if (!legacy && y1 === y2 && m1 === m2) return d1 <= 15 && d2 >= 15 ? 1 : 0;
  const sc = d1 > 15 ? 0 : 1;
  const mid = Math.max(0, (y2 - y1) * 12 + (m2 - m1) - 1);
  const ec = d2 >= 15 ? 1 : 0;
  return sc + mid + ec;
}

/** Days per year for a service band: first band whose until_months boundary is after the period start. */
function bandFor(join, periodStart, bands) {
  for (const b of bands) {
    if (b.until_months === null || b.until_months === undefined) return { ...b, bandEnd: null };
    const boundary = edate(join, b.until_months);
    if (periodStart < boundary) return { ...b, bandEnd: addDays(boundary, -1) };
  }
  const last = bands[bands.length - 1];
  return { ...last, bandEnd: null };
}

/**
 * Split service into periods (calendar year x service band x resignation), as the workbook does.
 * Returns [{ start, end, days, months, raw, entitled }] for periods ending on/before toYear.
 */
export function alPeriods({ joinDate, resignDate = null, bands, toYear, legacy = false }) {
  const out = [];
  if (!joinDate) return out;
  let start = joinDate;
  for (let guard = 0; guard < 200; guard++) {
    if (resignDate && start > resignDate) break;
    const band = bandFor(joinDate, start, bands);
    const yearEnd = `${start.slice(0, 4)}-12-31`;
    let end = yearEnd;
    if (band.bandEnd && band.bandEnd < end) end = band.bandEnd;
    if (resignDate && resignDate < end) end = resignDate;
    if (Number(end.slice(0, 4)) > toYear) break;
    const months = countedMonths(start, end, { legacy });
    const raw = r2((band.days * months) / 12);
    out.push({ start, end, days: band.days, months, raw, entitled: halfUp(raw) });
    if (resignDate && end === resignDate) break;
    start = addDays(end, 1);
    if (Number(start.slice(0, 4)) > toYear) break;
  }
  return out;
}

/** Annual leave entitled for a calendar year = sum of the rounded periods that end in that year. */
export function alEntitlement({ joinDate, resignDate = null, bands, year, legacy = false }) {
  const periods = alPeriods({ joinDate, resignDate, bands, toYear: year, legacy }).filter((p) => Number(p.end.slice(0, 4)) === year);
  return { days: periods.reduce((s, p) => s + p.entitled, 0), periods };
}

// ---------------------------------------------------------------- other entitlements (EA)
/** Sick leave by completed years of service on the given date (EA s60F: 14 / 18 / 22). */
export function slEntitlement(joinDate, onIso, slRule) {
  const bands = slRule?.bands || [{ until_years: 2, days: 14 }, { until_years: 5, days: 18 }, { until_years: null, days: 22 }];
  const yrs = joinDate && onIso >= joinDate ? serviceLength(joinDate, onIso).years : 0;
  for (const b of bands) if (b.until_years === null || b.until_years === undefined || yrs < b.until_years) return b.days;
  return bands[bands.length - 1].days;
}

/** Part-time pro-rating (Employment (Part-Time Employees) Regulations): full-time days × weekly hours ÷ full-time hours. */
export function proRate(days, weeklyHours, ptPolicy) {
  const ft = Number(ptPolicy?.full_time_weekly_hours) || 45;
  if (!weeklyHours) return null;                       // weekly hours not recorded yet
  return halfUp((days * Math.min(Number(weeklyHours), ft)) / ft);
}

// ---------------------------------------------------------------- balances
/**
 * Leave position for one employee and year.
 * input: { employment:{join_date, resigned_date, job_status, weekly_hours}, gender, year, asOf,
 *          records:[{leave_type, date_from, days, status}], adjustments:[{leave_type, year, kind, days, expires_on, effective_date}],
 *          policies:{ al_entitlement, leave_rules, part_time, carry_forward } }
 * Returns { AL:{entitled, carried, carriedExpired, adjusted, taken, buyback, forfeit, balance, periods, needsHours}, SL:{…}, … }
 */
export function leaveBalances(input) {
  const { employment: em = {}, year, policies = {} } = input;
  const asOf = input.asOf || todayIso();
  const rules = policies.leave_rules || {};
  const partTime = em.job_status === 'PT';
  const recs = (input.records || []).filter((r) => r.status !== 'cancelled' && String(r.date_from).slice(0, 4) === String(year));
  const adjs = (input.adjustments || []).filter((a) => Number(a.year) === Number(year));
  const taken = (t) => r2(recs.filter((r) => r.leave_type === t).reduce((s, r) => s + Number(r.days), 0));
  const adj = (t, kinds) => r2(adjs.filter((a) => a.leave_type === t && kinds.includes(a.kind)).reduce((s, a) => s + Number(a.days), 0));
  const out = {};

  // AL
  const bands = policies.al_entitlement?.bands || [{ until_months: 24, days: 8 }, { until_months: 60, days: 12 }, { until_months: null, days: 16 }];
  const al = em.join_date ? alEntitlement({ joinDate: em.join_date, resignDate: em.resigned_date, bands, year }) : { days: 0, periods: [] };
  let alEnt = al.days, needsHours = false;
  if (partTime && (policies.part_time?.prorate || ['AL', 'SL']).includes('AL')) {
    const p = proRate(alEnt, em.weekly_hours, policies.part_time);
    if (p === null) needsHours = true; else alEnt = p;
  }
  const carried = adj('AL', ['carry_forward', 'opening']);
  // carried days are used first; any not used by their expiry date lapse
  let carriedExpired = adj('AL', ['expired']);
  for (const a of adjs.filter((x) => x.leave_type === 'AL' && x.kind === 'carry_forward' && x.expires_on && x.expires_on < asOf)) {
    const usedBefore = r2(recs.filter((r) => r.leave_type === 'AL' && r.date_from <= a.expires_on).reduce((s, r) => s + Number(r.days), 0));
    carriedExpired = r2(carriedExpired + Math.max(0, Number(a.days) - usedBefore));
  }
  const alTaken = taken('AL'), adjusted = adj('AL', ['manual']), buyback = adj('AL', ['buyback']), forfeit = adj('AL', ['forfeit']);
  out.AL = { entitled: alEnt, carried, carriedExpired, adjusted, taken: alTaken, buyback, forfeit, periods: al.periods, needsHours,
             balance: r2(alEnt + carried + adjusted - carriedExpired - alTaken - buyback - forfeit) };

  // SL / HPL (hospitalisation shares a 60-day pool with sick leave)
  const onIso = asOf < `${year}-12-31` ? asOf : `${year}-12-31`;
  let slEnt = slEntitlement(em.join_date, onIso, rules.SL);
  if (partTime && (policies.part_time?.prorate || ['AL', 'SL']).includes('SL')) {
    const p = proRate(slEnt, em.weekly_hours, policies.part_time); if (p === null) needsHours = true; else slEnt = p;
  }
  const slTaken = taken('SL'), hplTaken = taken('HPL');
  out.SL = { entitled: slEnt, taken: slTaken, balance: r2(slEnt + adj('SL', ['manual', 'opening']) - slTaken) };
  const hplPool = Number(rules.HPL?.days ?? 60);
  out.HPL = { entitled: hplPool, taken: hplTaken, balance: r2(hplPool + adj('HPL', ['manual', 'opening']) - hplTaken - (rules.HPL?.includes_sick_leave === false ? 0 : slTaken)) };

  // per-event leave: show entitlement per occasion and days taken this year
  out.MTL = { perEvent: Number(rules.MTL?.days ?? 98), taken: taken('MTL'), eligible: input.gender ? input.gender === (rules.MTL?.gender || 'F') : null };
  const svcMonths = em.join_date ? (() => { const s = serviceLength(em.join_date, onIso); return s ? s.years * 12 + s.months : 0; })() : 0;
  out.PTL = { perEvent: Number(rules.PTL?.days ?? 7), taken: taken('PTL'),
              eligible: input.gender ? input.gender === (rules.PTL?.gender || 'M') && svcMonths >= Number(rules.PTL?.min_service_months ?? 12) : null };
  const cplYear = Number(rules.CPL?.per_year ?? 4);
  out.CPL = { perEvent: Number(rules.CPL?.per_occasion ?? 2), entitled: cplYear, taken: taken('CPL'), balance: r2(cplYear + adj('CPL', ['manual']) - taken('CPL')) };
  const rlEarned = adj('RL', ['earned', 'opening', 'carry_forward', 'manual']);
  out.RL = { earned: rlEarned, taken: taken('RL'), balance: r2(rlEarned - taken('RL')) };
  out.UPL = { taken: taken('UPL') };
  return out;
}

// ---------------------------------------------------------------- year-end close
/**
 * What happens to one person's unused annual leave at the end of `year`.
 * person: { employee_id, confirmed:boolean, grade:'E'|'S'|'A'|'I'|'U'|null, balance:number }
 * choice: { buybackPct: 50|25|10|<custom>|null }   (only offered to buyback grades)
 * Returns { carry, buyback, buybackPct, forfeit, reason, adjustments:[…] }
 */
export function closeYearFor(person, cf, year, choice = {}) {
  const bal = Math.max(0, r2(Number(person.balance) || 0));
  const res = { carry: 0, buyback: 0, buybackPct: null, forfeit: 0, reason: '', adjustments: [] };
  if (bal <= 0) { res.reason = 'No unused leave'; return res; }
  const eligible = (!cf.confirmed_only || person.confirmed) && person.grade;
  const cap = eligible ? Number(cf.grades?.[person.grade] ?? 0) : 0;
  res.carry = Math.min(bal, cap);
  const excess = r2(bal - res.carry);
  const canBuy = eligible && (cf.buyback_grades || []).includes(person.grade);
  if (excess > 0 && canBuy && choice.buybackPct) { res.buyback = excess; res.buybackPct = Number(choice.buybackPct); }
  else res.forfeit = excess;
  res.reason = !person.confirmed && cf.confirmed_only ? 'Not confirmed: no carry forward'
    : !person.grade ? 'No KPI grade: no carry forward' : `Grade ${person.grade}: carry up to ${cap} day${cap === 1 ? '' : 's'}`;
  const next = year + 1;
  const expires = cf.expiry ? `${next}-${cf.expiry}` : null;
  if (res.carry > 0) res.adjustments.push({ employee_id: person.employee_id, leave_type: 'AL', year: next, kind: 'carry_forward', days: res.carry,
    effective_date: `${next}-01-01`, expires_on: expires, note: `Carried from ${year} (${res.reason})` });
  if (res.buyback > 0) res.adjustments.push({ employee_id: person.employee_id, leave_type: 'AL', year, kind: 'buyback', days: res.buyback,
    buyback_pct: res.buybackPct, effective_date: `${year}-12-31`, note: `Unused ${year} leave above the carry-forward cap, bought back at ${res.buybackPct}%` });
  if (res.forfeit > 0) res.adjustments.push({ employee_id: person.employee_id, leave_type: 'AL', year, kind: 'forfeit', days: res.forfeit,
    effective_date: `${year}-12-31`, note: `Unused ${year} leave not carried forward` });
  return res;
}

// KPI grades best-first (jsonb stores object keys alphabetically, so never rely on key order)
const GRADE_RANK = ['E', 'S', 'A', 'I', 'U'];
export function gradeOrder(grades) {
  const r = (g) => { const i = GRADE_RANK.indexOf(g); return i < 0 ? 99 : i; };
  return Object.keys(grades || {}).sort((a, b) => r(a) - r(b) || a.localeCompare(b));
}
