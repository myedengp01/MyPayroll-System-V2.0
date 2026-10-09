// Overview: setup checklist for Phase 1 + roadmap
import { h, pageHead } from '../ui.js';

export async function render(el, ctx) {
  const year = new Date().getFullYear();
  const [comp, vers, hol, pend, emps, payRuns] = await Promise.all([
    ctx.sb.from('eppd_companies').select('code,name,is_primary,logo,epf_employer_no,socso_employer_no,tax_employer_no').eq('is_active', true),
    ctx.sb.from('eppd_stat_versions').select('id', { count: 'exact', head: true }),
    ctx.sb.from('eppd_holidays').select('id', { count: 'exact', head: true })
      .gte('holiday_date', `${year}-01-01`).lte('holiday_date', `${year}-12-31`),
    ctx.can(['admin']) ? ctx.sb.from('eppd_user_roles').select('user_id', { count: 'exact', head: true }).eq('status', 'pending')
                       : Promise.resolve({ count: 0 }),
    ctx.sb.from('eppd_employees').select('id', { count: 'exact', head: true }),
    ctx.can(['admin', 'hr']) ? ctx.sb.from('eppd_pay_runs').select('period,status,source').order('period', { ascending: false }) : Promise.resolve({ data: null }),
  ]);
  const runs = payRuns.data;
  const primary = (comp.data || []).filter((c) => c.is_primary);
  const withLogo = primary.filter((c) => c.logo).length;
  const withNos = primary.filter((c) => c.epf_employer_no && c.socso_employer_no && c.tax_employer_no).length;

  const items = [
    { done: withLogo === primary.length && primary.length > 0, text: 'Upload the group company logos',
      detail: `${withLogo} of ${primary.length} uploaded`, href: '#/settings/companies' },
    { done: withNos === primary.length && primary.length > 0, text: 'Fill in employer numbers (EPF, SOCSO, LHDN E-number)',
      detail: `${withNos} of ${primary.length} companies complete`, href: '#/settings/companies' },
    { done: (vers.count || 0) > 0, text: 'Load the EPF, SOCSO and EIS tables',
      detail: `${vers.count || 0} table versions loaded`, href: '#/settings/statutory' },
    { done: (hol.count || 0) > 0, text: `Add the ${year} public holidays`,
      detail: `${hol.count || 0} holidays for ${year}`, href: '#/settings/holidays' },
    { done: true, text: 'Review statutory treatment of each payment type', detail: 'Cash Ang Bao, bonus, allowances…', href: '#/settings/payment-types', optional: true },
  ];
  items.splice(0, 0, { done: (emps.count || 0) > 0, text: 'Import staff from the MEG-EPPD workbook',
    detail: emps.count ? `${emps.count} people on record` : 'No employees yet', href: emps.count ? '#/employees' : (ctx.can(['admin']) ? '#/employees/import' : '#/employees') });
  if (runs) {
    const imported = runs.filter((r) => r.source === 'import').length;
    items.push({ done: imported > 0, text: 'Import January–September 2026 payroll from the workbook', detail: imported ? `${imported} months imported` : 'Year-to-date totals start here',
      href: ctx.can(['admin']) ? '#/payroll/import' : '#/payroll' });
    const draft = runs.find((r) => r.status === 'draft');
    if (draft) items.push({ done: false, text: `Finish the ${new Date(draft.period + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })} payroll`, detail: 'Draft, not finalised yet', href: `#/payroll/${draft.period.slice(0, 7)}` });
  }
  if (ctx.can(['admin'])) items.push({ done: (pend.count || 0) === 0, text: 'Approve waiting user accounts',
    detail: `${pend.count || 0} waiting`, href: '#/settings/users' });

  el.append(
    pageHead(`Hello, ${ctx.me.display_name || ctx.me.email.split('@')[0]}`,
      'Staff records, leave, overtime and monthly payroll are live. Payslips and statutory files arrive in the next phase.'),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Setup checklist')),
      h('ul', { class: 'checklist' }, items.map((i) => h('li', {},
        h('span', { class: `dot ${i.done ? 'done' : 'todo'}`, 'aria-label': i.done ? 'Done' : 'To do' }, i.done ? '✓' : ''),
        h('div', {}, h('div', {}, i.text), h('div', { class: 'small muted' }, i.detail)),
        h('a', { class: 'btn sm', href: i.href }, i.optional ? 'Review' : (i.done ? 'View' : 'Open')))))),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Build plan')),
      h('div', { class: 'roadmap' }, [
        ['Phase 1', 'Foundations: access, companies, lists, statutory tables, policies', 'Live'],
        ['Phase 2', 'Employees, Employee ID generator, salary & allowance history, Excel import', 'Live'],
        ['Phase 3', 'Leave & attendance, AL calculator, year-end close, OT and part-time hours (OTCF)', 'Live'],
        ['Phase 4', 'Monthly payroll: pay runs, overtime at Employment Act rates, statutory, finalise & lock, Jan–Sep 2026 history', 'Live'],
        ['Phase 5', 'Payslips, monthly summary, statutory & bank files', 'Next'],
        ['Phase 6', 'PCB, self-service, MEG-FORMS claims, final settlement, loans', ''],
      ].map(([p, t, s]) => h('div', {}, h('b', {}, p), h('span', {}, t),
        s ? h('span', { class: `tag ${s === 'Live' ? 'ok' : 'warn'}` }, s) : h('span', {}))))));
}
