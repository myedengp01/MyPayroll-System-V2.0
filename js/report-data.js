// MyPayroll-System-V2.0 · report-data.js — loaders for Payslips & reports (admin + HR; finalised months only)
import { fetchAll, loadRef } from './data.js';

/** Finalised months, newest first. */
export async function loadFinalisedRuns(sb) {
  return fetchAll(() => sb.from('eppd_pay_runs').select('id,period,status,source,totals,finalised_at').eq('status', 'finalised').order('period', { ascending: false }));
}

/** Finalised pay lines between two months (inclusive), each with its period. */
export async function loadLines(sb, fromPeriod, toPeriod) {
  const rows = await fetchAll(() => sb.from('eppd_pay_lines').select('*, eppd_pay_runs!inner(period,status)')
    .eq('eppd_pay_runs.status', 'finalised').gte('eppd_pay_runs.period', fromPeriod).lte('eppd_pay_runs.period', toPeriod).order('id'));
  return rows.map(({ eppd_pay_runs: r, ...l }) => ({ ...l, period: r.period }));
}

/** People details needed on payslips, lists and EA forms. */
export async function loadPeopleDetails(sb, ref) {
  const [emps, priv, empls, comps] = await Promise.all([
    fetchAll(() => sb.from('eppd_employees').select('id,emp_id,full_name,gender,nationality')),
    fetchAll(() => sb.from('eppd_employee_private').select('employee_id,nric,passport_no,dob,bank_code,bank_account_no,epf_no,socso_no,tax_no')),
    fetchAll(() => sb.from('eppd_employments').select('id,employee_id,join_date,resigned_date,department_id,job_title_id,job_status,confirmation_status,work_from,work_to,meal_hours,weekly_hours').order('join_date', { ascending: true, nullsFirst: true })),
    sb.from('eppd_companies').select('*').order('sort_order'),
  ]);
  if (comps.error) throw comps.error;
  const privBy = new Map(priv.map((p) => [p.employee_id, p]));
  const emBy = new Map(); for (const e of empls) { if (!emBy.has(e.employee_id)) emBy.set(e.employee_id, []); emBy.get(e.employee_id).push(e); }
  const people = new Map(emps.map((e) => [e.id, { ...e, priv: privBy.get(e.id) || {}, employments: emBy.get(e.id) || [] }]));
  /** The employment period that covers a month (else the latest that started before it). */
  const employmentFor = (p, period) => {
    const end = period.slice(0, 7) + '-31';
    const list = (p?.employments || []).filter((e) => !e.join_date || e.join_date <= end);
    return list.find((e) => !e.resigned_date || e.resigned_date >= period) || list[list.length - 1] || p?.employments?.[0] || null;
  };
  return { people, companies: new Map(comps.data.map((c) => [c.id, c])), employmentFor,
    dept: (id) => ref.department(id), title: (id) => ref.jobTitle(id), bank: (code) => ref.label('bank', code) };
}
