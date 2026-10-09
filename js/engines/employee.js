// MyPayroll-System-V2.0 · engines/employee.js — pure helpers for employee records (Node-testable)

const pad = (n) => String(n).padStart(2, '0');
const DAY = 86400000;

/** 'YYYY-MM-DD' -> UTC ms (timezone-proof). */
export const isoToMs = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
export const msToIso = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (iso, n) => msToIso(isoToMs(iso) + n * DAY);
export const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export function lastDayOfMonth(iso) {
  const [y, m] = String(iso).slice(0, 10).split('-').map(Number);
  return msToIso(Date.UTC(y, m, 0));
}
export const firstOfMonth = (iso) => String(iso).slice(0, 7) + '-01';

/** Excel date serial (1900 system) -> 'YYYY-MM-DD'. Uses UTC so no timezone shift. */
export function excelSerialToIso(v) {
  if (typeof v !== 'number' || !isFinite(v) || v < 1) return null;
  return msToIso(Date.UTC(1899, 11, 30) + Math.floor(v + 1e-9) * DAY);
}
/** Excel time fraction (0.375) -> 'HH:MM'. */
export function excelFractionToTime(v) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  const mins = Math.round((v - Math.floor(v)) * 1440);
  if (mins <= 0 || mins >= 1440) return null;
  return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
}

/** Completed years, months and days between two ISO dates. */
export function serviceLength(fromIso, toIso) {
  if (!fromIso || !toIso || toIso < fromIso) return null;
  const [y1, m1, d1] = fromIso.split('-').map(Number);
  const [y2, m2, d2] = toIso.split('-').map(Number);
  let years = y2 - y1, months = m2 - m1, days = d2 - d1;
  if (days < 0) { months -= 1; days += new Date(Date.UTC(y2, m2 - 1, 0)).getUTCDate(); }
  if (months < 0) { years -= 1; months += 12; }
  return { years, months, days };
}
export function formatService(s) {
  if (!s) return '';
  const parts = [];
  if (s.years) parts.push(`${s.years} yr${s.years > 1 ? 's' : ''}`);
  if (s.months) parts.push(`${s.months} mth${s.months > 1 ? 's' : ''}`);
  if (!parts.length) parts.push(`${s.days} day${s.days === 1 ? '' : 's'}`);
  return parts.join(' ');
}
export const ageOn = (dobIso, onIso) => { const s = serviceLength(dobIso, onIso); return s ? s.years : null; };

/** NRIC '740817-61-5020' -> normalised '740817-61-5020'; anything else -> null. */
export function normaliseNric(v) {
  const digits = String(v ?? '').replace(/\D/g, '');
  if (digits.length !== 12) return null;
  return `${digits.slice(0, 6)}-${digits.slice(6, 8)}-${digits.slice(8)}`;
}
/** SOCSO number = NRIC digits (workbook rule). */
export const socsoFromNric = (nric) => { const n = normaliseNric(nric); return n ? n.replace(/-/g, '') : null; };
/** Date of birth from NRIC YYMMDD (century guessed against today). */
export function dobFromNric(nric, todayIsoStr = todayIso()) {
  const n = normaliseNric(nric); if (!n) return null;
  const yy = Number(n.slice(0, 2)), mm = Number(n.slice(2, 4)), dd = Number(n.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const curYY = Number(todayIsoStr.slice(2, 4));
  const year = (yy <= curYY ? 2000 : 1900) + yy;
  const iso = `${year}-${pad(mm)}-${pad(dd)}`;
  return msToIso(isoToMs(iso)) === iso ? iso : null;
}

/**
 * Salary used for a payroll month = the record in force on the LAST day of that month
 * (matches what the workbook paid in 319 of 345 months, Jan–Sep 2026).
 * history: [{effective_from, amount, pay_basis}]
 */
export function salaryForMonth(history, monthIso) {
  return salaryAsOf(history, lastDayOfMonth(monthIso));
}
export function salaryAsOf(history, onIso) {
  let best = null;
  for (const h of history || []) {
    if (!h.effective_from || h.effective_from > onIso) continue;
    if (!best || h.effective_from > best.effective_from) best = h;
  }
  return best;
}

/** Allowances payable in a month: started on/before month end and not ended before month start. */
export function allowancesForMonth(allowances, monthIso) {
  const start = firstOfMonth(monthIso), end = lastDayOfMonth(monthIso);
  return (allowances || []).filter((a) => (!a.start_date || a.start_date <= end) && (!a.end_date || a.end_date >= start));
}

/**
 * Status of an employment period.
 * confMeta: { [code]: { label, is_active_employment } } from the confirmation_status pick-list.
 * Returns { key: 'current'|'notice'|'former', label }.
 */
export function employmentStatus(em, confMeta = {}, onIso = todayIso()) {
  if (!em) return { key: 'former', label: 'No employment record' };
  const meta = confMeta[em.confirmation_status] || {};
  const label = meta.label || em.confirmation_status || '';
  if (em.resigned_date && em.resigned_date < onIso) return { key: 'former', label: meta.is_active_employment === false ? label : 'Left' };
  if (meta.is_active_employment === false) return { key: 'former', label };
  if (em.resignation_letter_date || (em.resigned_date && em.resigned_date >= onIso)) return { key: 'notice', label: 'Serving notice' };
  return { key: 'current', label: label || 'Current' };
}
