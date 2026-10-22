import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmsRouteFor, cmsUrlFor, CMS_APP } from '../js/cms-link.js';

test('MyPayroll pages map to the same page in the CMS', () => {
  assert.equal(cmsRouteFor('payroll'), 'payroll');
  assert.equal(cmsRouteFor('payroll/:period', { period: '2026-10' }), 'payroll/2026-10');
  assert.equal(cmsRouteFor('payroll/:period', { period: 'x' }), 'payroll');
  assert.equal(cmsRouteFor('reports'), 'payroll/reports');
  assert.equal(cmsRouteFor('loans'), 'payroll/loans');
  assert.equal(cmsRouteFor('settlements'), 'payroll/settlement');
  assert.equal(cmsRouteFor('employees/:id', { id: '42' }), 'people');
  assert.equal(cmsRouteFor('leave/balances'), 'leave/balances');
  assert.equal(cmsRouteFor('settings/users'), 'admin/roles');
  assert.equal(cmsRouteFor('settings/holidays'), 'settings/holidays');
  assert.equal(cmsRouteFor('nope'), 'dashboard');
  assert.equal(cmsUrlFor('time/part-time'), `${CMS_APP}#/time/part-time`);
});
