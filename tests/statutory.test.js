// Run: npm test   (or: node --test tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { prepareTables, lookupBracket, pickVersion, computeEPF, computeSOCSO, computeEIS,
         statutoryBases, roundAmount } from '../js/engines/statutory.js';

const here = new URL('./fixtures/', import.meta.url);
const tables = prepareTables(JSON.parse(readFileSync(new URL('stat_tables.json', here))));

test('version picking by effective date', () => {
  assert.equal(pickVersion(tables, 'SOCSO', 'CAT1', '2026-05-01').effective_from, '2022-09-01');
  assert.equal(pickVersion(tables, 'SOCSO', 'CAT1', '2026-06-01').effective_from, '2026-06-01');
  assert.equal(pickVersion(tables, 'EPF', 'FOREIGN', '2025-09-01'), null);
});

test('Excel-style approximate bracket match', () => {
  const v = pickVersion(tables, 'EIS', 'STD', '2026-01-01');
  assert.equal(lookupBracket(v.brackets, 994.5).wage_min, 900.01);
  assert.equal(lookupBracket(v.brackets, 9999).wage_min, 6000.01); // ceiling row
});

test('known workbook values (Sep 2026, wage 994.50)', () => {
  const p = { wage: 994.5, age: 30, statClass: 'MY', periodDate: '2026-09-01' };
  assert.deepEqual([computeEPF(tables, p).ee, computeEPF(tables, p).er], [110, 130]);
  const s = computeSOCSO(tables, { ...p, neiOptOut: true });
  assert.deepEqual([s.ee, s.er], [4.75, 16.65]);
  const e = computeEIS(tables, p);
  assert.deepEqual([e.ee, e.er], [1.9, 1.9]);
});

test('EPF above RM20,000 uses % rule, rounded up to the ringgit', () => {
  const r = computeEPF(tables, { wage: 25000.4, age: 40, statClass: 'MY', periodDate: '2026-09-01' });
  assert.equal(r.aboveMax, true);
  assert.deepEqual([r.er, r.ee], [3001, 2751]);
});

test('EIS exemptions only apply when switched on', () => {
  const p = { wage: 3000, age: 61, statClass: 'FR', periodDate: '2026-09-01' };
  assert.ok(computeEIS(tables, p).ee > 0);
  assert.equal(computeEIS(tables, p, { eis_exempt_age_60_plus: true }).ee, 0);
});

test('statutory bases follow payment-type switches', () => {
  const T = (kind, e, s, i) => ({ kind, subject_epf: e, subject_socso: s, subject_eis: i });
  const b = statutoryBases([
    { amount: 2000, type: T('earning', 1, 1, 1) },   // basic
    { amount: 300,  type: T('earning', 1, 0, 0) },   // bonus
    { amount: 100,  type: T('earning', 0, 0, 0) },   // ang bao
    { amount: 150,  type: T('earning', 0, 1, 1) },   // OT
    { amount: 50,   type: T('deduction', 1, 1, 1) }, // unpaid leave
  ]);
  assert.deepEqual(b, { epf: 2250, socso: 2100, eis: 2100 });
  assert.equal(roundAmount(12.01, 'up_ringgit'), 13);
});

// ---- Golden test against every Dec 2025 – Sep 2026 row of PayrollSMRY2026 ----
// The fixture holds real salary figures, so it is git-ignored (never pushed).
const goldenPath = new URL('golden_payroll_rows.json', here);
test('golden: engine reproduces workbook EPF/SOCSO/EIS row by row', { skip: !existsSync(goldenPath) }, () => {
  const rows = JSON.parse(readFileSync(goldenPath));
  const mism = [];
  for (const r of rows) {
    const i = r.inp, exp = r.exp;
    const statClass = i.X === 'FR' ? 'FR' : (i.X === 'PR' ? 'PR' : 'MY');
    const base = { age: i.AA, statClass, periodDate: r.month };
    const epf = computeEPF(tables, { ...base, wage: i.RS });
    const socWage = i.NN - i.PJ - i.PP - i.PV - i.QB - i.RD - i.RJ;
    const soc = computeSOCSO(tables, { ...base, wage: socWage, neiOptOut: i.TM === 'Y' });
    const eisWage = i.NN - i.PJ - i.PP - i.PV - i.QB - i.RD;
    const eis = computeEIS(tables, { ...base, wage: eisWage });
    const got = {
      SB: i.RV === 'N' ? 0 : epf.ee, SN: i.SH === 'N' ? 0 : epf.er,
      SZ: i.ST === 'N' ? 0 : soc.ee, TL: i.TF === 'N' ? 0 : soc.er,
      TX: i.TR === 'N' ? 0 : eis.ee, UJ: i.UD === 'N' ? 0 : eis.er,
    };
    for (const k of Object.keys(got)) {
      if (Math.abs(got[k] - exp[k]) > 0.005) mism.push({ row: r.row, month: r.month, col: k, got: got[k], exp: exp[k], age: Math.floor(i.AA), cls: statClass });
    }
  }
  // Known WORKBOOK issues (the engine is right; the sheet is not):
  //  A) Jan 2026 rows: employer SOCSO (TL) formula omitted "-RJ", so Cash Ang Bao was
  //     included in the employer base but excluded from the employee base (SZ).
  //  B) Row 295 (Jul 2026, part-time): hourly flag = Y with rate 1000 x 72.5 hrs
  //     = RM72,500 gross. Workbook EPF capped at the RM20,000 bracket; engine applies 11%/12%.
  const known = (m) => (m.month === '2026-01-01' && m.col === 'TL') || m.row === 295;
  const unexplained = mism.filter((m) => !known(m));
  if (unexplained.length) console.log('UNEXPLAINED', JSON.stringify(unexplained, null, 1));
  console.log(`golden rows: ${rows.length} x 6 values = ${rows.length * 6}; ` +
              `known workbook issues: ${mism.length - unexplained.length}; unexplained: ${unexplained.length}`);
  assert.equal(unexplained.length, 0);
});
