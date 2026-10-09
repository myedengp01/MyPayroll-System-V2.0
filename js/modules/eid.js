// Employee IDs: checks the EID Generator sheet used to do, plus an ID preview
import { h, clear, pageHead, fmtDate, toast, failed, field } from '../ui.js';
import { loadRef, fetchAll } from '../data.js';
import { auditIds, formatEmpId, parseEmpId } from '../engines/eid.js';
import { todayIso } from '../engines/employee.js';

export async function render(el, ctx) {
  const canHR = ctx.can(['admin', 'hr']);
  const [ref, rows] = await Promise.all([loadRef(ctx.sb), fetchAll(() => ctx.sb.from('eppd_employee_list').select('id,emp_id,emp_serial,full_name,gender,join_date,company_id,confirmation_status,resigned_date').order('emp_serial', { ascending: false, nullsFirst: false }))]);
  const audit = auditIds(rows);
  const body = h('div', {});
  el.append(pageHead('Employee IDs', 'IDs are built from the company prefix, the month and year joined, the gender letter and one running number shared by every company in the group. Existing IDs are never changed automatically.'), body);

  // ---- preview / format
  const F = {
    company: field('Company', { type: 'select', options: ref.companies.filter((c) => c.is_active).map((c) => [c.id, `${c.short_name || c.name} (${c.eid_prefix})`]),
      value: (ref.companies.find((c) => c.is_primary) || ref.companies[0])?.id }),
    join: field('Date joined', { type: 'date', value: todayIso() }),
    gender: field('Gender', { type: 'select', options: [['F', 'Female'], ['M', 'Male']], value: 'F' }),
  };
  const out = h('p', { class: 'id-preview big' });
  const explain = h('p', { class: 'small muted' });
  const calc = () => {
    const c = ref.company(Number(F.company.getValue()));
    const id = formatEmpId({ prefix: c?.eid_prefix, joinDate: F.join.getValue(), gender: F.gender.getValue(), serial: audit.nextSerial });
    out.textContent = id || '—';
    const p = parseEmpId(id);
    explain.textContent = p ? `${p.prefix} = company prefix · ${p.mm}${p.yy} = joined ${p.mm}/20${p.yy} · ${p.gender} = gender · ${String(p.serial).padStart(4, '0')} = next running number` : '';
  };
  Object.values(F).forEach((f) => f.input.addEventListener('change', calc));

  const stats = h('div', { class: 'facts' },
    [['Next running number', audit.nextSerial], ['People with an ID', rows.length - audit.missing.length], ['Without an ID', audit.missing.length],
      ['Duplicate IDs', audit.duplicates.length]].map(([l, n]) => h('div', { class: `fact ${l === 'Duplicate IDs' && n ? 'bad' : ''}` }, h('b', {}, n), h('span', {}, l))));

  const list = (title, desc, items, render, empty) => h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, `${title} (${items.length})`), desc ? h('p', { class: 'small muted' }, desc) : null)),
    items.length ? h('div', { class: 'table-wrap' }, render(items)) : h('div', { class: 'empty-state small' }, empty));
  const link = (p) => h('a', { href: `#/employees/${p.id}` }, p.full_name);

  async function gen(p, btn) {
    btn.disabled = true;
    const { data, error } = await ctx.sb.rpc('eppd_generate_emp_id', { p_employee_id: p.id });
    if (failed(error, 'Generate ID')) { btn.disabled = false; return; }
    toast(`${p.full_name}: ${data}`); window.dispatchEvent(new HashChangeEvent('hashchange'));
  }

  body.append(stats,
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, 'What the next ID will look like'),
      h('p', { class: 'small muted' }, 'A preview only. The number is assigned when the employee is saved.'))),
      h('div', { class: 'panel-body' }, h('div', { class: 'form-grid three' }, F.company, F.join, F.gender), out, explain)),
    list('Duplicate IDs', 'The same ID on two different people. Change one in their profile.', audit.duplicates,
      (items) => h('table', { class: 'data' }, h('tbody', {}, items.map((d) => h('tr', {}, h('td', {}, d.emp_id), h('td', {}, d.people.map((p, i) => [i ? ', ' : '', link(p)])))))),
      'None. Every ID belongs to one person.'),
    list('People without an ID', canHR ? 'Mostly former staff from the workbook. Generate an ID if you need one for records.' : null, audit.missing,
      (items) => h('table', { class: 'data' }, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Joined'), h('th', {}, 'Gender'), canHR ? h('th', {}) : null)),
        h('tbody', {}, items.map((p) => { const b = h('button', { class: 'btn sm', type: 'button' }, 'Generate ID'); b.addEventListener('click', () => gen(p, b));
          return h('tr', {}, h('td', {}, link(p)), h('td', {}, fmtDate(p.join_date) || '—'), h('td', {}, p.gender || '—'),
            canHR ? h('td', { class: 'actions' }, p.join_date && p.gender ? b : h('span', { class: 'small muted' }, 'Needs join date and gender')) : null); }))),
      'Everyone has an ID.'),
    list('IDs that differ from the record', 'Kept as issued (often a rehire or a corrected join date). For information only.',
      [...audit.monthMismatch.map((p) => ({ ...p, why: `ID month ${parseEmpId(p.emp_id).mm}/${parseEmpId(p.emp_id).yy}, joined ${fmtDate(p.join_date)}` })),
       ...audit.genderMismatch.map((p) => ({ ...p, why: `ID gender ${parseEmpId(p.emp_id).gender}, record says ${p.gender}` }))],
      (items) => h('table', { class: 'data' }, h('tbody', {}, items.map((p) => h('tr', {}, h('td', {}, p.emp_id), h('td', {}, link(p)), h('td', { class: 'small muted' }, p.why))))),
      'All IDs match their records.'),
    audit.badFormat.length ? list('IDs in an unusual format', null, audit.badFormat,
      (items) => h('table', { class: 'data' }, h('tbody', {}, items.map((p) => h('tr', {}, h('td', {}, p.emp_id), h('td', {}, link(p)))))), '') : null,
    h('p', { class: 'small muted' }, audit.gaps.length ? `Running numbers never used: ${audit.gaps.join(', ')}. Gaps are normal and are not reused.` : ''));
  calc();
}
