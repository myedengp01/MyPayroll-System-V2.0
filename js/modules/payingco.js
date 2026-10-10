// Paying companies: which company pays each current staff member; move one or several to another company from a month
import { h, clear, pageHead, toast, failed, openModal, field, fmtDate } from '../ui.js';
import { fetchAll, loadRef } from '../data.js';
import { monthLabel, periodOf } from '../engines/payroll.js';
import { todayIso } from '../engines/employee.js';

const addMonths = (p, n) => { const d = new Date(`${p.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

export async function render(el, ctx, params, query) {
  const ref = await loadRef(ctx.sb);
  const today = todayIso();
  const [people, runs] = await Promise.all([
    fetchAll(() => ctx.sb.from('eppd_employee_list').select('id,emp_id,full_name,employment_id,join_date,resigned_date,department_id').order('full_name')),
    fetchAll(() => ctx.sb.from('eppd_pay_runs').select('period,status').order('period')),
  ]);
  const current = people.filter((p) => p.employment_id && (!p.resigned_date || p.resigned_date >= today));
  const emIds = current.map((p) => p.employment_id);
  const asgs = emIds.length ? await fetchAll(() => ctx.sb.from('eppd_assignments').select('*').in('employment_id', emIds).order('id')) : [];
  const lastFinal = runs.filter((r) => r.status === 'finalised').map((r) => r.period).pop();
  const firstOpen = lastFinal ? addMonths(lastFinal, 1) : periodOf(today);

  // one row per paying-company record still running
  const rows = [];
  for (const p of current) {
    const mine = asgs.filter((a) => a.employment_id === p.employment_id && (!a.end_date || a.end_date >= today));
    if (!mine.length) rows.push({ p, a: null });
    for (const a of mine) rows.push({ p, a });
  }
  const coName = (id) => ref.company(id)?.short_name || ref.company(id)?.name || '—';
  const active = ref.companies.filter((c) => c.is_active);
  const dept = (id) => ref.department(id);

  let filter = query.company || ''; let q = '';
  const selected = new Set();
  el.append(pageHead('Paying companies', 'Which company pays each current staff member. The paying company decides the payslip header, the EPF / SOCSO / PCB lists and the EA form. A move takes effect from the month you choose; finalised months keep the company they were paid under.'));
  const facts = h('div', { class: 'facts' }); const warn = h('div', {}); const bar = h('div', { class: 'filter-row', style: 'justify-content:flex-start;gap:.8rem;flex-wrap:wrap' });
  const body = h('div', { class: 'table-wrap' }); const bulk = h('div', { class: 'import-bar' });
  el.append(facts, warn, h('section', { class: 'panel' }, h('div', { class: 'panel-head filters' }, bar), body), bulk);

  const coSel = h('select', { 'aria-label': 'Paying company filter' }, h('option', { value: '' }, 'All companies'), active.map((c) => h('option', { value: String(c.id) }, c.short_name || c.name)),
    h('option', { value: 'none' }, 'No paying company'));
  coSel.value = filter; coSel.addEventListener('change', () => { filter = coSel.value; selected.clear(); draw(); });
  const search = h('input', { type: 'search', placeholder: 'Search name or ID', 'aria-label': 'Search' }); search.addEventListener('input', () => { q = search.value.trim().toLowerCase(); draw(); });
  bar.append(coSel, search);

  function draw() {
    const counts = new Map(); for (const r of rows) if (r.a) counts.set(r.a.company_id, (counts.get(r.a.company_id) || 0) + 1);
    clear(facts).append(...active.map((c) => h('div', { class: 'fact' }, h('b', {}, counts.get(c.id) || 0), h('span', {}, c.short_name || c.name))),
      ...[...counts.keys()].filter((id) => !active.some((c) => c.id === id)).map((id) => h('div', { class: 'fact bad' }, h('b', {}, counts.get(id)), h('span', {}, `${coName(id)} (inactive)`))));
    const noCo = rows.filter((r) => !r.a); const noDept = current.filter((p) => !p.department_id);
    const onInactive = rows.filter((r) => r.a && !ref.company(r.a.company_id)?.is_active);
    clear(warn).append(...[
      noCo.length ? `No paying company: ${noCo.map((r) => r.p.full_name).join(', ')}.` : null,
      onInactive.length ? `Paid by an inactive company: ${onInactive.map((r) => `${r.p.full_name} (${coName(r.a.company_id)})`).join(', ')}. Move them below.` : null,
      noDept.length ? `No department: ${noDept.map((p) => p.full_name).join(', ')}. Set it in the employee's Employment tab.` : null,
    ].filter(Boolean).map((t) => h('p', { class: 'setup-warning', style: 'margin-bottom:.8rem' }, t)));
    const shown = rows.filter((r) => (!filter || (filter === 'none' ? !r.a : r.a && String(r.a.company_id) === filter))
      && (!q || `${r.p.full_name} ${r.p.emp_id || ''}`.toLowerCase().includes(q)));
    const key = (r) => (r.a ? `a${r.a.id}` : `e${r.p.employment_id}`);
    const all = h('input', { type: 'checkbox', 'aria-label': 'Select all shown', checked: shown.length > 0 && shown.every((r) => selected.has(key(r))) });
    all.addEventListener('change', () => { for (const r of shown) all.checked ? selected.add(key(r)) : selected.delete(key(r)); draw(); });
    clear(body).append(h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, all), ...['Employee', 'Department', 'Department’s company', 'Paid by', 'Since', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, shown.length ? shown.map((r) => {
        const d = dept(r.p.department_id); const dc = d?.company_id ? coName(d.company_id) : '';
        const cb = h('input', { type: 'checkbox', 'aria-label': `Select ${r.p.full_name}`, checked: selected.has(key(r)) });
        cb.addEventListener('change', () => { cb.checked ? selected.add(key(r)) : selected.delete(key(r)); drawBulk(); });
        const differs = r.a && d?.company_id && d.company_id !== r.a.company_id;
        return h('tr', {},
          h('td', {}, cb),
          h('td', {}, h('a', { href: `#/employees/${r.p.id}?tab=employment`, class: 'strong' }, r.p.full_name), h('div', { class: 'small muted' }, r.p.emp_id || '')),
          h('td', {}, d ? `${d.code} · ${d.name}` : h('span', { class: 'tag warn' }, 'None')),
          h('td', { class: 'small muted' }, dc),
          h('td', {}, r.a ? coName(r.a.company_id) : h('span', { class: 'tag warn' }, 'None'),
            r.a && !r.a.is_primary ? h('span', { class: 'tag', style: 'margin-left:.4rem' }, 'second company') : null,
            r.a && !ref.company(r.a.company_id)?.is_active ? h('span', { class: 'tag warn', style: 'margin-left:.4rem' }, 'inactive') : null,
            differs ? h('div', { class: 'small muted' }, 'differs from the department') : null),
          h('td', { class: 'small' }, r.a ? fmtDate(r.a.start_date || r.p.join_date) : ''),
          h('td', {}, h('button', { class: 'btn sm', type: 'button', onclick: () => move([r]) }, r.a ? 'Change…' : 'Assign…')));
      }) : h('tr', {}, h('td', { colspan: 7, class: 'muted' }, 'Nobody matches.')))));
    drawBulk();
  }
  function drawBulk() {
    const n = selected.size;
    clear(bulk).append(h('p', { class: 'small muted' }, n ? `${n} selected` : 'Tick staff to move several at once.'),
      h('button', { class: 'btn primary', type: 'button', disabled: !n, onclick: () => move(rows.filter((r) => selected.has(r.a ? `a${r.a.id}` : `e${r.p.employment_id}`))) }, 'Move selected to company…'));
  }

  function move(list) {
    const F = {
      company: field('Paying company', { type: 'select', options: active.map((c) => [c.id, c.name]), required: true,
        value: list.length === 1 ? (dept(list[0].p.department_id)?.company_id || list[0].a?.company_id || active[0]?.id) : active[0]?.id }),
      from: field('From payroll month', { type: 'month', value: firstOpen.slice(0, 7), required: true,
        hint: lastFinal ? `Last finalised month: ${monthLabel(lastFinal)}. Earlier months keep their company.` : 'No month has been finalised yet.' }),
    };
    openModal({ title: list.length === 1 ? `Paying company · ${list[0].p.full_name}` : `Move ${list.length} staff`,
      body: h('div', {}, h('div', { class: 'form-grid' }, Object.values(F)),
        h('p', { class: 'small muted', style: 'margin-top:.6rem' }, 'Salary, allowances and statutory switches carry over. If anyone was already paid by the old company before that month, their old record ends the month before and a new one starts, so their year has one EA form per company. Open and save any draft month from that month on to pick up the change.'),
        list.length > 1 ? h('p', { class: 'small', style: 'margin-top:.4rem' }, list.map((r) => r.p.full_name).join(', ')) : null),
      actions: [{ label: 'Save', primary: true, onClick: async (close) => {
        const co = Number(F.company.getValue()); const fromM = F.from.getValue();
        if (!co || !/^\d{4}-\d{2}$/.test(fromM || '')) { toast('Choose a company and a month.', 'error'); return false; }
        const from = `${fromM}-01`; const errs = []; let done = 0;
        for (const r of list) {
          let error;
          if (r.a) ({ error } = await ctx.sb.rpc('eppd_move_paying_company', { p_assignment: r.a.id, p_company: co, p_from: from }));
          else ({ error } = await ctx.sb.from('eppd_assignments').insert({ employment_id: r.p.employment_id, company_id: co, is_primary: true, start_date: r.p.join_date }));
          if (error) errs.push(`${r.p.full_name}: ${error.message}`); else done += 1;
        }
        if (errs.length) toast(`${done} saved. ${errs.join(' · ')}`, 'error', 9000); else toast(`${done} saved.`);
        close(); window.dispatchEvent(new HashChangeEvent('hashchange')); return true;
      } }] });
  }
  draw();
}
