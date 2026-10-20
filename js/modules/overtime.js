// Overtime & part-time hours: monthly view, manual entries, pull approved OTCF claims
import { h, clear, pageHead, fmtDate, toast, failed, confirmDialog } from '../ui.js';
import { loadRef, fetchAll } from '../data.js';
import { loadPeople } from '../leave-data.js';
import { OT_CATEGORIES } from '../engines/ot.js';
import { editTimeEntry, pullOtcf, CATS } from '../time-forms.js';
import { todayIso, lastDayOfMonth } from '../engines/employee.js';
import { megformsConfigured } from '../megforms.js';

const SHORT = { OT_NORMAL: 'Normal', OT_OFFDAY: 'Off day', RD_HALF: 'RD ≤½', RD_FULL: 'RD >½', RD_EXCESS: 'RD extra', PH_NORMAL: 'PH', PH_EXCESS: 'PH extra', PT_HOURS: 'Part-time' };

export async function render(el, ctx, params, query) {
  const month = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month : todayIso().slice(0, 7);
  const start = `${month}-01`, end = lastDayOfMonth(start);
  const ref = await loadRef(ctx.sb);
  const [people, entries] = await Promise.all([loadPeople(ctx.sb, ref),
    fetchAll(() => ctx.sb.from('eppd_time_entries').select('*').gte('work_date', start).lte('work_date', end).order('work_date'))]);
  const byId = new Map(people.map((p) => [p.id, p]));
  const open = new Set();

  const monthIn = h('input', { type: 'month', value: month, 'aria-label': 'Month', style: 'width:auto' });
  monthIn.addEventListener('change', () => { if (monthIn.value) location.hash = `#/time?month=${monthIn.value}`; });
  const body = h('div', { class: 'table-wrap' });
  el.append(pageHead('Overtime & hours', 'Hours by Employment Act category for the month. Rest days and public holidays are counted per day worked; the payroll applies the rates in Phase 4.',
    monthIn, h('a', { class: 'btn', href: `#/time/part-time?month=${month}` }, 'Part-time hours (monthly total)'), h('button', { class: 'btn', type: 'button', onclick: () => edit(null) }, 'Add entry'),
    h('button', { class: 'btn primary', type: 'button', onclick: pull, disabled: !megformsConfigured }, 'Pull approved OTCF claims')),
  h('section', { class: 'panel' }, body),
  h('details', { class: 'panel legend-box' }, h('summary', {}, 'What each category pays (Employment Act)'),
    h('ul', {}, CATS.map((c) => h('li', {}, h('b', {}, OT_CATEGORIES[c].label), ` — ${OT_CATEGORIES[c].pay}`)))));

  function draw() {
    clear(body);
    if (!entries.length) {
      body.append(h('div', { class: 'empty-state' }, h('p', {}, `No overtime or part-time hours for ${new Date(start + 'T00:00:00').toLocaleDateString('en-MY', { month: 'long', year: 'numeric' })} yet.`),
        h('div', { class: 'side-actions', style: 'justify-content:center' },
          megformsConfigured ? h('button', { class: 'btn primary', type: 'button', onclick: pull }, 'Pull approved OTCF claims') : null,
          h('button', { class: 'btn', type: 'button', onclick: () => edit(null) }, 'Add entry'))));
      return;
    }
    const groups = new Map();
    for (const e of entries) { if (!groups.has(e.employee_id)) groups.set(e.employee_id, []); groups.get(e.employee_id).push(e); }
    const used = CATS.filter((c) => entries.some((e) => e.category === c));
    const sum = (list, c) => Math.round(list.filter((e) => e.category === c).reduce((s, e) => s + Number(e.hours), 0) * 100) / 100;
    const days = (list, c) => list.filter((e) => e.category === c).length;
    const tbody = h('tbody', {});
    for (const [empId, list] of [...groups.entries()].sort((a, b) => (byId.get(a[0])?.full_name || '').localeCompare(byId.get(b[0])?.full_name || ''))) {
      const p = byId.get(empId);
      const toggle = h('button', { class: 'btn sm ghost', type: 'button', 'aria-expanded': String(open.has(empId)) }, open.has(empId) ? 'Hide' : `${list.length} entr${list.length === 1 ? 'y' : 'ies'}`);
      toggle.addEventListener('click', () => { if (open.has(empId)) open.delete(empId); else open.add(empId); draw(); });
      tbody.append(h('tr', { class: 'grp-row' },
        h('td', {}, h('a', { href: `#/employees/${empId}`, class: 'row-link' }, p?.full_name || '?'), h('div', { class: 'small muted' }, p?.emp_id || '')),
        used.map((c) => { const hrs = sum(list, c); const n = days(list, c);
          return h('td', { class: 'num' }, hrs ? `${hrs} h` : '', hrs && ['RD_HALF', 'RD_FULL', 'PH_NORMAL'].includes(c) ? h('div', { class: 'small muted' }, `${n} day${n === 1 ? '' : 's'}`) : null); }),
        h('td', { class: 'actions' }, toggle)));
      if (open.has(empId)) for (const e of list) tbody.append(h('tr', { class: 'sub-row' },
        h('td', { colspan: used.length + 1 }, h('div', { class: 'entry-line' },
          h('span', {}, fmtDate(e.work_date)), h('b', {}, `${Number(e.hours)} h`), h('span', {}, OT_CATEGORIES[e.category].label),
          e.from_time ? h('span', { class: 'muted' }, `${String(e.from_time).slice(0, 5)}–${String(e.to_time || '').slice(0, 5)}`) : null,
          h('span', { class: `tag ${e.source === 'otcf' ? 'info' : ''}` }, e.source === 'otcf' ? 'OTCF' : e.source === 'import' ? 'Workbook' : 'Manual'),
          e.note ? h('span', { class: 'small muted' }, e.note) : null)),
        h('td', { class: 'actions' }, h('button', { class: 'btn sm', type: 'button', onclick: () => edit(e) }, 'Edit'),
          h('button', { class: 'btn sm ghost', type: 'button', onclick: () => remove(e) }, 'Delete'))));
    }
    body.append(h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Employee'), used.map((c) => h('th', { class: 'num', title: OT_CATEGORIES[c].label }, SHORT[c])), h('th', {}))), tbody));
  }
  draw();

  const reload = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  async function remove(e) {
    if (!(await confirmDialog('Delete entry', `Delete ${e.hours} h of ${OT_CATEGORIES[e.category].label} on ${fmtDate(e.work_date)}?${e.source === 'otcf' ? ' Pulling OTCF again will bring it back.' : ''}`, 'Delete', true))) return;
    const { error } = await ctx.sb.from('eppd_time_entries').delete().eq('id', e.id);
    if (!failed(error, 'Delete')) { toast('Deleted.'); reload(); }
  }
  function edit(e) { editTimeEntry(ctx, { people, month, entry: e, onSaved: reload }); }

  function pull() { pullOtcf(ctx, { month, people, entries, onSaved: reload }); }
}
