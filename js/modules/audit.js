// Audit log (admin only): who changed what, newest first
import { h, clear, pageHead, failed, fmtDateTime, openModal } from '../ui.js';

const NAMES = { eppd_companies: 'Companies', eppd_departments: 'Departments', eppd_job_titles: 'Job titles', eppd_lookups: 'Pick-lists',
  eppd_payment_types: 'Payment types', eppd_policies: 'Policies', eppd_stat_versions: 'Statutory tables', eppd_holidays: 'Holidays', eppd_user_roles: 'Users',
  eppd_employees: 'Employees', eppd_employee_private: 'Identity & bank', eppd_employments: 'Employment', eppd_assignments: 'Paying company',
  eppd_salary_history: 'Salary history', eppd_allowances: 'Allowances',
  eppd_leave_records: 'Leave', eppd_leave_adjustments: 'Leave balances', eppd_kpi_ratings: 'KPI grades', eppd_time_entries: 'Overtime & hours', eppd_pay_runs: 'Payroll months', eppd_pay_lines: 'Pay lines',
  eppd_otcf_links: 'OTCF name links', eppd_leave_year_closes: 'Year-end close' };

function changes(o, n) {
  if (!o) return Object.keys(n || {}).filter((k) => !['created_at', 'updated_at'].includes(k));
  if (!n) return ['(deleted)'];
  return Object.keys({ ...o, ...n }).filter((k) => !['updated_at'].includes(k) && JSON.stringify(o[k]) !== JSON.stringify(n[k]));
}

export async function render(el, ctx) {
  const sel = h('select', { 'aria-label': 'Filter by area', style: 'width:auto' }, h('option', { value: '' }, 'All areas'),
    Object.entries(NAMES).map(([k, v]) => h('option', { value: k }, v)));
  const body = h('div', { class: 'table-wrap' });
  el.append(pageHead('Audit log', 'Every change to settings and access, newest first (latest 300).', sel), h('section', { class: 'panel' }, body));
  async function load() {
    let q = ctx.sb.from('eppd_audit_log').select('*').order('id', { ascending: false }).limit(300);
    if (sel.value) q = q.eq('table_name', sel.value);
    const { data, error } = await q;
    if (failed(error, 'Load')) return;
    if (!data.length) { clear(body).append(h('div', { class: 'empty-state' }, 'No changes recorded yet.')); return; }
    clear(body).append(h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Who'), h('th', {}, 'Area'), h('th', {}, 'Action'), h('th', {}, 'Changed'), h('th', {}))),
      h('tbody', {}, data.map((r) => {
        const ch = r.action === 'UPDATE' ? changes(r.old_data, r.new_data) : [];
        const what = r.action === 'IMPORT' ? (r.new_data?.people ? `${r.new_data.people} people from ${r.new_data.source}` : `${r.new_data?.leave_records ?? 0} leave totals, ${r.new_data?.time_entries ?? 0} hours entries`) : r.action === 'YEAR_CLOSE' ? `${r.new_data?.year}: ${r.new_data?.adjustments} adjustments` : r.action === 'OTCF_PULL' ? `${r.new_data?.month}: ${r.new_data?.entries_added} entries` : r.action === 'PAY_IMPORT' ? `${r.new_data?.months} months, ${r.new_data?.lines} lines` : r.action?.startsWith('PAY_') ? `${String(r.new_data?.period || '').slice(0, 7)}${r.new_data?.lines ? ` · ${r.new_data.lines} lines` : ''}${r.new_data?.reason ? ` · ${r.new_data.reason}` : ''}` : r.table_name === 'eppd_pay_runs' ? `${String(r.new_data?.period || r.old_data?.period || '').slice(0, 7)} ${r.new_data?.status || ''}` : r.table_name === 'eppd_pay_lines' ? `${r.new_data?.emp_name || r.old_data?.emp_name || ''}` : (r.new_data?.full_name || r.old_data?.full_name || r.new_data?.name || r.new_data?.label || r.new_data?.email || r.new_data?.code || r.old_data?.name || r.row_id);
        return h('tr', {},
          h('td', { class: 'small' }, fmtDateTime(r.at)), h('td', { class: 'small' }, r.user_email || 'system / SQL'),
          h('td', {}, NAMES[r.table_name] || r.table_name, h('div', { class: 'small muted' }, what)),
          h('td', {}, { INSERT: 'Added', UPDATE: 'Changed', DELETE: 'Deleted', IMPORT: 'Imported', RESET: 'Reset', YEAR_CLOSE: 'Year closed', OTCF_PULL: 'OTCF pulled', PAY_SAVE: 'Payroll saved', PAY_FINALISE: 'Payroll finalised', PAY_REOPEN: 'Payroll reopened', PAY_IMPORT: 'Payroll imported' }[r.action] || r.action),
          h('td', { class: 'small muted' }, ch.slice(0, 4).join(', '), ch.length > 4 ? ` +${ch.length - 4}` : ''),
          h('td', { class: 'actions' }, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => openModal({ title: 'Change details', wide: true,
            body: h('div', { class: 'grid-2' },
              h('div', {}, h('h3', {}, 'Before'), h('pre', { class: 'small', style: 'white-space:pre-wrap' }, JSON.stringify(r.old_data, null, 2) || '—')),
              h('div', {}, h('h3', {}, 'After'), h('pre', { class: 'small', style: 'white-space:pre-wrap' }, JSON.stringify(r.new_data, null, 2) || '—'))) }) }, 'Details')));
      }))));
  }
  sel.addEventListener('change', load);
  await load();
}
