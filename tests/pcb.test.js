import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePCB, roundPcb, annualTax, pcbPolicy, taxablePay, pcbYtd } from '../js/engines/pcb.js';

const pol = (o = {}) => ({ socso_relief: false, ...o });
const base = { month: 1, profile: { category: 1 }, ytd: {}, Y1: 5000, Yt: 0, epfEe: 550, epf1: 5000, epft: 0, socsoEis: 0, zakat: 0 };

test('rounding: cut to 2 decimals, up to the next 5 sen', () => {
  assert.equal(roundPcb(123.023), 123.05); assert.equal(roundPcb(123.06), 123.1); assert.equal(roundPcb(110), 110); assert.equal(roundPcb(-3), 0);
});

test('tax table: rebate in B up to RM35,000; category 2 double rebate', () => {
  const p = pcbPolicy();
  assert.equal(annualTax(5000, 1, p).tax, 0);
  assert.equal(annualTax(20000, 1, p).tax, 0);                 // 150 − 400 → 0
  assert.equal(Math.round(annualTax(35000, 1, p).tax), 200);    // 600 − 400
  assert.equal(Math.round(annualTax(35000.01, 1, p).tax), 600); // rebate gone above 35,000
  assert.equal(Math.round(annualTax(100000, 2, p).tax), 9400);
});

test('single, RM5,000 a month, January: RM110.00', () => {
  // K2 = (4000 − 550) ÷ 11 = 313.64; P = (5000 − 550) + (5000 − 313.64) × 11 − 9000 = 47,000.00 → tax 1,320.00 → ÷ 12
  const r = computePCB({ ...base, policy: pol() });
  assert.equal(r.P, 47000); assert.equal(r.pcb, 110);
});

test('category 2 (spouse not working) and children reduce PCB; category 3 = single rates', () => {
  const c2 = computePCB({ ...base, profile: { category: 2, children: 2 }, policy: pol() });
  // P = 47,000 − 4,000 − 4,000 = 39,000 → tax 840.00 → 70.00
  assert.equal(c2.pcb, 70);
  const c3 = computePCB({ ...base, profile: { category: 3 }, policy: pol() });
  assert.equal(c3.pcb, 110);
});

test('later in the year it uses what was paid so far; EPF relief stops at the yearly cap', () => {
  const r = computePCB({ ...base, month: 7, ytd: { Y: 30000, K: 3300, X: 660, Z: 0, LP: 0 }, policy: pol() });
  // K capped: K = 3300, K1 = 550, K2 = min(550, 150/5) = 30
  assert.equal(r.epf.K2, 30);
  // P = (30000 − 3300) + (5000 − 550) + (5000 − 30) × 5 − 9000 = 46,999.99 → tax 1,319.9994; (1,319.9994 − 660) ÷ 6 = 109.99… → 110.00
  assert.equal(r.pcb, 110);
});

test('bonus: normal PCB unchanged, extra PCB on the additional pay', () => {
  const r = computePCB({ ...base, Yt: 5000, epfEe: 1100, epf1: 5000, epft: 5000, policy: pol() });
  assert.equal(r.normal, 110);
  // Kt = 550, K2' = (4000 − 1100) ÷ 11 = 263.64 → total EPF relief stays at the RM4,000 cap
  // P' = 4,450 + (5000 − 263.64) × 11 + 4,450 − 9,000 = 52,000 → tax 1,720.00 → additional = 1,720 − 110 × 12 = 400.00
  assert.equal(r.Padd, 52000); assert.equal(r.additional, 400); assert.equal(r.pcb, 510);
});

test('below RM10 is not deducted; zakat comes off; non-resident flat 30%', () => {
  assert.equal(computePCB({ ...base, Y1: 3000, epfEe: 330, epf1: 3000, policy: pol() }).pcb, 0);   // tiny PCB
  const z = computePCB({ ...base, zakat: 50, policy: pol() });
  assert.equal(z.gross_pcb, 110); assert.equal(z.pcb, 60);
  assert.equal(computePCB({ ...base, profile: { resident: false }, policy: pol() }).pcb, 1500);
});

test('SOCSO + EIS relief (capped RM350 a year) lowers PCB slightly', () => {
  const r = computePCB({ ...base, socsoEis: 34.55, policy: pol({ socso_relief: true }) });
  assert.ok(r.pcb < 110 && r.pcb >= 109.8, String(r.pcb));
});

test('taxable pay: reimbursements and personal deductions excluded; unpaid leave reduces normal pay; bonus is additional', () => {
  const amt = (i) => i.amount;
  const items = [{ code: 'BASIC', kind: 'earning', category: 'basic', amount: 3000, epf: true },
    { code: 'BONUS', kind: 'earning', category: 'bonus', amount: 500, epf: true },
    { code: 'CLAIM_SCF', kind: 'earning', category: 'reimbursement', amount: 80, pcb_subject: false },
    { code: 'UNPAID_LEAVE', kind: 'deduction', category: 'leave', amount: 100, epf: true },
    { code: 'LOAN', kind: 'deduction', category: 'personal', amount: 200 }];
  assert.deepEqual(taxablePay(items, pcbPolicy(), amt), { Y1: 2900, Yt: 500, epf1: 2900, epft: 500 });
  const ytd = pcbYtd([{ items, epf_ee: 374, pcb: 20, socso_ee: 10, eis_ee: 4 }], { prev_year: 2026, prev_gross: 1000, prev_pcb: 5 }, 2026, amt, {});
  assert.equal(ytd.Y, 4400); assert.equal(ytd.K, 374); assert.equal(ytd.X, 25); assert.equal(ytd.LP, 14);
});
