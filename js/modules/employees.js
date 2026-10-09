// Employees list: search, filters, add employee, export
import { h, clear, pageHead, fmtDate } from '../ui.js';
import { loadRef, fetchAll } from '../data.js';
import { employmentStatus, serviceLength, formatService, todayIso, firstOfMonth, lastDayOfMonth } from '../engines/employee.js';
import { openAddEmployee } from '../employee-forms.js';

const STATUS_TABS = [['current', 'Current staff'], ['notice', 'Serving notice'], ['former', 'Former staff'], ['all', 'Everyone']];

export async function render(el, ctx, params, query) {
  const canEdit = ctx.can(['admin', 'hr']);
  const [ref, rows] = await Promise.all([
    loadRef(ctx.sb),
    fetchAll(() => ctx.sb.from('eppd_employee_list').select('*').order('full_name')),
  ]);
  const today = todayIso();
  for (const r of rows) {
    r._status = employmentStatus(r, ref.confMeta, today);
    r._search = [r.full_name, r.chinese_name, r.emp_id, r.job_title, r.department_code].filter(Boolean).join(' ').toLowerCase();
  }

  const st = { status: query.status || 'current', company: query.company || '', dept: query.dept || '', q: query.q || '', missing: query.missing === '1' || query.missing === 'true' };
  const isMissing = (r) => r._status.key === 'former' && !r.resigned_date;
  const counts = { current: rows.filter((r) => r._status.key !== 'former').length, notice: rows.filter((r) => r._status.key === 'notice').length,
    former: rows.filter((r) => r._status.key === 'former').length, all: rows.length };
  const missingCount = rows.filter(isMissing).length;
  const search = h('input', { type: 'search', placeholder: 'Search name, Chinese name, ID or job title', 'aria-label': 'Search employees', value: st.q });
  const companySel = h('select', { 'aria-label': 'Company' }, h('option', { value: '' }, 'All companies'),
    ref.companies.map((c) => h('option', { value: c.id, selected: String(c.id) === st.company }, c.short_name || c.name)));
  const deptSel = h('select', { 'aria-label': 'Department' }, h('option', { value: '' }, 'All departments'),
    ref.departments.map((d) => h('option', { value: d.id, selected: String(d.id) === st.dept }, d.code === d.name ? d.code : `${d.code} · ${d.name}`)));
  const tabs = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Employment status' });
  const body = h('div', { class: 'table-wrap' });
  const countEl = h('p', { class: 'small muted' });

  const ym = today.slice(0, 7);
  const cur = rows.filter((r) => r._status.key !== 'former');
  const facts = [
    ['Current staff', cur.length],
    ['Former staff', counts.former, () => { st.status = 'former'; st.missing = false; sync(); draw(); }],
    ['On probation', cur.filter((r) => r.confirmation_status === 'UP').length],
    ['Serving notice', rows.filter((r) => r._status.key === 'notice').length],
    ['Joined this month', rows.filter((r) => r.join_date && r.join_date.slice(0, 7) === ym).length],
    ['Leaving this month', rows.filter((r) => r.resigned_date && r.resigned_date >= firstOfMonth(today) && r.resigned_date <= lastDayOfMonth(today)).length],
  ];
  if (missingCount) facts.push(['Former staff with no last working day', missingCount, () => { st.status = 'former'; st.missing = true; sync(); draw(); }, true]);

  el.append(
    pageHead('Employees', 'Everyone employed by the group, past and present. Records are keyed by Employee ID, so name changes never break payroll.',
      rows.length ? h('button', { class: 'btn', type: 'button', onclick: exportCsv }, 'Export list') : null,
      canEdit ? h('button', { class: 'btn primary', type: 'button', onclick: () => openAddEmployee(ctx, ref, (id) => { location.hash = `#/employees/${id}`; }) }, 'Add employee') : null),
    rows.length ? h('div', { class: 'facts' }, facts.map(([l, n, go, bad]) => go
      ? h('button', { type: 'button', class: `fact linkfact ${bad ? 'bad' : ''}`, onclick: go, title: 'Show these people' }, h('b', {}, n), h('span', {}, l))
      : h('div', { class: 'fact' }, h('b', {}, n), h('span', {}, l)))) : null,
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head filters' }, tabs, h('div', { class: 'filter-row' }, search, companySel, deptSel)),
      body, h('div', { class: 'panel-foot' }, countEl)));

  if (!rows.length) {
    clear(body).append(h('div', { class: 'empty-state' },
      h('h2', {}, 'No employees yet'),
      h('p', {}, ctx.can(['admin']) ? 'Import your staff from the MEG-EPPD workbook, or add people one by one.' : 'An admin needs to import the staff list first.'),
      h('div', { class: 'side-actions', style: 'justify-content:center' },
        ctx.can(['admin']) ? h('a', { class: 'btn primary', href: '#/employees/import' }, 'Import from workbook') : null,
        canEdit ? h('button', { class: 'btn', type: 'button', onclick: () => openAddEmployee(ctx, ref, (id) => { location.hash = `#/employees/${id}`; }) }, 'Add employee') : null)));
    return;
  }

  function filtered() {
    const q = st.q.trim().toLowerCase();
    // a name search looks across everyone, whatever tab is open
    const anyStatus = q.length >= 2;
    return rows.filter((r) => (anyStatus || st.status === 'all' || r._status.key === st.status || (st.status === 'current' && r._status.key === 'notice'))
      && (!st.company || String(r.company_id) === st.company)
      && (!st.dept || String(r.department_id) === st.dept)
      && (!st.missing || isMissing(r))
      && (!q || r._search.includes(q)));
  }

  function draw() {
    clear(tabs).append(...STATUS_TABS.map(([k, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(st.status === k),
      onclick: () => { st.status = k; st.missing = false; sync(); draw(); } }, `${l} (${counts[k]})`)));
    if (st.missing) tabs.append(h('button', { type: 'button', class: 'tag warn', style: 'margin-left:.5rem', onclick: () => { st.missing = false; sync(); draw(); } }, 'No last working day only ✕'));
    const list = filtered();
    countEl.textContent = `${list.length} of ${rows.length} people`;
    clear(body);
    if (!list.length) { body.append(h('div', { class: 'empty-state' }, 'No one matches these filters.')); return; }
    body.append(h('table', { class: 'data clickable' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Employee'), h('th', {}, 'Company'), h('th', {}, 'Department'),
        h('th', {}, 'Job title'), h('th', {}, 'Joined'), st.status === 'former' ? h('th', {}, 'Last day') : null, h('th', {}, 'Service'), h('th', {}, 'Status'))),
      h('tbody', {}, list.map((r) => {
        const end = r._status.key === 'former' ? r.resigned_date : today;
        return h('tr', { tabindex: '0', onclick: () => open(r), onkeydown: (e) => { if (e.key === 'Enter') open(r); } },
          h('td', {}, h('a', { href: `#/employees/${r.id}`, class: 'row-link' }, r.full_name),
            h('div', { class: 'small muted' }, [r.emp_id || 'No ID', r.chinese_name].filter(Boolean).join(' · '))),
          h('td', {}, r.company_name || '—', r.company_count > 1 ? h('span', { class: 'tag', style: 'margin-left:.4rem' }, `+${r.company_count - 1}`) : null),
          h('td', {}, r.department_code || '—'),
          h('td', {}, r.job_title || '—'),
          h('td', { class: 'nowrap' }, fmtDate(r.join_date)),
          st.status === 'former' ? h('td', { class: 'nowrap' }, r.resigned_date ? fmtDate(r.resigned_date) : h('span', { class: 'tag warn' }, 'Missing')) : null,
          h('td', { class: 'nowrap' }, r.join_date && end ? formatService(serviceLength(r.join_date, end)) : ''),
          h('td', {}, statusTag(r._status, r.confirmation_status)));
      }))));
  }
  const open = (r) => { location.hash = `#/employees/${r.id}`; };
  function sync() {
    const qs = new URLSearchParams(Object.entries(st).filter(([, v]) => v));
    history.replaceState(null, '', `#/employees?${qs}`);
  }
  search.addEventListener('input', () => { st.q = search.value; sync(); draw(); });
  companySel.addEventListener('change', () => { st.company = companySel.value; sync(); draw(); });
  deptSel.addEventListener('change', () => { st.dept = deptSel.value; sync(); draw(); });
  draw();

  function exportCsv() {
    const list = filtered();
    const cols = [['Employee ID', 'emp_id'], ['Name', 'full_name'], ['Chinese name', 'chinese_name'], ['Company', 'company_name'],
      ['Department', 'department_code'], ['Job title', 'job_title'], ['Joined', 'join_date'], ['Last day', 'resigned_date'], ['Status', (r) => r._status.label]];
    const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.map((c) => c[0]).join(','), ...list.map((r) => cols.map(([, k]) => esc(typeof k === 'function' ? k(r) : r[k])).join(','))].join('\r\n');
    const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })), download: `employees-${today}.csv` });
    document.body.append(a); a.click(); a.remove();
  }
}

export function statusTag(status, code) {
  const cls = status.key === 'former' ? '' : status.key === 'notice' ? 'warn' : code === 'UP' ? 'info' : 'ok';
  return h('span', { class: `tag ${cls}` }, status.label);
}
