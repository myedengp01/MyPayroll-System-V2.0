// SOCSO employee share split into invalidity + non-employment injury (NEI), and shares shown separately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareTables, computeSOCSO, splitSocsoTotal } from '../js/engines/statutory.js';
import { computeLine, runTotals, statVal, STAT_COLS } from '../js/engines/payroll.js';
import { payslipModel, sumLines } from '../js/engines/reports.js';

const tables = prepareTables(JSON.parse(readFileSync(new URL('fixtures/stat_tables.json', import.meta.url))));
const basic = (amount) => ({ code: 'BASIC', kind: 'earning', category: 'basic', amount, auto: true, epf: true, socso: true, eis: true });
const stat = (period, extra = {}) => ({ age: 30, statClass: 'MY', period, flags: {}, tables, ...extra });

test('SOCSO table split: from June 2026 the employee share is invalidity + NEI; before June it is all invalidity', () => {
  const jul = computeSOCSO(tables, { wage: 2150, age: 30, periodDate: '2026-07-01' });
  assert.equal(jul.ee, 26.9); assert.equal(jul.nei, 16.15); assert.equal(jul.inv, 10.75);
  const opt = computeSOCSO(tables, { wage: 2150, age: 30, periodDate: '2026-07-01', neiOptOut: true });
  assert.equal(opt.ee, 10.75); assert.equal(opt.nei, 0);
  const may = computeSOCSO(tables, { wage: 2150, age: 30, periodDate: '2026-05-01' });
  assert.equal(may.nei, 0); assert.equal(may.inv, may.ee);
  const old = computeSOCSO(tables, { wage: 2150, age: 62, periodDate: '2026-07-01' });   // 60+: employee pays NEI only
  assert.equal(old.nei, old.ee);
});

test('pay line keeps the NEI part; invalidity = employee SOCSO − NEI', () => {
  const l = computeLine({ items: [basic(2150)], overrides: {} }, stat('2026-07-01'));
  assert.equal(l.socso_ee, 26.9); assert.equal(l.socso_ee_nei, 16.15); assert.equal(statVal(l, 'socso_ee_inv'), 10.75);
  const o = computeLine({ items: [basic(2150)], overrides: {} }, stat('2026-07-01', { flags: { socso_nei_opt_out: true } }));
  assert.equal(o.socso_ee, 10.75); assert.equal(o.socso_ee_nei, 0);
  const off = computeLine({ items: [basic(2150)], overrides: {} }, stat('2026-07-01', { flags: { socso_ee: false } }));
  assert.equal(off.socso_ee, 0); assert.equal(off.socso_ee_nei, 0);
});

test('two boxes: typing one part keeps the other at the table amount', () => {
  const a = computeLine({ items: [basic(2150)], overrides: { socso_ee_nei: 5 } }, stat('2026-07-01'));
  assert.equal(a.socso_ee_nei, 5); assert.equal(statVal(a, 'socso_ee_inv'), 10.75); assert.equal(a.socso_ee, 15.75);
  const b = computeLine({ items: [basic(2150)], overrides: { socso_ee_inv: 12 } }, stat('2026-07-01'));
  assert.equal(b.socso_ee, 28.15); assert.equal(b.socso_ee_nei, 16.15);
  assert.equal(b.net, Math.round((2150 - b.epf_ee - b.socso_ee - b.eis_ee) * 100) / 100);
});

test('a recorded SOCSO total (imported / typed before the split) is divided using the table', () => {
  const full = computeLine({ items: [basic(2150)], overrides: { socso_ee: 26.9 } }, stat('2026-07-01'));
  assert.equal(full.socso_ee_nei, 16.15);
  const invOnly = computeLine({ items: [basic(2150)], overrides: { socso_ee: 10.75 } }, stat('2026-07-01'));
  assert.equal(invOnly.socso_ee_nei, 0);
  const fixed = computeLine({ mode: 'fixed', items: [basic(2150)], overrides: { socso_ee: 26.9, socso_ee_nei: 16.15 } }, { period: '2026-07-01', flags: {} });
  assert.equal(fixed.socso_ee, 26.9); assert.equal(fixed.socso_ee_nei, 16.15);
  assert.deepEqual(splitSocsoTotal(tables, { wage: 2150, periodDate: '2026-07-01', total: 26.9 }), { nei: 16.15, matched: true, variant: 'CAT1' });
  assert.equal(splitSocsoTotal(tables, { wage: 2150, periodDate: '2026-07-01', total: 10.75 }).nei, 0);
  assert.equal(splitSocsoTotal(tables, { wage: 2150, periodDate: '2026-03-01', total: 10.75 }).nei, 0);
  assert.equal(splitSocsoTotal(tables, { wage: 2150, periodDate: '2026-07-01', total: 13.33 }).matched, false);
  assert.equal(splitSocsoTotal(tables, { wage: 500.0000000003, periodDate: '2026-07-01', total: computeSOCSO(tables, { wage: 500, age: 30, periodDate: '2026-07-01' }).ee }).matched, true);
});

test('totals, payslip and report columns show every share on its own', () => {
  const a = computeLine({ items: [basic(2150)], overrides: {} }, stat('2026-07-01'));
  const b = computeLine({ items: [basic(3000)], overrides: {} }, stat('2026-07-01', { flags: { socso_nei_opt_out: true } }));
  const T = runTotals([{ ...a, company_id: 1 }, { ...b, company_id: 1 }]).all;
  assert.equal(T.socso_ee_nei, 16.15);
  assert.equal(statVal(T, 'socso_ee_inv'), Math.round((T.socso_ee - 16.15) * 100) / 100);
  assert.deepEqual(STAT_COLS.map((c) => c[0]), ['epf_ee', 'epf_er', 'socso_ee_inv', 'socso_ee_nei', 'socso_er', 'eis_ee', 'eis_er']);
  const m = payslipModel(a, [a]);
  const socso = m.statutory.filter((s) => s.label.startsWith('SOCSO'));
  assert.deepEqual(socso.map((s) => s.ee), [10.75, 16.15]);
  assert.equal(socso[1].er, null);
  assert.equal(m.statEe, Math.round((a.epf_ee + a.socso_ee + a.eis_ee) * 100) / 100);
  assert.equal(m.statEr, Math.round((a.epf_er + a.socso_er + a.eis_er) * 100) / 100);
  assert.equal(sumLines([a, b]).socso_ee_nei, 16.15);
});
