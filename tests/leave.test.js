import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { edate, countedMonths, alEntitlement, countLeaveDays, slEntitlement, proRate, leaveBalances, closeYearFor, halfUp } from '../js/engines/leave.js';
import { classifyOtcfLine, otcfToEntries, normalHours, otcfDate, normaliseName } from '../js/engines/ot.js';

const BANDS = [{ until_months: 24, days: 8 }, { until_months: 60, days: 12 }, { until_months: null, days: 16 }];
const POL = {
  al_entitlement: { bands: BANDS },
  leave_rules: { SL: { bands: [{ until_years: 2, days: 14 }, { until_years: 5, days: 18 }, { until_years: null, days: 22 }] }, HPL: { days: 60, includes_sick_leave: true },
                 MTL: { days: 98, gender: 'F' }, PTL: { days: 7, gender: 'M', min_service_months: 12 }, CPL: { per_occasion: 2, per_year: 4 } },
  part_time: { full_time_weekly_hours: 45, prorate: ['AL', 'SL'] },
};
const CF = { confirmed_only: true, grades: { E: 6, S: 3, A: 1, I: 0, U: 0 }, buyback_grades: ['E', 'S', 'A'], buyback_options: [50, 25, 10], expiry: null };

test('EDATE clamps to month end', () => {
  assert.equal(edate('2024-01-31', 1), '2024-02-29');
  assert.equal(edate('2021-02-19', 60), '2026-02-19');
});

test('counted months (v.042026) and the older formula', () => {
  assert.equal(countedMonths('2026-01-01', '2026-12-31'), 12);
  assert.equal(countedMonths('2026-03-20', '2026-12-31'), 9);     // starts after the 15th
  assert.equal(countedMonths('2026-12-10', '2026-12-31'), 1);     // same month: 1
  assert.equal(countedMonths('2026-12-10', '2026-12-31', { legacy: true }), 2); // old formula over-counts
  assert.equal(countedMonths('2026-04-16', '2026-04-17'), 0);
});

test('annual leave entitlement (workbook AL calculator)', () => {
  assert.equal(alEntitlement({ joinDate: '2025-03-03', bands: BANDS, year: 2026 }).days, 8);          // Aulia
  assert.equal(alEntitlement({ joinDate: '2024-05-05', bands: BANDS, year: 2026 }).days, 11);         // band change in May: 4/12*8 + 8/12*12
  assert.equal(alEntitlement({ joinDate: '2021-02-19', bands: BANDS, year: 2026 }).days, 15);         // reaches 5 years on 19 Feb (workbook block-8 bug gave 12)
  assert.equal(alEntitlement({ joinDate: '2026-09-14', resignDate: '2026-09-30', bands: BANDS, year: 2026 }).days, 1);
  assert.equal(halfUp(6.5), 7); assert.equal(halfUp(6.49), 6);
});

test('leave days skip Saturday, Sunday and public holidays', () => {
  const holidays = new Set(['2026-10-20']);
  assert.equal(countLeaveDays('2026-10-16', '2026-10-21', { holidays }), 3);   // Fri, Mon, (Tue PH), Wed
  assert.equal(countLeaveDays('2026-10-16', '2026-10-16', { halfDay: 'am' }), 0.5);
  assert.equal(countLeaveDays('2026-10-17', '2026-10-18', {}), 0);              // weekend
  assert.equal(countLeaveDays('2026-10-01', '2027-01-06', { calendar: true }), 98);
});

test('EA sick leave bands, part-time pro-rating', () => {
  assert.equal(slEntitlement('2025-03-03', '2026-10-09'), 14);
  assert.equal(slEntitlement('2024-05-05', '2026-10-09'), 18);
  assert.equal(slEntitlement('2018-01-01', '2026-10-09'), 22);
  assert.equal(proRate(12, 22.5, POL.part_time), 6);
  assert.equal(proRate(12, null, POL.part_time), null);
});

test('balances: carried days used first, then lapse at expiry; HPL shares the 60-day pool', () => {
  const b = leaveBalances({
    employment: { join_date: '2020-01-01', job_status: 'FT' }, gender: 'F', year: 2026, asOf: '2026-10-09', policies: POL,
    records: [{ leave_type: 'AL', date_from: '2026-02-10', days: 2 }, { leave_type: 'AL', date_from: '2026-08-01', days: 3 },
              { leave_type: 'SL', date_from: '2026-05-01', days: 4 }, { leave_type: 'HPL', date_from: '2026-06-01', days: 10 },
              { leave_type: 'AL', date_from: '2026-09-01', days: 1, status: 'cancelled' }],
    adjustments: [{ leave_type: 'AL', year: 2026, kind: 'carry_forward', days: 6, expires_on: '2026-06-30' }],
  });
  assert.equal(b.AL.entitled, 16);
  assert.equal(b.AL.carriedExpired, 4);                 // 6 carried, only 2 used before 30 Jun
  assert.equal(b.AL.balance, 16 + 6 - 4 - 5);
  assert.equal(b.SL.balance, 22 - 4);
  assert.equal(b.HPL.balance, 60 - 10 - 4);
});

test('year-end close by KPI grade (confirmed staff only)', () => {
  const e = closeYearFor({ employee_id: 1, confirmed: true, grade: 'E', balance: 10 }, CF, 2026, { buybackPct: 50 });
  assert.deepEqual([e.carry, e.buyback, e.buybackPct, e.forfeit], [6, 4, 50, 0]);
  assert.equal(e.adjustments.find((a) => a.kind === 'carry_forward').year, 2027);
  const a = closeYearFor({ employee_id: 2, confirmed: true, grade: 'A', balance: 3 }, CF, 2026, {});
  assert.deepEqual([a.carry, a.buyback, a.forfeit], [1, 0, 2]);          // no buy-back chosen -> forfeited
  const i = closeYearFor({ employee_id: 3, confirmed: true, grade: 'I', balance: 5 }, CF, 2026, { buybackPct: 50 });
  assert.deepEqual([i.carry, i.buyback, i.forfeit], [0, 0, 5]);          // I/U cannot be bought back
  const p = closeYearFor({ employee_id: 4, confirmed: false, grade: 'E', balance: 5 }, CF, 2026, { buybackPct: 50 });
  assert.deepEqual([p.carry, p.buyback, p.forfeit], [0, 0, 5]);          // probation: nothing carried
  const x = closeYearFor({ employee_id: 5, confirmed: true, grade: 'S', balance: 2 }, { ...CF, expiry: '06-30' }, 2026);
  assert.equal(x.adjustments[0].expires_on, '2027-06-30');
});

test('OTCF lines -> Employment Act categories', () => {
  assert.equal(normalHours({ work_from: '08:00', work_to: '18:00', meal_hours: 1 }), 9);
  assert.deepEqual(classifyOtcfLine({ claimType: 'Normal', actualHrs: '2.5' }, 9), [{ category: 'OT_NORMAL', hours: 2.5 }]);
  assert.deepEqual(classifyOtcfLine({ claimType: 'Off Day', actualHrs: 5 }, 9), [{ category: 'OT_OFFDAY', hours: 5 }]);
  assert.deepEqual(classifyOtcfLine({ claimType: 'Rest Day', actualHrs: 4 }, 9), [{ category: 'RD_HALF', hours: 4 }]);
  assert.deepEqual(classifyOtcfLine({ claimType: 'Rest Day', actualHrs: 11 }, 9), [{ category: 'RD_FULL', hours: 9 }, { category: 'RD_EXCESS', hours: 2 }]);
  assert.deepEqual(classifyOtcfLine({ claimType: 'Normal', ph: true, actualHrs: 10 }, 9), [{ category: 'PH_NORMAL', hours: 9 }, { category: 'PH_EXCESS', hours: 1 }]);
  assert.equal(otcfDate('7', 2026, 9), '2026-09-07');
  assert.equal(normaliseName('  lee  ah-mei '), 'LEE AH MEI');
  const r = otcfToEntries([{ id: 9, serial_no: 'OT-1', emp_name: 'Aulia', month: 9, year: 2026, line_items: [{ date: '5', claimType: 'Rest Day', actualHrs: '6' }, { date: '6', claimType: '', actualHrs: '' }] },
                           { id: 10, emp_name: 'Nobody', month: 9, year: 2026, line_items: [] }],
    (n) => (normaliseName(n) === 'AULIA' ? { id: 1 } : null), () => 9);
  assert.equal(r.entries.length, 1); assert.equal(r.entries[0].category, 'RD_FULL'); assert.equal(r.unmatched.length, 1);
});

// ---- real workbook (personal data; never in the repo): EPPD_WORKBOOK=/path/to/file.xlsm npm test ----
const path = process.env.EPPD_WORKBOOK;
let XLSX = null; try { XLSX = createRequire(import.meta.url)('xlsx'); } catch { /* not installed */ }
const skip = !path || !existsSync(path) || !XLSX ? 'set EPPD_WORKBOOK and run npm install to test against the real workbook' : false;

test('workbook: AL engine reproduces the automatic AL column; leave taken reconciles with payroll', { skip }, async () => {
  const wb = XLSX.read(readFileSync(path), { sheets: ['StaffPersonalData', 'ALMC_PT_2025', 'PayrollSMRY2026'] });
  const s = wb.Sheets.StaffPersonalData; const iso = (v) => (typeof v === 'number' ? new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 864e5).toISOString().slice(0, 10) : null);
  let match = 0; const mism = [];
  for (let r = 6; r <= 330; r++) {
    const gb = s['GB' + r]?.v; const join = iso(s['CD' + r]?.v);
    if (!s['B' + r]?.v || !join || typeof gb !== 'number') continue;
    const got = alEntitlement({ joinDate: join, resignDate: iso(s['CS' + r]?.v), bands: BANDS, year: 2026, legacy: true }).days;
    if (got === gb) match++; else mism.push(String(s['B' + r].v).trim());
  }
  console.log(`AL engine vs workbook auto-AL (2026): ${match} match, mismatches: ${mism.join(', ') || 'none'}`);
  // the only difference is the workbook's own copy-paste bug in period block 8 (column LO reads KX instead of LP)
  assert.equal(mism.length, 1, 'only the known workbook copy-paste row (period block 8) should differ');

  const { buildLeaveImport } = await import('../js/engines/leaveimport.js');
  const emps = []; const seen = new Set(); let id = 1;
  for (let r = 6; r <= 330; r++) {
    const n = s['B' + r]?.v; if (!n) continue;
    const name = String(n).toUpperCase().replace(/\s*\((OLD|1ST EMPLOYED)\)\s*$/i, '').trim();
    if (seen.has(name)) continue; seen.add(name);
    emps.push({ id: id++, full_name: name, employment: { join_date: iso(s['CD' + r]?.v), resigned_date: iso(s['CS' + r]?.v) } });
  }
  const res = buildLeaveImport(wb.Sheets, emps, POL, { year: 2026 });
  console.log(`leave import: ${res.summary.records} records, ${res.summary.adjustments} adjustments, ${res.summary.time} time entries; AL taken matches payroll for ${res.summary.takenMatches}/${res.summary.reconRows}`);
  assert.equal(res.summary.takenMatches, res.summary.reconRows);
  assert.ok(res.summary.reconRows >= 30);
});
