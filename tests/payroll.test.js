// Payroll engine tests. The golden test at the end runs against the real workbook when
// EPPD_WORKBOOK is set (the workbook holds personal data, so it is never in the repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { prepareTables } from '../js/engines/statutory.js';
import { activeWindow, ageForPeriod, ratesOfPay, buildAutoItems, computeLine, buildRun, runTotals, recomputeLine, itemFromType, lineSummary } from '../js/engines/payroll.js';
import { buildPayHistory, historyPayload, compareLines } from '../js/engines/payimport.js';
import { buildImport } from '../js/engines/importer.js';

const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const tables = prepareTables(fx('stat_tables.json'));
const typeRows = fx('payment_types.json');
const types = new Map(typeRows.map((t) => [t.code, t]));
const typesById = new Map(typeRows.map((t) => [t.id, t]));
const em = (o = {}) => ({ join_date: '2020-01-01', resigned_date: null, work_from: '09:00', work_to: '18:00', meal_hours: 1, ot_multiplier: 1.5, ...o });
const sal = (amount, basis = 'monthly') => ({ effective_from: '2020-01-01', amount, pay_basis: basis });
const amt = (items, key) => items.find((i) => i.key === key)?.amount;

test('active window: full month, joiner, leaver, not employed', () => {
  assert.deepEqual(activeWindow('2026-03-01', em(), {}), { from: '2026-03-01', to: '2026-03-31', days: 31, calDays: 31, full: true });
  const j = activeWindow('2026-03-01', em({ join_date: '2026-03-11' }), {});
  assert.equal(j.days, 21); assert.equal(j.full, false);
  assert.equal(activeWindow('2026-04-01', em({ resigned_date: '2026-04-10' }), {}).days, 10);
  assert.equal(activeWindow('2026-05-01', em({ resigned_date: '2026-04-10' }), {}), null);
  assert.equal(activeWindow('2026-05-01', em(), { start_date: '2026-06-01' }), null);
});

test('age for statutory tables: 60+ rates start the month after the 60th birthday', () => {
  assert.equal(ageForPeriod('1966-05-15', '2026-05-01'), 59);
  assert.equal(ageForPeriod('1966-05-15', '2026-06-01'), 60);
  assert.equal(ageForPeriod('1966-05-01', '2026-05-01'), 59);   // turns 60 on 1 May: 60+ rates from June
  assert.equal(ageForPeriod(null, '2026-05-01'), null);
});

test('rates of pay: daily = basic ÷ 26, hourly = daily ÷ normal hours (meal break excluded)', () => {
  const r = ratesOfPay(sal(2600), em());
  assert.equal(r.orp, 100); assert.equal(r.normal, 8); assert.equal(r.hrp, 12.5);
  const p = ratesOfPay(sal(10, 'hourly'), em());
  assert.equal(p.hrp, 10); assert.equal(p.orp, 80);
});

test('basic pay: part month by calendar days, hourly by hours', () => {
  const j = buildAutoItems({ period: '2026-03-01', employment: em({ join_date: '2026-03-11' }), assignment: {}, salary: sal(3100), types, typesById });
  assert.equal(amt(j.items, 'BASIC'), 2100);                       // 3100 − 3100/31 × 10
  const h = buildAutoItems({ period: '2026-01-01', employment: em(), assignment: {}, salary: sal(10, 'hourly'), types, typesById,
    time: [{ category: 'PT_HOURS', hours: 37.25, work_date: '2026-01-01' }] });
  assert.equal(amt(h.items, 'BASIC'), 372.5);
  const none = buildAutoItems({ period: '2026-01-01', employment: em(), assignment: {}, salary: sal(10, 'hourly'), types, typesById, time: [] });
  assert.ok(none.warnings.some((w) => /no part-time hours/.test(w.text)));
});

test('overtime at Employment Act rates', () => {
  const day = (category, hours) => ({ category, hours, work_date: '2026-04-05' });
  const r = buildAutoItems({ period: '2026-04-01', employment: em(), assignment: {}, salary: sal(2600), types, typesById,
    time: [day('OT_NORMAL', 4), day('OT_OFFDAY', 2), day('RD_HALF', 4), day('RD_FULL', 8), day('RD_EXCESS', 2), day('PH_NORMAL', 8), day('PH_EXCESS', 1)] });
  assert.equal(amt(r.items, 'OT:OT_NORMAL'), 75);     // 4 h × 12.50 × 1.5
  assert.equal(amt(r.items, 'OT:OT_OFFDAY'), 37.5);   // 2 h × 12.50 × 1.5
  assert.equal(amt(r.items, 'OT:RD_HALF'), 50);       // half a day's pay
  assert.equal(amt(r.items, 'OT:RD_FULL'), 100);      // one day's pay
  assert.equal(amt(r.items, 'OT:RD_EXCESS'), 50);     // 2 h × 12.50 × 2
  assert.equal(amt(r.items, 'OT:PH_NORMAL'), 200);    // two days' pay
  assert.equal(amt(r.items, 'OT:PH_EXCESS'), 37.5);   // 1 h × 12.50 × 3
  assert.equal(r.warnings.length, 0);
  const bad = buildAutoItems({ period: '2026-04-01', employment: em(), assignment: {}, salary: sal(2600), types, typesById, time: [day('RD_HALF', 6)] });
  assert.ok(bad.warnings.some((w) => /more than half a day/.test(w.text)));
});

test('unpaid leave: monthly salary ÷ calendar days', () => {
  const r = buildAutoItems({ period: '2026-04-01', employment: em(), assignment: {}, salary: sal(3000), types, typesById, unpaidDays: 2 });
  assert.equal(amt(r.items, 'UPL'), 200);
  const line = { items: r.items };
  const t = computeLine(line, { age: 30, statClass: 'MY', period: '2026-04-01', tables, flags: {} });
  assert.equal(t.gross, 2800);
  assert.equal(t.epf_wage, 2800);                      // unpaid leave reduces every statutory base
});

test('statutory: matches the workbook for a March 2026 line (basic 2,600 + OT 233.33)', () => {
  const items = [itemFromType(types.get('BASIC'), { amount: 2600 }), itemFromType(types.get('OT_NORMAL'), { amount: 233.33 })];
  const t = computeLine({ items, pcb: 0 }, { age: 23, statClass: 'MY', period: '2026-03-01', tables, flags: {} });
  assert.equal(t.gross, 2833.33);
  assert.equal(t.epf_wage, 2600);                      // overtime is not subject to EPF
  assert.deepEqual([t.epf_ee, t.epf_er, t.socso_ee, t.socso_er, t.eis_ee, t.eis_er], [286, 338, 14.25, 49.85, 5.7, 5.7]);
  assert.equal(t.net, 2527.38);                        // workbook PNI 2527.3833
});

test('statutory switches, overrides, PCB and personal deductions', () => {
  const items = [itemFromType(types.get('BASIC'), { amount: 3000 }), itemFromType(types.get('LOAN'), { amount: 100 })];
  const t = computeLine({ items, pcb: 50, overrides: { socso_ee: 10 } }, { age: 30, statClass: 'MY', period: '2026-07-01', tables, flags: { epf_ee: false } });
  assert.equal(t.epf_ee, 0); assert.ok(t.epf_er > 0);
  assert.equal(t.socso_ee, 10);
  assert.equal(t.net, 3000 - 0 - 10 - t.eis_ee - 50);
  assert.equal(t.personal_deductions, 100);
  assert.equal(t.net_paid, t.net - 100);
});

test('build run: two companies, keeps HR edits, carries PCB, pays January buy-back', () => {
  const person = { id: 1, full_name: 'TEST PERSON', emp_id: 'MEG0120F0001', dob: '1990-01-01', statClass: 'MY', employments: [{
    ...em(), assignments: [
      { id: 11, company_id: 1, is_primary: true, salary_history: [sal(3000)], allowances: [{ id: 5, payment_type_id: types.get('TRANSPORT').id, amount: 100 }] },
      { id: 12, company_id: 2, is_primary: false, salary_history: [sal(500)], allowances: [] },
    ] }] };
  const D = { period: '2027-01-01', people: [person], types, typesById, tables, policies: {},
    time: [{ employee_id: 1, category: 'OT_NORMAL', hours: 2, work_date: '2027-01-10' }],
    leave: [], buybacks: [{ id: 9, employee_id: 1, days: 3, buyback_pct: 50, close_year: 2026 }],
    prevLines: [{ employee_id: 1, company_id: 1, pcb: 45 }] };
  const r1 = buildRun(D);
  assert.equal(r1.lines.length, 2);
  const main = r1.lines.find((l) => l.company_id === 1); const side = r1.lines.find((l) => l.company_id === 2);
  assert.ok(main.items.some((i) => i.key === 'OT:OT_NORMAL'), 'overtime goes on the primary line');
  assert.ok(!side.items.some((i) => i.category === 'overtime'));
  assert.equal(amt(main.items, 'BUYBACK:9'), r2(3 * (3000 / 26) * 0.5));
  assert.equal(main.pcb, 45); assert.ok(main.warnings.some((w) => /copied from last month/.test(w.text)));
  // HR edits: override transport, add a bonus, change PCB, exclude the side line
  main.items.find((i) => i.key === 'ALLOW:5').override = 150;
  main.items.push(itemFromType(types.get('BONUS'), { auto: false, amount: 500 }));
  main.pcb = 60; side.excluded = true;
  const r2run = buildRun({ ...D, existing: r1.lines });
  const m2 = r2run.lines.find((l) => l.company_id === 1);
  assert.equal(m2.items.find((i) => i.key === 'ALLOW:5').override, 150);
  assert.ok(m2.items.some((i) => i.code === 'BONUS' && !i.auto));
  assert.equal(m2.pcb, 60);
  assert.equal(r2run.lines.find((l) => l.company_id === 2).excluded, true);
  const tot = runTotals(r2run.lines);
  assert.equal(tot.all.lines, 1);
  assert.equal(tot.all.gross, m2.gross);
  // recompute after an edit
  m2.pcb = 0; const again = recomputeLine(m2, D);
  assert.equal(again.net, r2(m2.gross - again.epf_ee - again.socso_ee - again.eis_ee));
});
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

// ---------------------------------------------------------------- golden: the real workbook
const path = process.env.EPPD_WORKBOOK;
let XLSX = null;
try { XLSX = createRequire(import.meta.url)('xlsx'); } catch { /* not installed */ }
const skip = !path || !existsSync(path) || !XLSX ? 'set EPPD_WORKBOOK and run npm install to test against the real workbook' : false;

test('workbook payroll history: Jan–Sep 2026 imported, figures add up, anomalies held back', { skip }, () => {
  const wb = XLSX.read(readFileSync(path), { sheets: ['StaffPersonalData', 'PayrollSMRY2026'] });
  const ref = fx('reference_seed.json');
  const imp = buildImport(wb.Sheets, ref, { defaultCompanyCode: 'MEG', today: '2026-10-09' });
  const typeByCode = types;
  let id = 0;
  const people = imp.payload.people.map((p) => ({ id: ++id, full_name: p.full_name, emp_id: p.emp_id, dob: p.private?.dob || null, statClass: 'MY',
    employments: p.employments.map((e) => ({ ...e, assignments: e.assignments.map((a) => ({ ...a, id: ++id, company_id: a.company_code,
      salary_history: a.salary, allowances: a.allowances.map((x, k) => ({ ...x, id: k, payment_type_id: typeByCode.get(x.payment_type_code)?.id })) })) })) }));
  const h = buildPayHistory(wb.Sheets, people, types);
  console.log('payroll history:', JSON.stringify(h.summary));
  assert.deepEqual(h.months.map((m) => m.period.slice(0, 7)), ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
  assert.equal(h.summary.unmatched, 0);
  assert.equal(h.summary.errorRows, 0, 'Dec 2025 is before the import window; Jan–Sep have no formula errors');
  // the items rebuild the workbook's gross and net for every row
  const mism = h.months.flatMap((m) => m.lines).filter((l) => l.warnings.some((w) => /add up|recalculated/.test(w.text)));
  assert.equal(mism.length, 0, mism.map((l) => `${l.period} ${l.emp_name}: ${l.warnings.map((w) => w.text).join(' ')}`).join('\n'));
  // the RM72,500 hourly row is held back
  const held = h.months.flatMap((m) => m.lines).filter((l) => l.excluded);
  assert.equal(held.length, 1); assert.equal(held[0].period, '2026-07-01'); assert.equal(held[0].gross, 72500);
  const p = historyPayload(h.months);
  assert.equal(p.runs.length, 9);
  assert.ok(p.runs.every((r) => r.lines.every((l) => l.mode === 'fixed')));
  // engine vs workbook for September (no OT rule differences when there is no OT)
  const sep = h.months.find((m) => m.period === '2026-09-01');
  const run = buildRun({ period: '2026-09-01', people, types, typesById, tables, policies: {}, time: [], leave: [], buybacks: [] });
  const byKey = new Map(run.lines.map((l) => [`${l.employee_id}|${l.company_id}`, l]));
  let same = 0, compared = 0;
  for (const l of sep.lines) {
    const a = byKey.get(`${l.employee_id}|${l.company_id}`); if (!a) continue;
    if (lineSummary(l).overtime || lineSummary(l).unpaid) continue;
    compared++; if (!compareLines(l, a).length) same++;
  }
  console.log(`September engine vs workbook (no OT/unpaid leave): ${same} of ${compared} lines identical`);
  assert.ok(compared > 20 && same / compared > 0.8);
});

test('rehire in the same month at the same company: one line, days added together', () => {
  const a1 = { id: 21, company_id: 1, is_primary: true, salary_history: [sal(3100)], allowances: [] };
  const a2 = { id: 22, company_id: 1, is_primary: true, salary_history: [sal(3100)], allowances: [] };
  const person = { id: 2, full_name: 'REHIRED', dob: '1990-01-01', employments: [
    { ...em({ join_date: '2020-01-01', resigned_date: '2026-03-10' }), assignments: [a1] },
    { ...em({ join_date: '2026-03-20' }), assignments: [a2] }] };
  const r = buildRun({ period: '2026-03-01', people: [person], types, typesById, tables, policies: {} });
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].assignment_id, 22);
  assert.equal(amt(r.lines[0].items, 'BASIC'), 2200);            // (10 + 12) of 31 days
  assert.ok(r.lines[0].warnings.some((w) => /Two employment periods/.test(w.text)));
});

test('part-time hours go to the hourly-paid company line, overtime to the primary line', () => {
  const person = { id: 3, full_name: 'TWO JOBS', dob: '1990-01-01', employments: [{ ...em(), assignments: [
    { id: 31, company_id: 1, is_primary: true, salary_history: [sal(2000)], allowances: [] },
    { id: 32, company_id: 2, is_primary: false, salary_history: [sal(12, 'hourly')], allowances: [] }] }] };
  const r = buildRun({ period: '2026-05-01', people: [person], types, typesById, tables, policies: {},
    time: [{ employee_id: 3, category: 'PT_HOURS', hours: 20, work_date: '2026-05-01' }, { employee_id: 3, category: 'OT_NORMAL', hours: 2, work_date: '2026-05-06' }] });
  const main = r.lines.find((l) => l.company_id === 1), side = r.lines.find((l) => l.company_id === 2);
  assert.equal(amt(side.items, 'BASIC'), 240);
  assert.ok(main.items.some((i) => i.key === 'OT:OT_NORMAL')); assert.ok(!side.items.some((i) => i.category === 'overtime'));
});

test('recalculate after a leaver: automatic pay removed, typed items kept, buy-back notice', () => {
  const person = { id: 4, full_name: 'LEFT IN DEC', dob: '1990-01-01', employments: [{ ...em({ resigned_date: '2026-12-31' }),
    assignments: [{ id: 41, company_id: 1, is_primary: true, salary_history: [sal(3000)], allowances: [] }] }] };
  const old = { employee_id: 4, company_id: 1, emp_name: 'LEFT IN DEC', mode: 'auto', pcb: 0, inputs: { age: 36, flags: {} },
    items: [itemFromType(types.get('BASIC'), { key: 'BASIC', amount: 3000 }), itemFromType(types.get('BONUS'), { auto: false, amount: 500 })] };
  const r = buildRun({ period: '2027-01-01', people: [person], types, typesById, tables, policies: {}, existing: [old],
    buybacks: [{ id: 1, employee_id: 4, days: 2, buyback_pct: 50, close_year: 2026 }] });
  assert.equal(r.lines.length, 1);
  assert.deepEqual(r.lines[0].items.map((i) => i.code), ['BONUS']);
  assert.equal(r.lines[0].gross, 500);
  assert.ok(r.lines[0].warnings.some((w) => /Not employed this month/.test(w.text)));
  assert.equal(r.notices.length, 1); assert.match(r.notices[0], /not employed in January/);
});

test('history import: a second workbook row for the same person, company and month is reported, not imported twice', () => {
  const cell = (v) => ({ v, t: typeof v === 'number' ? 'n' : 's' });
  const ws = {};
  for (const r of [10, 11]) Object.assign(ws, { [`U${r}`]: cell('DUP PERSON'), [`O${r}`]: cell(46023), [`LF${r}`]: cell(2000), [`LR${r}`]: cell('N'),
    [`NH${r}`]: cell(2000), [`NN${r}`]: cell(2000), [`SB${r}`]: cell(220), [`SN${r}`]: cell(260), [`VH${r}`]: cell(1780), [`WL${r}`]: cell(1780) });
  const people = [{ id: 9, full_name: 'DUP PERSON', employments: [{ ...em(), assignments: [{ id: 91, company_id: 1, is_primary: true }] }] }];
  const h = buildPayHistory({ PayrollSMRY2026: ws }, people, types);
  assert.equal(h.summary.lines, 1);
  assert.ok(h.issues.some((i) => /second row for the same company/.test(i.message)));
});

test('marked as left with no last working day: left out of the run, with a notice', () => {
  const person = { id: 5, full_name: 'LEFT NO DATE', dob: '1990-01-01', employments: [{ ...em({ confirmation_status: 'R' }),
    assignments: [{ id: 51, company_id: 1, is_primary: true, salary_history: [sal(2500)], allowances: [] }] }] };
  const still = { id: 6, full_name: 'STILL HERE', dob: '1990-01-01', employments: [{ ...em({ confirmation_status: 'C' }),
    assignments: [{ id: 61, company_id: 1, is_primary: true, salary_history: [sal(2500)], allowances: [] }] }] };
  const confMeta = { R: { is_active_employment: false }, C: { is_active_employment: true } };
  const r = buildRun({ period: '2026-09-01', people: [person, still], types, typesById, tables, policies: {}, confMeta });
  assert.deepEqual(r.lines.map((l) => l.emp_name), ['STILL HERE']);
  assert.match(r.notices[0], /Left out: LEFT NO DATE/);
  // once the last day is entered, the dates decide: paid up to that day
  person.employments[0].resigned_date = '2026-09-04';
  const r2 = buildRun({ period: '2026-09-01', people: [person], types, typesById, tables, policies: {}, confMeta });
  assert.equal(amt(r2.lines[0].items, 'BASIC'), 333.33);   // 2500 ÷ 30 × 4
});
