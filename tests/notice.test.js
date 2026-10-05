import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNotice, completedYears } from '../js/engines/notice.js';

const policy = { probation_weeks: 4, bands: [
  { from_years: 0, to_years: 2, weeks: 4 }, { from_years: 2, to_years: 5, weeks: 6 }, { from_years: 5, to_years: null, weeks: 12 } ] };

test('completed years like DATEDIF "y"', () => {
  assert.equal(completedYears('2024-03-15', '2026-03-14'), 1);
  assert.equal(completedYears('2024-03-15', '2026-03-15'), 2);
});
test('bands: <2y 4w, 2–<5y 6w, >=5y 12w, probation 4w', () => {
  assert.equal(computeNotice({ joinDate: '2025-01-01', letterDate: '2026-10-05' }, policy).weeks, 4);
  assert.equal(computeNotice({ joinDate: '2024-10-05', letterDate: '2026-10-05' }, policy).weeks, 6);
  assert.equal(computeNotice({ joinDate: '2021-10-05', letterDate: '2026-10-05' }, policy).weeks, 12);
  assert.equal(computeNotice({ joinDate: '2018-01-01', letterDate: '2026-10-05', onProbation: true }, policy).weeks, 4);
});
test('notice end = letter date + days (workbook convention)', () => {
  const r = computeNotice({ joinDate: '2026-09-14', letterDate: '2026-09-21' }, policy);
  assert.equal(r.noticeEnd, '2026-10-19');
});
