// Leave by month (audit): for one month and one leave type, everyone's entitlement, leave taken in the month,
// taken to date and the balance at the month end. Admin / HR can correct a month; every correction needs a reason,
// is kept with the leave record (note) and lands in the audit log.
import { h, clear, pageHead, toast, failed, openModal, field } from '../ui.js';
import { loadLeaveYear, peopleInYear, leaveForMonth, MONTH_TYPES } from '../leave-data.js';
import { todayIso, lastDayOfMonth } from '../engines/employee.js';

const r2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const isCorrection = (x) => /^Correction|· Correction/.test(x.note || '');

export async function render(el, ctx, params, query) {
  const month = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month : todayIso().slice(0, 7);
  const type = MONTH_TYPES.some(([t]) => t === query.type) ? query.type : 'AL';
  const start = `${month}-01`, end = lastDayOfMonth(start), year = Number(month.slice(0, 4));
  const D = await loadLeaveYear(ctx.sb, year);
  const list = peopleInYear(D.people, year).filter((p) => {
    const e = p.employment || {}; return (!e.join_date || e.join_date <= end) && (!e.resigned_date || e.resigned_date >= start);
  });
  const rows = list.map((p) => ({ p, m: leaveForMonth(p, D, start) }));
  const corrections = (p) => [...D.records.filter((r) => r.employee_id === p.id && r.leave_type === type && isCorrection(r)),
    ...D.adjustments.filter((a) => a.employee_id === p.id && a.leave_type === type && isCorrection(a))];
  const label = Object.fromEntries(MONTH_TYPES)[type];
  const go = (q) => { location.hash = `#/leave/audit?${new URLSearchParams({ month, type, ...q })}`; };

  const monthIn = h('input', { type: 'month', value: month, 'aria-label': 'Month', style: 'width:auto' });
  monthIn.addEventListener('change', () => { if (monthIn.value) go({ month: monthIn.value }); });
  const tabs = h('div', { class: 'seg-tabs' }, MONTH_TYPES.map(([t, l]) => h('button', { type: 'button', class: `btn sm ${t === type ? 'primary' : 'ghost'}`, onclick: () => go({ type: t }) }, l)));
  const search = h('input', { type: 'search', placeholder: 'Search name or ID', 'aria-label': 'Search' });
  const body = h('div', { class: 'table-wrap' });
  const monthName = new Date(start + 'T00:00:00').toLocaleDateString('en-MY', { month: 'long', year: 'numeric' });
  el.append(pageHead('Leave by month (audit)', `${label} in ${monthName}: entitlement for ${year}, leave taken in the month, taken to date and the balance on ${end}. Click Correct to fix a month; a reason is required and kept in the audit log. Payslips use these figures.`,
    monthIn, h('button', { class: 'btn', type: 'button', onclick: exportCsv }, 'Export')),
  h('section', { class: 'panel' }, h('div', { class: 'panel-head filters' }, h('div', { class: 'filter-row', style: 'justify-content:flex-start;gap:.6rem;flex-wrap:wrap' }, tabs, search)), body));

  const unpaid = type === 'UPL';
  function draw() {
    const q = search.value.trim().toLowerCase();
    const shown = rows.filter((r) => !q || `${r.p.full_name} ${r.p.emp_id}`.toLowerCase().includes(q));
    clear(body);
    if (!shown.length) { body.append(h('div', { class: 'empty-state' }, 'No one to show.')); return; }
    body.append(h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Employee'), ...[unpaid ? null : `Entitled ${year}`, `Taken ${monthName}`, 'Taken to date', unpaid ? null : `Balance ${end}`].filter(Boolean).map((t) => h('th', { class: 'num' }, t)), h('th', {}, 'Corrections'), h('th', {}))),
      h('tbody', {}, shown.map(({ p, m }) => {
        const x = m[type]; const c = corrections(p);
        return h('tr', {},
          h('td', {}, h('a', { href: `#/employees/${p.id}?tab=leave`, class: 'row-link' }, p.full_name),
            h('div', { class: 'small muted' }, [p.emp_id, p.employment?.job_status === 'PT' ? 'Part-time' : null, x.needsHours ? 'no weekly hours: full-time entitlement' : null].filter(Boolean).join(' · '))),
          unpaid ? null : h('td', { class: 'num' }, x.entitled ?? '—', type === 'AL' && x.carried ? h('div', { class: 'small muted' }, `incl. ${x.carried} b/f`) : null),
          h('td', { class: 'num strong' }, x.month || ''), h('td', { class: 'num' }, x.toDate || ''),
          unpaid ? null : h('td', { class: `num strong ${x.balance < 0 ? 'neg' : ''}` }, x.balance),
          h('td', { class: 'small' }, c.length ? `${c.length} correction${c.length === 1 ? '' : 's'}` : ''),
          h('td', { class: 'actions' }, h('button', { class: 'btn sm', type: 'button', onclick: () => correct(p, x, c) }, 'Correct')));
      }))));
  }
  search.addEventListener('input', draw);
  draw();

  function correct(p, x, hist) {
    const F = {
      taken: field(`${label} taken in ${monthName} (days)`, { type: 'number', step: '0.5', min: 0, value: x.month || 0 }),
      balance: unpaid ? null : field(`Balance on ${end} (days)`, { type: 'number', step: '0.5', value: x.balance, hint: 'Change only if the balance itself is wrong (e.g. brought forward or entitlement). A change in leave taken moves the balance by itself.' }),
      reason: field('Reason (required, kept in the audit log)', { type: 'textarea', required: true, span2: true }),
    };
    const info = h('p', { class: 'small muted span-2' }, `Now: taken this month ${x.month || 0}, taken to date ${x.toDate || 0}${unpaid ? '' : `, balance ${x.balance}`}.`);
    const histBox = hist.length ? h('details', { class: 'span-2' }, h('summary', { class: 'linkish' }, `Earlier corrections (${hist.length})`),
      h('ul', { style: 'margin:.4rem 0 0 1rem' }, hist.map((r) => h('li', { class: 'small' }, `${r.date_from || r.effective_date}: ${r.note}`)))) : null;
    openModal({ title: `Correct ${label.toLowerCase()} · ${p.full_name} · ${monthName}`, wide: true,
      body: h('div', { class: 'form-grid' }, info, F.taken, F.balance, F.reason, histBox),
      actions: [{ label: 'Save correction', primary: true, onClick: async (close) => {
        const reason = (F.reason.getValue() || '').trim();
        if (reason.length < 3) { toast('Give the reason for the correction.', 'error'); return false; }
        const newTaken = r2(Number(F.taken.getValue()) || 0); const dTaken = r2(newTaken - (x.month || 0));
        const note = `Correction ${month}: ${reason}`;
        let changed = dTaken !== 0;
        // 1) leave taken in the month
        if (dTaken > 0) {
          const { error } = await ctx.sb.from('eppd_leave_records').insert({ employee_id: p.id, leave_type: type, date_from: start, date_to: start, days: dTaken, days_override: true, status: 'taken', source: 'manual', note });
          if (failed(error)) return false;
        } else if (dTaken < 0) {
          let left = -dTaken;
          const recs = D.records.filter((r) => r.employee_id === p.id && r.leave_type === type && r.status !== 'cancelled' && r.date_from >= start && r.date_from <= end)
            .sort((a, b) => String(b.date_from).localeCompare(String(a.date_from)));
          for (const r of recs) {
            if (left <= 0) break;
            const cut = Math.min(Number(r.days), left); left = r2(left - cut);
            const { error } = await ctx.sb.from('eppd_leave_records').update({ days: r2(Number(r.days) - cut), days_override: true, note: `${r.note ? `${r.note} · ` : ''}Correction ${month}: −${cut} (${reason})` }).eq('id', r.id);
            if (failed(error)) return false;
          }
        }
        // 2) balance (after the change in leave taken)
        if (!unpaid) {
          // only when the balance box itself was changed: the new leave taken already moves the balance
          const typedBal = F.balance.getValue();
          const want = r2(Number(typedBal));
          const diff = r2(want - x.balance);
          if (typedBal !== null && typedBal !== '' && Math.abs(diff) >= 0.01) {
            const { error } = await ctx.sb.from('eppd_leave_adjustments').insert({ employee_id: p.id, leave_type: type, year, kind: 'manual', days: diff, effective_date: end, source: 'manual', note });
            if (failed(error)) return false;
            changed = true;
          }
        }
        if (!changed) { toast('Nothing changed.'); return false; }
        toast('Correction saved.'); close(); window.dispatchEvent(new HashChangeEvent('hashchange')); return true;
      } }] });
  }

  function exportCsv() {
    const head = ['Employee ID', 'Name', 'Leave type', 'Month', 'Entitled', 'Taken this month', 'Taken to date', 'Balance at month end', 'Corrections'];
    const data = rows.map(({ p, m }) => { const x = m[type]; return [p.emp_id || '', p.full_name, label, month, x.entitled ?? '', x.month, x.toDate, x.balance ?? '', corrections(p).length]; });
    const csv = [head, ...data].map((r) => r.map((v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n');
    const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })), download: `leave_${type}_${month}.csv` }); document.body.append(a); a.click(); a.remove();
  }
}
