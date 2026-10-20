// Part-time hours: one screen per month, the total hours worked by every hourly-paid person.
// The total is stored as one "monthly total" entry; day entries (if any) still count and are shown.
import { h, clear, pageHead, toast, failed, money } from '../ui.js';
import { fetchAll, loadRef } from '../data.js';
import { loadPayPeople } from '../pay-data.js';
import { loadPeople } from '../leave-data.js';
import { todayIso, lastDayOfMonth } from '../engines/employee.js';
import { MONTHLY_NOTE, hourlyPeople, savePtTotal } from '../pt-hours.js';
const r2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
import { editTimeEntry } from '../time-forms.js';

export async function render(el, ctx, params, query) {
  const month = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month : todayIso().slice(0, 7);
  const start = `${month}-01`, end = lastDayOfMonth(start);
  const ref = await loadRef(ctx.sb);
  const [payPeople, people, entries] = await Promise.all([loadPayPeople(ctx.sb, ref), loadPeople(ctx.sb, ref),
    fetchAll(() => ctx.sb.from('eppd_time_entries').select('*').eq('category', 'PT_HOURS').gte('work_date', start).lte('work_date', end))]);
  const list = hourlyPeople(payPeople, month);
  const reload = () => window.dispatchEvent(new HashChangeEvent('hashchange'));

  const monthIn = h('input', { type: 'month', value: month, 'aria-label': 'Month', style: 'width:auto' });
  monthIn.addEventListener('change', () => { if (monthIn.value) location.hash = `#/time/part-time?month=${monthIn.value}`; });
  const saveBtn = h('button', { class: 'btn primary', type: 'button' }, 'Save hours');
  const body = h('div', { class: 'table-wrap' }); const foot = h('p', { class: 'small muted' });
  el.append(pageHead('Part-time hours', `Total hours worked in ${new Date(start + 'T00:00:00').toLocaleDateString('en-MY', { month: 'long', year: 'numeric' })} by everyone paid by the hour. Type each person's total and save; the payroll uses it straight away.`,
    monthIn, h('a', { class: 'btn', href: `#/time?month=${month}` }, 'Overtime & hours'), saveBtn),
  h('section', { class: 'panel' }, body, h('div', { class: 'panel-foot' }, foot)));

  const inputs = new Map();
  const totalOf = (id) => r2(entries.filter((e) => e.employee_id === id).reduce((s, e) => s + Number(e.hours), 0));
  const dayOf = (id) => entries.filter((e) => e.employee_id === id && e.note !== MONTHLY_NOTE);
  if (!list.length) body.append(h('div', { class: 'empty-state' }, 'No one is paid by the hour this month. Hourly pay is set in the employee’s salary (pay basis: hourly).'));
  else body.append(h('table', { class: 'data pt-table' },
    h('thead', {}, h('tr', {}, ['Employee', 'Hourly rate', 'Day entries', 'Total hours this month', 'Pay for the hours'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
    h('tbody', {}, list.map((p) => {
      const cur = totalOf(p.id); const days = dayOf(p.id); const dsum = r2(days.reduce((s, e) => s + Number(e.hours), 0));
      const inp = h('input', { type: 'number', step: '0.25', min: 0, value: cur || '', placeholder: '0', 'aria-label': `Total hours for ${p.full_name}` });
      const pay = h('td', { class: 'num' }, cur ? money(cur * p.rate) : '—');
      const td = h('td', { class: 'num' }, inp);
      inp.addEventListener('input', () => { const v = Number(inp.value) || 0; pay.textContent = v ? money(v * p.rate) : '—'; td.classList.toggle('changed', v !== cur); inputs.set(p.id, { v, cur, dsum, p }); });
      return h('tr', {},
        h('td', {}, h('a', { href: `#/employees/${p.id}`, class: 'row-link' }, p.full_name), h('div', { class: 'small muted' }, p.emp_id || '')),
        h('td', { class: 'num' }, `RM${money(p.rate)}`),
        h('td', { class: 'num' }, days.length ? h('button', { class: 'linkish', type: 'button', title: 'These count in the total', onclick: () => editTimeEntry(ctx, { people, month, employeeId: p.id, category: 'PT_HOURS', onSaved: reload }) }, `${dsum} h · ${days.length} day${days.length === 1 ? '' : 's'}`)
          : h('button', { class: 'btn sm ghost', type: 'button', onclick: () => editTimeEntry(ctx, { people, month, employeeId: p.id, category: 'PT_HOURS', onSaved: reload }) }, 'Add a day')),
        td, pay);
    }))));
  foot.textContent = 'The total includes any day entries already recorded; the difference is saved as one monthly-total entry. To see or delete day entries, open Overtime & hours.';
  saveBtn.addEventListener('click', async () => {
    const changed = [...inputs.values()].filter((x) => x.v !== x.cur);
    if (!changed.length) { toast('Nothing changed.'); return; }
    saveBtn.disabled = true; let ok = 0; const bad = [];
    for (const x of changed) {
      const { error } = await savePtTotal(ctx.sb, { employeeId: x.p.id, month, total: x.v, entries });
      if (error) bad.push(`${x.p.full_name}: ${error.message}`); else ok += 1;
    }
    saveBtn.disabled = false;
    if (bad.length) toast(`${ok} saved. Not saved — ${bad.join(' · ')}`, 'error', 9000); else toast(`Hours saved for ${ok} ${ok === 1 ? 'person' : 'people'}.`);
    if (ok) reload();
  });
}
