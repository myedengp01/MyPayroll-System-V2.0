// MyPayroll-System-V2.0 · cms-link.js — payroll now runs in the MyEden Group CMS (Phase 6).
// Every MyPayroll page shows a banner with a link to the same page in the CMS. Pure functions (tested in tests/cmslink.test.js).

export const CMS_APP = 'https://myedengp01.github.io/MyEden-Group-CMS-V1.0/app/';

const SAME = new Set(['dashboard', 'leave', 'leave/balances', 'leave/audit', 'leave/al-calculator', 'leave/kpi', 'leave/year-end', 'leave/import',
  'time', 'time/part-time', 'payroll', 'payroll/companies', 'payroll/import', 'settings/org', 'settings/lists', 'settings/payment-types',
  'settings/statutory', 'settings/holidays', 'settings/policies']);
const MAP = {
  employees: 'people', 'employees/:id': 'people', 'employees/former': 'people/former', 'employees/ids': 'people/ids', 'employees/import': 'people/import',
  reports: 'payroll/reports', loans: 'payroll/loans', settlements: 'payroll/settlement', claims: 'approvals',
  'settings/companies': 'admin/companies', 'settings/users': 'admin/roles', 'settings/audit': 'admin/audit',
};

/** The CMS route for a MyPayroll route key (+ params), e.g. 'payroll/:period' {period:'2026-10'} -> 'payroll/2026-10'. */
export function cmsRouteFor(key, params = {}) {
  if (key === 'payroll/:period') return /^\d{4}-\d{2}$/.test(params.period || '') ? `payroll/${params.period}` : 'payroll';
  if (SAME.has(key)) return key;
  return MAP[key] || 'dashboard';
}

/** Full CMS link for a MyPayroll route. */
export const cmsUrlFor = (key, params) => `${CMS_APP}#/${cmsRouteFor(key, params)}`;
