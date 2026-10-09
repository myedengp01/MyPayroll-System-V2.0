import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { itemFromType, computeLine } from '../js/engines/payroll.js';
import { payslipModel, payslipSections, sumLines, summaryColumns, itemsByCode, eaFigures, eaSection, ytdRows, socsoNo } from '../js/engines/reports.js';

const typeRows = JSON.parse(readFileSync(new URL('./fixtures/payment_types.json', import.meta.url)));
const T = new Map(typeRows.map((t) => [t.code, t]));
const it = (code, amount, f = {}) => itemFromType(T.get(code), { amount, auto: false, ...f });
const line = (period, items, o = {}) => {
  const l = { period, employee_id: 1, company_id: 1, emp_name: 'TEST', emp_code: 'MEG0101F0001', items, pcb: 0, ...o };
  // statutory as typed so the test does not depend on tables
  return { ...l, ...computeLine({ ...l, mode: 'fixed', overrides: { epf_ee: 220, epf_er: 260, socso_ee: 10, socso_er: 30, eis_ee: 4, eis_er: 4 } }, { period }) };
};

test('payslip: sections, statutory, totals and year to date', () => {
  const jan = line('2026-01-01', [it('BASIC', 2000), it('TRANSPORT', 100), it('OT_NORMAL', 50), it('OT_NORMAL', 25, { label: 'Overtime (off day)' }), it('UNPAID_LEAVE', 64.52), it('LOAN', 100)], { pcb: 12.5 });
  const feb = line('2026-02-01', [it('BASIC', 2000)]);
  const s = payslipSections(jan);
  assert.deepEqual(s.earnings.map((e) => e.label), ['Basic Salary', 'Transport Allowance', 'Overtime (Normal day)', 'Overtime (off day)']);
  assert.deepEqual(s.deductions.map((e) => e.label), ['Unpaid Leave']);
  assert.deepEqual(s.personal.map((e) => e.label), ['Company Loan']);
  const m = payslipModel(feb, [jan, feb]);
  assert.equal(m.gross, 2000); assert.equal(m.statEe, 234); assert.equal(m.statEr, 294);
  assert.equal(m.totalDeductions, 234); assert.equal(m.netPaid, 1766);
  assert.equal(m.ytd.gross, r2(2110.48 + 2000)); assert.equal(m.ytd.pcb, 12.5); assert.equal(m.ytd.lines, 2);
});
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

test('sums leave out lines that were left out', () => {
  const a = line('2026-03-01', [it('BASIC', 1000)]); const b = { ...line('2026-03-01', [it('BASIC', 500)]), excluded: true };
  assert.equal(sumLines([a, b]).gross, 1000); assert.equal(sumLines([a, b]).lines, 1);
});

test('monthly summary columns follow the workbook order', () => {
  const a = line('2026-03-01', [it('OT_NORMAL', 10), it('BASIC', 1000), it('BONUS', 100), it('LEADER', 50)]);
  assert.deepEqual(summaryColumns([a], T).map((c) => c.code), ['BASIC', 'LEADER', 'BONUS', 'OT_NORMAL']);
  assert.deepEqual(itemsByCode(a), { OT_NORMAL: 10, BASIC: 1000, BONUS: 100, LEADER: 50 });
});

test('EA form: sections B1(a)(b)(c), exempt items in F, PCB, EPF and PERKESO (SOCSO + EIS)', () => {
  assert.equal(eaSection(it('BASIC', 1)), '1a'); assert.equal(eaSection(it('OT_PH', 1)), '1a'); assert.equal(eaSection(it('AL_BUYBACK', 1)), '1a');
  assert.equal(eaSection(it('UNPAID_LEAVE', 1)), '1a'); assert.equal(eaSection(it('COMMISSION', 1)), '1b'); assert.equal(eaSection(it('BONUS', 1)), '1b');
  assert.equal(eaSection(it('LEADER', 1)), '1c'); assert.equal(eaSection(it('ANG_BAO', 1)), '1c'); assert.equal(eaSection(it('LOAN', 1)), null);
  const exempt = { ...it('TRANSPORT', 200), pcb_subject: false };
  assert.equal(eaSection(exempt), 'F');
  const jan = line('2026-01-01', [it('BASIC', 3000), it('OT_NORMAL', 100), it('UNPAID_LEAVE', 100), it('BONUS', 500), it('LEADER', 300), exempt, it('CHILDCARE', 50)], { pcb: 40 });
  const feb = line('2026-02-01', [it('BASIC', 3000), it('COMMISSION', 250)], { pcb: 40 });
  const other = { ...line('2026-02-01', [it('BASIC', 800)]), company_id: 2 };
  const ea = eaFigures([jan, feb, other]);
  assert.equal(ea.length, 2);                         // one EA per paying company
  const e = ea.find((x) => x.company_id === 1);
  assert.equal(e.b1a, 6000); assert.equal(e.b1b, 750); assert.equal(e.b1c, 300); assert.equal(e.f_exempt, 200);
  assert.equal(e.totalB, 7050); assert.equal(e.d1_pcb, 80);
  assert.equal(e.e1_epf, 440); assert.equal(e.e2_perkeso, 28);
  assert.equal(e.months, 2); assert.equal(e.firstPeriod, '2026-01-01'); assert.equal(e.lastPeriod, '2026-02-01');
  assert.ok(e.balanced, 'B + F equals gross pay');
});

test('year to date per employee per company; SOCSO number falls back to NRIC digits', () => {
  const a = line('2026-01-01', [it('BASIC', 1000)]); const b = line('2026-02-01', [it('BASIC', 1100)]);
  const y = ytdRows([a, b]);
  assert.equal(y.length, 1); assert.equal(y[0].months, 2); assert.equal(y[0].gross, 2100);
  assert.equal(socsoNo({ nric: '900101-01-1234' }), '900101011234'); assert.equal(socsoNo({ socso_no: 'X1', nric: '9' }), 'X1');
});
