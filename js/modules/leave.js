// Leave records: list, record leave (auto day count, override), edit, cancel
import { h, clear, pageHead, fmtDate, openModal, field, toast, failed, confirmDialog } from '../ui.js';
import { loadLeaveYear, balancesFor, loadHolidaySet, LEAVE_LABELS, peopleInYear } from '../leave-data.js';
import { countLeaveDays } from '../engines/leave.js';
import { todayIso } from '../engines/employee.js';

export async function render(el, ctx, params, query) {
  const year = Number(query.year) || Number(todayIso().slice(0, 4));
  const D = await loadLeaveYear(ctx.sb, year);
  const holidays = await loadHolidaySet(ctx.sb, [year - 1, year, year + 1]);
  const ww = D.ref.policies.working_week || { rest_days: [0], off_days: [6] };
  const byId = new Map(D.people.map((p) => [p.id, p]));
  const st = { type: query.type || '', q: query.q || '', emp: query.emp ? Number(query.emp) : null };

  const yearSel = h('select', { 'aria-label': 'Year', style: 'width:auto' }, [year - 1, year, year + 1].map((y) => h('option', { value: y, selected: y === year }, y)));
  yearSel.addEventListener('change', () => { location.hash = `#/leave?year=${yearSel.value}`; });
  const typeSel = h('select', { 'aria-label': 'Leave type', style: 'width:auto' }, h('option', { value: '' }, 'All types'),
    Object.entries(LEAVE_LABELS).map(([k, l]) => h('option', { value: k, selected: k === st.type }, l)));
  const search = h('input', { type: 'search', placeholder: 'Search name or ID', 'aria-label': 'Search', value: st.q });
  const body = h('div', { class: 'table-wrap' }); const foot = h('p', { class: 'small muted' });

  el.append(
    pageHead('Leave records', `Leave taken in ${year}. Days are counted Monday to Friday, skipping Saturday (off day), Sunday (rest day) and public holidays; maternity and paternity count calendar days.`,
      yearSel, h('button', { class: 'btn primary', type: 'button', onclick: () => openRecord(null) }, 'Record leave')),
    h('section', { class: 'panel' }, h('div', { class: 'panel-head filters' }, h('div', { class: 'filter-row', style: 'justify-content:flex-start' }, search, typeSel)), body, h('div', { class: 'panel-foot' }, foot)));

  function draw() {
    const q = st.q.trim().toLowerCase();
    const list = D.records.filter((r) => (!st.type || r.leave_type === st.type) && (!st.emp || r.employee_id === st.emp)
      && (!q || `${byId.get(r.employee_id)?.full_name} ${byId.get(r.employee_id)?.emp_id}`.toLowerCase().includes(q)));
    foot.textContent = `${list.length} record${list.length === 1 ? '' : 's'} · ${list.filter((r) => r.status !== 'cancelled').reduce((s, r) => s + Number(r.days), 0)} days`;
    clear(body);
    if (!list.length) { body.append(h('div', { class: 'empty-state' }, D.records.length ? 'No leave matches these filters.' : `No leave recorded for ${year} yet.`)); return; }
    body.append(h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Employee'), h('th', {}, 'Type'), h('th', {}, 'Dates'), h('th', { class: 'num' }, 'Days'), h('th', {}, 'Note'), h('th', {}))),
      h('tbody', {}, list.map((r) => {
        const p = byId.get(r.employee_id);
        return h('tr', { class: r.status === 'cancelled' ? 'inactive' : '' },
          h('td', {}, h('a', { href: `#/employees/${r.employee_id}?tab=leave`, class: 'row-link' }, p?.full_name || '?'), h('div', { class: 'small muted' }, p?.emp_id || '')),
          h('td', {}, LEAVE_LABELS[r.leave_type] || r.leave_type, r.status === 'cancelled' ? h('span', { class: 'tag', style: 'margin-left:.4rem' }, 'Cancelled') : null),
          h('td', { class: 'nowrap' }, r.source === 'import' ? `${new Date(r.date_from + 'T00:00:00').toLocaleDateString('en-MY', { month: 'long', year: 'numeric' })} (total)` :
            r.date_from === r.date_to ? fmtDate(r.date_from) + (r.half_day !== 'none' ? ` (${r.half_day.toUpperCase()})` : '') : `${fmtDate(r.date_from)} – ${fmtDate(r.date_to)}`),
          h('td', { class: 'num' }, Number(r.days), r.days_override && r.source !== 'import' ? h('span', { class: 'small muted', title: 'Typed by HR' }, ' *') : null),
          h('td', { class: 'small muted' }, r.note || ''),
          h('td', { class: 'actions' }, h('button', { class: 'btn sm', type: 'button', onclick: () => openRecord(r) }, 'Edit'),
            h('button', { class: 'btn sm ghost', type: 'button', onclick: () => remove(r) }, 'Delete')));
      }))));
  }
  search.addEventListener('input', () => { st.q = search.value; draw(); });
  typeSel.addEventListener('change', () => { st.type = typeSel.value; draw(); });
  draw();

  async function remove(r) {
    if (!(await confirmDialog('Delete leave record', `Delete this ${LEAVE_LABELS[r.leave_type]} leave (${r.days} days)? To keep a trace, edit it and mark it cancelled instead.`, 'Delete', true))) return;
    const { error } = await ctx.sb.from('eppd_leave_records').delete().eq('id', r.id);
    if (!failed(error, 'Delete')) { toast('Deleted.'); window.dispatchEvent(new HashChangeEvent('hashchange')); }
  }

  function openRecord(r) { openLeaveForm(ctx, D, holidays, ww, r, { employeeId: st.emp, onSaved: () => window.dispatchEvent(new HashChangeEvent('hashchange')) }); }
}

/** Record / edit leave. Shared with the employee profile's Leave tab. */
export function openLeaveForm(ctx, D, holidays, ww, r, { employeeId = null, onSaved } = {}) {
  const current = peopleInYear(D.people, D.year).filter((p) => p.status.key !== 'former' || (r && p.id === r.employee_id) || p.id === employeeId);
  const F = {
    employee_id: field('Employee', { type: 'select', required: true, value: r?.employee_id ?? employeeId ?? '',
      options: [['', 'Choose…'], ...current.map((p) => [p.id, `${p.full_name}${p.emp_id ? ` (${p.emp_id})` : ''}`])], span2: true }),
    leave_type: field('Leave type', { type: 'select', value: r?.leave_type || 'AL', options: Object.entries(LEAVE_LABELS) }),
    half_day: field('Half day', { type: 'select', value: r?.half_day || 'none', options: [['none', 'Full day(s)'], ['am', 'Morning only'], ['pm', 'Afternoon only']] }),
    date_from: field('From', { type: 'date', required: true, value: r?.date_from || todayIso() }),
    date_to: field('To', { type: 'date', required: true, value: r?.date_to || todayIso() }),
    days: field('Days', { type: 'number', step: '0.5', value: r?.days ?? '' }),
    status: field('Status', { type: 'select', value: r?.status || 'taken', options: [['taken', 'Taken'], ['cancelled', 'Cancelled']] }),
    note: field('Note', { type: 'textarea', value: r?.note, span2: true }),
  };
  let override = !!r?.days_override;
  const auto = h('p', { class: 'small muted span-2' });
  const balBox = h('div', { class: 'span-2 bal-box' });
  const recompute = () => {
    const type = F.leave_type.getValue(); const from = F.date_from.getValue(); const to = F.date_to.getValue() || from;
    if (F.half_day.getValue() !== 'none' && to !== from) { F.date_to.input.value = from; }
    const n = countLeaveDays(from, F.date_to.getValue() || from, { holidays, restDays: ww.rest_days, offDays: ww.off_days,
      calendar: ['MTL', 'PTL'].includes(type), halfDay: F.half_day.getValue() });
    auto.textContent = `Automatic count: ${n} day${n === 1 ? '' : 's'}${['MTL', 'PTL'].includes(type) ? ' (calendar days)' : ' (Mon–Fri, excluding public holidays)'}.` + (override ? ' You typed your own number.' : '');
    if (!override) F.days.input.value = n;
    drawBalance();
  };
  F.days.input.addEventListener('input', () => { override = true; recompute(); });
  ['leave_type', 'date_from', 'date_to', 'half_day', 'employee_id'].forEach((k) => F[k].input.addEventListener('change', recompute));
  function drawBalance() {
    const p = D.people.find((x) => x.id === Number(F.employee_id.getValue()));
    clear(balBox); if (!p) return;
    const b = balancesFor(p, D);
    const t = F.leave_type.getValue();
    const line = t === 'AL' ? `Annual leave left in ${D.year}: ${b.AL.balance} of ${b.AL.entitled + b.AL.carried} days` :
      t === 'SL' ? `Sick leave left: ${b.SL.balance} of ${b.SL.entitled} days` : t === 'HPL' ? `Hospitalisation pool left (shared with sick leave): ${b.HPL.balance} days` :
      t === 'CPL' ? `Compassionate leave left this year: ${b.CPL.balance} of ${b.CPL.entitled} (${b.CPL.perEvent} per occasion)` :
      t === 'RL' ? `Replacement leave balance: ${b.RL.balance} days` : t === 'MTL' ? `Maternity: ${b.MTL.perEvent} consecutive days per confinement` :
      t === 'PTL' ? `Paternity: ${b.PTL.perEvent} consecutive days per birth${b.PTL.eligible === false ? ' (not eligible: needs 12 months’ service and male)' : ''}` : 'Unpaid leave';
    balBox.append(h('p', { class: 'notice-calc' }, line));
  }
  openModal({ title: r ? 'Edit leave' : 'Record leave', wide: true, body: h('div', { class: 'form-grid' }, Object.values(F).slice(0, 6), auto, F.status, balBox, F.note),
    actions: [{ label: r ? 'Save changes' : 'Record leave', primary: true, onClick: async (close) => {
      const v = Object.fromEntries(Object.entries(F).map(([k, f]) => [k, f.getValue()]));
      if (!v.employee_id || !v.date_from) { toast('Choose the employee and the dates.', 'error'); return false; }
      v.date_to = v.date_to || v.date_from; v.employee_id = Number(v.employee_id);
      if (v.date_to < v.date_from) { toast('“To” must be on or after “From”.', 'error'); return false; }
      if (v.days === null) { toast('Days is required.', 'error'); return false; }
      v.days_override = override;
      const q = r ? ctx.sb.from('eppd_leave_records').update(v).eq('id', r.id) : ctx.sb.from('eppd_leave_records').insert(v);
      const { error } = await q; if (failed(error)) return false;
      toast(r ? 'Leave updated.' : 'Leave recorded.'); close(); onSaved?.(); return true;
    } }] });
  recompute();
}
