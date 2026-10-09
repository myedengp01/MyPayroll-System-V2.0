// MyPayroll-System-V2.0 · leave-data.js — loaders shared by the Time & leave screens
import { fetchAll, loadRef } from './data.js';
import { leaveBalances } from './engines/leave.js';
import { employmentStatus, todayIso } from './engines/employee.js';

export const LEAVE_LABELS = { AL: 'Annual', SL: 'Sick', HPL: 'Hospitalisation', MTL: 'Maternity', PTL: 'Paternity', RL: 'Replacement', CPL: 'Compassionate', UPL: 'Unpaid' };

/** Every employee with their latest employment period, status and display fields. */
export async function loadPeople(sb, ref) {
  const [people, empls] = await Promise.all([
    fetchAll(() => sb.from('eppd_employee_list').select('id,emp_id,full_name,gender,company_name,department_code,job_title').order('full_name')),
    fetchAll(() => sb.from('eppd_employments').select('id,employee_id,join_date,resigned_date,resignation_letter_date,confirmation_status,job_status,weekly_hours,work_from,work_to,meal_hours').order('join_date', { ascending: false, nullsFirst: false })),
  ]);
  const latest = new Map();
  for (const e of empls) if (!latest.has(e.employee_id)) latest.set(e.employee_id, e);
  const today = todayIso();
  return people.map((p) => {
    const employment = latest.get(p.id) || null;
    return { ...p, employment, status: employmentStatus(employment, ref.confMeta, today) };
  });
}

/** Holidays as a Set of ISO dates for the given years. */
export async function loadHolidaySet(sb, years) {
  const ys = [...new Set(years)].sort();
  const { data } = await sb.from('eppd_holidays').select('holiday_date').eq('is_active', true)
    .gte('holiday_date', `${ys[0]}-01-01`).lte('holiday_date', `${ys[ys.length - 1]}-12-31`);
  return new Set((data || []).map((h) => h.holiday_date));
}

/** Everything needed to show balances for one year. */
export async function loadLeaveYear(sb, year) {
  const ref = await loadRef(sb);
  const [people, records, adjustments, kpi, close] = await Promise.all([
    loadPeople(sb, ref),
    fetchAll(() => sb.from('eppd_leave_records').select('*').gte('date_from', `${year}-01-01`).lte('date_from', `${year}-12-31`).order('date_from', { ascending: false })),
    fetchAll(() => sb.from('eppd_leave_adjustments').select('*').eq('year', year)),
    fetchAll(() => sb.from('eppd_kpi_ratings').select('*').eq('year', year)),
    sb.from('eppd_leave_year_closes').select('*').eq('year', year).maybeSingle(),
  ]);
  return { ref, people, records, adjustments, kpi, closed: close.data || null, year };
}

export function balancesFor(person, D, asOf) {
  return leaveBalances({
    employment: person.employment || {}, gender: person.gender, year: D.year, asOf,
    records: D.records.filter((r) => r.employee_id === person.id),
    adjustments: D.adjustments.filter((a) => a.employee_id === person.id),
    policies: D.ref.policies,
  });
}

/** People to show for a year: everyone employed at any point in that year. */
export function peopleInYear(people, year) {
  return people.filter((p) => {
    const e = p.employment; if (!e) return false;
    if (e.join_date && e.join_date > `${year}-12-31`) return false;
    if (e.resigned_date && e.resigned_date < `${year}-01-01`) return false;
    if (!e.resigned_date && p.status.key === 'former' && e.join_date && e.join_date < `${year}-01-01` && year > 0) {
      // marked resigned/terminated without a last day: show only in the year they joined or the current year's list if still flagged active
      return false;
    }
    return true;
  });
}
