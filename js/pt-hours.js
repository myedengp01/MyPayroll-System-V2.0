// MyPayroll-System-V2.0 · pt-hours.js — part-time hours as one monthly total (no DOM, no network: unit-tested)
import { activeWindow } from './engines/payroll.js';
import { salaryForMonth, lastDayOfMonth } from './engines/employee.js';

export const MONTHLY_NOTE = 'Monthly total (Part-time hours)';
const r2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;

/** Hourly-paid people in a month: [{ id, emp_id, full_name, rate, company_id }] */
export function hourlyPeople(payPeople, month) {
  const period = `${month}-01`; const out = [];
  for (const p of payPeople) {
    for (const em of p.employments || []) for (const a of em.assignments || []) {
      if (!activeWindow(period, em, a)) continue;
      const s = salaryForMonth(a.salary_history || [], period);
      if (s?.pay_basis === 'hourly') { out.push({ id: p.id, emp_id: p.emp_id, full_name: p.full_name, rate: Number(s.amount), company_id: a.company_id, job_status: em.job_status }); break; }
    }
  }
  return [...new Map(out.map((x) => [x.id, x])).values()].sort((a, b) => a.full_name.localeCompare(b.full_name));
}

/** Set one person's total part-time hours for a month: the monthly-total entry makes up the difference to the day entries. */
export async function savePtTotal(sb, { employeeId, month, total, entries }) {
  const mine = entries.filter((e) => e.employee_id === employeeId && e.category === 'PT_HOURS');
  const monthly = mine.filter((e) => e.note === MONTHLY_NOTE);
  const days = r2(mine.filter((e) => e.note !== MONTHLY_NOTE).reduce((s, e) => s + Number(e.hours), 0));
  const need = r2(Number(total) - days);
  if (need < 0) return { error: { message: `${days} h are already recorded day by day. Lower or delete those entries first.` } };
  const [keep, ...extra] = monthly;
  if (extra.length) { const { error } = await sb.from('eppd_time_entries').delete().in('id', extra.map((e) => e.id)); if (error) return { error }; }
  if (keep) return need === 0 ? sb.from('eppd_time_entries').delete().eq('id', keep.id) : sb.from('eppd_time_entries').update({ hours: need }).eq('id', keep.id);
  if (need === 0) return { error: null };
  return sb.from('eppd_time_entries').insert({ employee_id: employeeId, work_date: lastDayOfMonth(`${month}-01`), category: 'PT_HOURS', hours: need, source: 'manual', note: MONTHLY_NOTE });
}

