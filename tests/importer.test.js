// Runs the importer against the REAL workbook. The workbook holds personal data, so it is never in the repo:
//   EPPD_WORKBOOK=/path/to/MEG_EPPD_2026....xlsm npm test
// Skipped automatically when the variable is not set or SheetJS is not installed (npm install).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildImport } from '../js/engines/importer.js';

const path = process.env.EPPD_WORKBOOK;
let XLSX = null;
try { XLSX = createRequire(import.meta.url)('xlsx'); } catch { /* not installed */ }
const skip = !path || !existsSync(path) || !XLSX ? 'set EPPD_WORKBOOK and run npm install to test against the real workbook' : false;

test('workbook import: counts, ID conflicts, salary history vs what payroll paid', { skip }, () => {
  const wb = XLSX.read(readFileSync(path), { sheets: ['StaffPersonalData', 'PayrollSMRY2026'] });
  const ref = JSON.parse(readFileSync(new URL('./fixtures/reference_seed.json', import.meta.url)));
  const res = buildImport(wb.Sheets, ref, { defaultCompanyCode: 'MEG', today: '2026-10-09' });
  const s = res.summary;
  assert.equal(s.staffRows, 187);
  assert.equal(s.people, 184);                       // 3 rehires merged
  assert.equal(s.employments, 187);
  assert.equal(s.current, 35);                       // employment status not Resigned/Terminated/Dismissed
  assert.equal(s.defaultCompanyCurrent, 8);          // current staff with no company in the workbook
  assert.equal(res.conflicts.length, 3);             // three IDs shared by two different people
  const ids = res.payload.people.map((p) => p.emp_id).filter(Boolean);
  assert.equal(new Set(ids.map((x) => x.toUpperCase())).size, ids.length, 'IDs must be unique after import');
  const aulia = res.payload.people.find((p) => p.full_name === 'AULIA CHRISTANTI');
  assert.equal(aulia.emp_id, 'MEG0325F0118');        // current employee keeps the ID on her payslips
  assert.equal(aulia.employments[0].join_date, '2025-03-03');
  // salary history reproduces what the workbook paid in all but 3 known months
  console.log(`payroll months matched: ${s.payrollMatched} / ${s.payrollMonthsChecked}`);
  const bad = res.issues.filter((i) => i.code === 'payroll_mismatch').map((i) => i.message);
  assert.deepEqual(bad.map((m) => m.split(':')[0]).sort(), ['ANG WEN ZHE, 2026-03', 'HONG MEI LING, 2026-07', 'PIONG RUI GEN, 2026-07']);
  const after = res.issues.filter((i) => i.code === 'paid_after_last_day').map((i) => i.person);
  assert.ok(after.includes('CHAN PEI KUAN'), 'Chan Pei Kuan was paid after her recorded last day');
  // every row must satisfy the database's date rules
  for (const p of res.payload.people) for (const e of p.employments) for (const a of e.assignments) {
    if (a.start_date && a.end_date) assert.ok(a.end_date >= a.start_date, `${p.full_name} assignment dates`);
    for (const al of a.allowances) if (al.start_date && al.end_date) assert.ok(al.end_date >= al.start_date, `${p.full_name} allowance dates`);
    assert.equal(new Set(a.salary.map((x) => x.effective_from)).size, a.salary.length, `${p.full_name} salary dates unique`);
  }
});
