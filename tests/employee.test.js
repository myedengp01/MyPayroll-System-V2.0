import { test } from 'node:test';
import assert from 'node:assert/strict';
import { excelSerialToIso, excelFractionToTime, serviceLength, formatService, normaliseNric, socsoFromNric,
         dobFromNric, salaryForMonth, allowancesForMonth, employmentStatus, lastDayOfMonth, ageOn } from '../js/engines/employee.js';
import { parseEmpId, serialOf, formatEmpId, nextSerial, auditIds } from '../js/engines/eid.js';

test('Excel serials convert without timezone shift', () => {
  assert.equal(excelSerialToIso(45719), '2025-03-03');      // Aulia's join date (not 2 Mar)
  assert.equal(excelSerialToIso(43313), '2018-08-01');      // the date SheetJS turned into 31 Jul
  assert.equal(excelFractionToTime(0.375), '09:00');
  assert.equal(excelFractionToTime(0.791666666666667), '19:00');
  assert.equal(excelFractionToTime(0), null);
});

test('service length, age, month ends', () => {
  assert.deepEqual(serviceLength('2024-11-18', '2026-10-09'), { years: 1, months: 10, days: 21 });
  assert.equal(formatService(serviceLength('2026-09-14', '2026-10-09')), '25 days');
  assert.equal(ageOn('1974-08-16', '2026-10-09'), 52);
  assert.equal(lastDayOfMonth('2028-02-10'), '2028-02-29');
});

test('NRIC helpers', () => {
  assert.equal(normaliseNric('740817615020'), '740817-61-5020');
  assert.equal(normaliseNric('n/a'), null);
  assert.equal(socsoFromNric('740817-61-5020'), '740817615020');
  assert.equal(dobFromNric('040511-01-0742', '2026-10-09'), '2004-05-11');
  assert.equal(dobFromNric('631119-01-5092', '2026-10-09'), '1963-11-19');
});

test('salary for a month = record in force on the last day of the month', () => {
  const h = [{ effective_from: '2025-03-03', amount: 1800 }, { effective_from: '2025-06-30', amount: 1900 }, { effective_from: '2026-05-31', amount: 2050 }];
  assert.equal(salaryForMonth(h, '2025-06-01').amount, 1900);   // increment on the 30th applies to June
  assert.equal(salaryForMonth(h, '2026-05-01').amount, 2050);
  assert.equal(salaryForMonth(h, '2025-02-01'), null);
});

test('allowances payable in a month', () => {
  const a = [{ amount: 50, start_date: '2025-03-03', end_date: '2026-07-31' }, { amount: 600, start_date: null, end_date: null }];
  assert.equal(allowancesForMonth(a, '2026-07-01').length, 2);
  assert.equal(allowancesForMonth(a, '2026-08-01').length, 1);
});

test('employment status', () => {
  const conf = { C: { label: 'Confirmed', is_active_employment: true }, R: { label: 'Resigned', is_active_employment: false } };
  assert.equal(employmentStatus({ confirmation_status: 'C' }, conf, '2026-10-09').key, 'current');
  assert.equal(employmentStatus({ confirmation_status: 'C', resignation_letter_date: '2026-09-21', resigned_date: '2026-10-19' }, conf, '2026-10-09').key, 'notice');
  assert.equal(employmentStatus({ confirmation_status: 'C', resigned_date: '2026-09-30' }, conf, '2026-10-09').key, 'former');
  assert.equal(employmentStatus({ confirmation_status: 'R' }, conf, '2026-10-09').label, 'Resigned');
});

test('Employee ID format and running number', () => {
  assert.deepEqual(parseEmpId('MEG0325F0118'), { prefix: 'MEG', mm: '03', yy: '25', gender: 'F', serial: 118, hasRealMonth: true });
  assert.equal(serialOf('MEG0000M1000'), null);     // directors' IDs do not count
  assert.equal(serialOf('HD0626M0149'), 149);       // HD prefix shares the group sequence
  assert.equal(formatEmpId({ prefix: 'HD', joinDate: '2026-10-09', gender: 'm', serial: 164 }), 'HD1026M0164');
  assert.equal(nextSerial([1, 160, 149, null]), 161);
  const a = auditIds([
    { emp_id: 'MEG0325F0118', join_date: '2025-03-03', gender: 'F' }, { emp_id: 'meg0325f0118', join_date: '2025-03-03', gender: 'F' },
    { emp_id: 'MEG0324F0081', join_date: '2026-03-11', gender: 'M' }, { emp_id: null }, { emp_id: 'N/A' }]);
  assert.equal(a.duplicates.length, 1);
  assert.equal(a.monthMismatch.length, 1);
  assert.equal(a.genderMismatch.length, 1);
  assert.equal(a.missing.length, 1);
  assert.equal(a.badFormat.length, 1);
  assert.equal(a.nextSerial, 119);
});
