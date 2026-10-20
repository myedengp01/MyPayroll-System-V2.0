import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaveBalances } from '../js/engines/leave.js';
import { leaveForMonth } from '../js/leave-data.js';
import { hoursBetween } from '../js/engines/ot.js';
import { savePtTotal, MONTHLY_NOTE, hourlyPeople } from '../js/pt-hours.js';

const policies = { al_entitlement: { bands: [{ until_months: 24, days: 8 }, { until_months: 60, days: 12 }, { until_months: null, days: 16 }] },
  leave_rules: { SL: { bands: [{ days: 14, until_years: 2 }, { days: 18, until_years: 5 }, { days: 22, until_years: null }] }, HPL: { days: 60 } } };
const em = { join_date: '2020-01-06', job_status: 'FT' };
const rec = (t, d, days) => ({ employee_id: 1, leave_type: t, date_from: d, date_to: d, days, status: 'taken' });
const records = [rec('AL', '2026-02-01', 2), rec('AL', '2026-09-01', 1.5), rec('AL', '2026-11-03', 3), rec('SL', '2026-09-01', 1), rec('UPL', '2026-09-01', 2)];
const adjustments = [{ employee_id: 1, leave_type: 'AL', year: 2026, kind: 'opening', days: 4, effective_date: '2026-01-01' },
  { employee_id: 1, leave_type: 'AL', year: 2026, kind: 'manual', days: -1, effective_date: '2026-12-01' }];

test('cutoff leaves out later leave and later adjustments', () => {
  const all = leaveBalances({ employment: em, year: 2026, asOf: '2026-12-31', records, adjustments, policies });
  const sep = leaveBalances({ employment: em, year: 2026, asOf: '2026-09-30', cutoff: '2026-09-30', records, adjustments, policies });
  assert.equal(all.AL.taken, 6.5); assert.equal(sep.AL.taken, 3.5);
  assert.equal(sep.AL.balance, 16 + 4 - 3.5);
  assert.equal(all.AL.balance, 16 + 4 - 1 - 6.5);
});

test('leaveForMonth: entitled, this month, to date, balance', () => {
  const D = { year: 2026, records, adjustments, ref: { policies } };
  const m = leaveForMonth({ id: 1, employment: em }, D, '2026-09-01');
  assert.deepEqual([m.AL.entitled, m.AL.month, m.AL.toDate, m.AL.balance], [20, 1.5, 3.5, 16.5]);
  assert.equal(m.AL.carried, 4);
  assert.deepEqual([m.SL.month, m.SL.toDate], [1, 1]);
  assert.deepEqual([m.UPL.month, m.UPL.toDate, m.UPL.balance], [2, 2, null]);
  const oct = leaveForMonth({ id: 1, employment: em }, D, '2026-10-01');
  assert.deepEqual([oct.AL.month, oct.AL.toDate], [0, 3.5]);
});

test('hours from times, break and overnight', () => {
  assert.equal(hoursBetween('07:30', '12:00'), 4.5);
  assert.equal(hoursBetween('08:00', '17:00', 1), 8);
  assert.equal(hoursBetween('22:00', '02:00'), 4);
  assert.equal(hoursBetween('08:15', '09:00'), 0.75);
  assert.equal(hoursBetween('', '09:00'), null);
});

function fakeSb() {
  const calls = [];
  const q = (table) => ({
    insert: (row) => { calls.push(['insert', table, row]); return Promise.resolve({ error: null }); },
    update: (row) => ({ eq: (k, v) => { calls.push(['update', table, row, v]); return Promise.resolve({ error: null }); } }),
    delete: () => ({ eq: (k, v) => { calls.push(['delete', table, v]); return Promise.resolve({ error: null }); }, in: (k, v) => { calls.push(['delete', table, v]); return Promise.resolve({ error: null }); } }),
  });
  return { calls, from: q };
}
const day = (id, hours) => ({ id, employee_id: 7, category: 'PT_HOURS', hours, note: null });

test('part-time monthly total: tops up day entries, updates or removes the monthly entry', async () => {
  let sb = fakeSb();
  await savePtTotal(sb, { employeeId: 7, month: '2026-10', total: 12, entries: [day(1, 4.5), day(2, 4.5)] });
  assert.deepEqual(sb.calls[0].slice(0, 2), ['insert', 'eppd_time_entries']);
  assert.equal(sb.calls[0][2].hours, 3); assert.equal(sb.calls[0][2].note, MONTHLY_NOTE); assert.equal(sb.calls[0][2].work_date, '2026-10-31');
  sb = fakeSb();
  const res = await savePtTotal(sb, { employeeId: 7, month: '2026-10', total: 5, entries: [day(1, 4.5), day(2, 4.5)] });
  assert.match(res.error.message, /9 h are already recorded/); assert.equal(sb.calls.length, 0);
  sb = fakeSb();
  await savePtTotal(sb, { employeeId: 7, month: '2026-10', total: 80, entries: [{ id: 9, employee_id: 7, category: 'PT_HOURS', hours: 60, note: MONTHLY_NOTE }] });
  assert.deepEqual(sb.calls[0], ['update', 'eppd_time_entries', { hours: 80 }, 9]);
  sb = fakeSb();
  await savePtTotal(sb, { employeeId: 7, month: '2026-10', total: 9, entries: [day(1, 9), { id: 9, employee_id: 7, category: 'PT_HOURS', hours: 3, note: MONTHLY_NOTE }] });
  assert.deepEqual(sb.calls[0], ['delete', 'eppd_time_entries', 9]);
});

test('hourly-paid people for a month', () => {
  const people = [
    { id: 1, emp_id: 'A', full_name: 'B PERSON', employments: [{ join_date: '2026-03-01', assignments: [{ company_id: 1, start_date: '2026-03-01', salary_history: [{ effective_from: '2026-03-01', amount: 12, pay_basis: 'hourly' }] }] }] },
    { id: 2, emp_id: 'B', full_name: 'A PERSON', employments: [{ join_date: '2020-01-01', assignments: [{ company_id: 1, salary_history: [{ effective_from: '2020-01-01', amount: 3000, pay_basis: 'monthly' }] }] }] },
    { id: 3, emp_id: 'C', full_name: 'C LEFT', employments: [{ join_date: '2025-01-01', resigned_date: '2026-08-31', assignments: [{ company_id: 1, salary_history: [{ effective_from: '2025-01-01', amount: 11, pay_basis: 'hourly' }] }] }] },
  ];
  const got = hourlyPeople(people, '2026-10');
  assert.deepEqual(got.map((x) => [x.id, x.rate]), [[1, 12]]);
});
