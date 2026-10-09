// MyPayroll-System-V2.0 · pay-data.js — loaders for the payroll screens (admin + HR)
import { fetchAll, loadRef, loadStatTables } from './data.js';
import { periodOf, prevPeriod } from './engines/payroll.js';
import { lastDayOfMonth } from './engines/employee.js';
import { loadLeaveYear, balancesFor, loadPeople } from './leave-data.js';

/** People with employments → assignments → salary history and allowances, plus DOB and statutory class. */
export async function loadPayPeople(sb, ref) {
  const [emps, priv, empls, asg, sal, allow] = await Promise.all([
    fetchAll(() => sb.from('eppd_employees').select('id,emp_id,full_name,nationality').order('full_name')),
    fetchAll(() => sb.from('eppd_employee_private').select('employee_id,dob')),
    fetchAll(() => sb.from('eppd_employments').select('*').order('join_date', { ascending: true, nullsFirst: true })),
    fetchAll(() => sb.from('eppd_assignments').select('*').order('id')),
    fetchAll(() => sb.from('eppd_salary_history').select('assignment_id,effective_from,amount,pay_basis').order('effective_from')),
    fetchAll(() => sb.from('eppd_allowances').select('*').order('id')),
  ]);
  const natClass = new Map((ref.lk.nationality || []).map((l) => [l.code, l.meta?.stat_class || 'MY']));
  const dob = new Map(priv.map((p) => [p.employee_id, p.dob]));
  const salBy = group(sal, 'assignment_id'); const allowBy = group(allow, 'assignment_id');
  const asgBy = group(asg.map((a) => ({ ...a, salary_history: salBy.get(a.id) || [], allowances: allowBy.get(a.id) || [] })), 'employment_id');
  const emBy = group(empls.map((e) => ({ ...e, assignments: asgBy.get(e.id) || [] })), 'employee_id');
  return emps.map((e) => ({ ...e, dob: dob.get(e.id) || null, statClass: natClass.get(e.nationality) || 'MY', employments: emBy.get(e.id) || [] }));
}
function group(rows, key) { const m = new Map(); for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); } return m; }

/** Payment types with their statutory switches, by code and by id. */
export async function loadPayTypes(sb) {
  const { data, error } = await sb.from('eppd_payment_types').select('*').order('sort_order');
  if (error) throw error;
  return { list: data, byCode: new Map(data.map((t) => [t.code, t])), byId: new Map(data.map((t) => [t.id, t])) };
}

/** Everything the engine needs for months from..to (inclusive), loaded once. */
export async function loadPayInputs(sb, fromPeriod, toPeriod) {
  const from = periodOf(fromPeriod), to = lastDayOfMonth(toPeriod);
  const [time, leave, buybacks] = await Promise.all([
    fetchAll(() => sb.from('eppd_time_entries').select('employee_id,work_date,category,hours').gte('work_date', from).lte('work_date', to)),
    fetchAll(() => sb.from('eppd_leave_records').select('employee_id,leave_type,date_from,days,status').eq('leave_type', 'UPL').gte('date_from', from).lte('date_from', to)),
    fetchAll(() => sb.from('eppd_leave_adjustments').select('id,employee_id,days,buyback_pct,close_year').eq('kind', 'buyback').eq('source', 'year_close')),
  ]);
  return { time, leave, buybacks };
}

/** Run + lines for one month (null when not started). */
export async function loadRun(sb, period) {
  const { data: run, error } = await sb.from('eppd_pay_runs').select('*').eq('period', periodOf(period)).maybeSingle();
  if (error) throw error;
  if (!run) return null;
  const lines = await fetchAll(() => sb.from('eppd_pay_lines').select('*').eq('run_id', run.id).order('emp_name'));
  return { ...run, lines };
}

/** The full engine context for one month. */
export async function loadPayMonth(sb, period) {
  const p = periodOf(period);
  const ref = await loadRef(sb);
  const [people, types, tables, inputs, run, prev] = await Promise.all([
    loadPayPeople(sb, ref), loadPayTypes(sb), loadStatTables(sb), loadPayInputs(sb, p, p), loadRun(sb, p), loadRun(sb, prevPeriod(p)),
  ]);
  const D = {
    ref, period: p, people, typeList: types.list, types: types.byCode, typesById: types.byId, tables, policies: ref.policies,
    ...inputs, run, existing: run?.lines || [], prevLines: prev?.lines || [],
    companies: new Map(ref.companies.map((c) => [c.id, c])), confMeta: ref.confMeta,
  };
  Object.assign(D, await loadPhase6(sb, D));
  return D;
}

/** Phase 6 inputs, loaded only for the modules that are switched on. A missing table (008 not run yet) just switches the module off. */
export async function loadPhase6(sb, D) {
  const mods = D.policies?.modules || {};
  const out = { taxProfiles: new Map(), claims: [], loans: [], settlements: new Map(), leaverAL: new Map(), yearLines: [], phase6Errors: [] };
  const p = D.period; const year = p.slice(0, 4);
  const safe = async (label, fn) => { try { return await fn(); } catch (e) { out.phase6Errors.push(`${label}: ${e.message || e}`); return null; } };
  if (mods.pcb_auto || mods.loans) {
    const lines = await safe('Earlier months', () => fetchAll(() => sb.from('eppd_pay_lines').select('employee_id,company_id,items,epf_ee,socso_ee,eis_ee,pcb,excluded,inputs,eppd_pay_runs!inner(period,status)')
      .eq('eppd_pay_runs.status', 'finalised').lt('eppd_pay_runs.period', p).order('id')));
    out.yearLines = (lines || []).map(({ eppd_pay_runs: r, ...l }) => ({ ...l, period: r.period }));
  }
  if (mods.pcb_auto) {
    const rows = await safe('Tax details', () => fetchAll(() => sb.from('eppd_tax_profiles').select('*')));
    for (const r of rows || []) out.taxProfiles.set(r.employee_id, r);
    out.yearLines.forEach((l) => l);   // (finalised lines are also used for the year-to-date PCB figures)
  }
  if (mods.claims?.enabled) out.claims = (await safe('Claims', () => fetchAll(() => sb.from('eppd_claims').select('*').eq('pay_period', p)))) || [];
  if (mods.loans) {
    const loans = (await safe('Loans', () => fetchAll(() => sb.from('eppd_loans').select('*').eq('status', 'active')))) || [];
    const repaid = loanRepayments(out.yearLines);
    out.loans = loans.map((ln) => ({ ...ln, repaid: repaid.get(ln.id) || 0 }));
  }
  if (mods.settlement) {
    const rows = (await safe('Final settlements', () => fetchAll(() => sb.from('eppd_settlements').select('*')))) || [];
    for (const r of rows) out.settlements.set(r.employment_id, r);
    // unused annual leave at the last working day, for everyone leaving this month
    const leavers = D.people.filter((x) => (x.employments || []).some((e) => e.resigned_date && periodOf(e.resigned_date) === p));
    if (leavers.length) {
      await safe('Leave balances', async () => {
        const L = await loadLeaveYear(sb, Number(year));
        const lp = new Map((await loadPeople(sb, L.ref)).map((x) => [x.id, x]));
        for (const x of leavers) {
          const em = x.employments.find((e) => e.resigned_date && periodOf(e.resigned_date) === p);
          const person = lp.get(x.id); if (!person) continue;
          const b = balancesFor({ ...person, employment: { ...(person.employment || {}), ...em } }, L, em.resigned_date);
          out.leaverAL.set(x.id, b?.AL ? Math.round(b.AL.balance * 100) / 100 : null);
        }
      });
    }
  }
  return out;
}

/** Loan repayments already made in finalised months: loan id → amount. */
export function loanRepayments(lines) {
  const m = new Map();
  for (const l of lines || []) {
    if (l.excluded) continue;
    for (const i of l.items || []) {
      const k = /^LOAN:(\d+)$/.exec(i.key || ''); if (!k) continue;
      m.set(Number(k[1]), (m.get(Number(k[1])) || 0) + (Number(i.override ?? i.amount) || 0));
    }
  }
  return m;
}
