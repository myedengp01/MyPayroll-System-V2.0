// Leave balances for everyone employed in a year
import { h, clear, pageHead, openModal, field, toast, failed } from '../ui.js';
import { loadLeaveYear, balancesFor, peopleInYear } from '../leave-data.js';
import { todayIso } from '../engines/employee.js';

export async function render(el, ctx, params, query) {
  const thisYear = Number(todayIso().slice(0, 4));
  const year = Number(query.year) || thisYear;
  const D = await loadLeaveYear(ctx.sb, year);
  const asOf = year < thisYear ? `${year}-12-31` : todayIso();
  const list = peopleInYear(D.people, year).filter((p) => query.all || p.status.key !== 'former' || year < thisYear);
  const rows = list.map((p) => ({ p, b: balancesFor(p, D, asOf) }));

  const yearSel = h('select', { 'aria-label': 'Year', style: 'width:auto' }, [thisYear - 1, thisYear, thisYear + 1].map((y) => h('option', { value: y, selected: y === year }, y)));
  yearSel.addEventListener('change', () => { location.hash = `#/leave/balances?year=${yearSel.value}`; });
  const search = h('input', { type: 'search', placeholder: 'Search name or ID', 'aria-label': 'Search' });
  const body = h('div', { class: 'table-wrap' });
  const needHours = rows.filter((r) => r.b.AL.needsHours).length;

  el.append(pageHead('Leave balances', `Position as at ${asOf}. Annual leave uses your AL calculator rules; sick, hospitalisation, maternity and paternity follow the Employment Act; compassionate leave follows company policy.`,
    yearSel, h('button', { class: 'btn', type: 'button', onclick: exportCsv }, 'Export')),
  needHours ? h('p', { class: 'setup-warning', style: 'margin-bottom:1rem' }, `${needHours} part-timer${needHours > 1 ? 's have' : ' has'} no weekly hours recorded, so full-time entitlements are shown. Add weekly hours in their Employment tab to pro-rate leave as the Employment Act requires.`) : null,
  h('section', { class: 'panel' }, h('div', { class: 'panel-head filters' }, h('div', { class: 'filter-row', style: 'justify-content:flex-start' }, search)), body));

  function draw() {
    const q = search.value.trim().toLowerCase();
    const shown = rows.filter((r) => !q || `${r.p.full_name} ${r.p.emp_id}`.toLowerCase().includes(q));
    clear(body);
    if (!shown.length) { body.append(h('div', { class: 'empty-state' }, 'No one to show.')); return; }
    const neg = (n) => (n < 0 ? 'neg' : '');
    body.append(h('table', { class: 'data bal-table' },
      h('thead', {},
        h('tr', {}, h('th', { rowspan: 2 }, 'Employee'), h('th', { colspan: 5, class: 'grp' }, 'Annual leave'), h('th', { colspan: 3, class: 'grp' }, 'Sick'),
          h('th', { class: 'grp' }, 'Hosp.'), h('th', { class: 'grp' }, 'Compass.'), h('th', { class: 'grp' }, 'Repl.'), h('th', { rowspan: 2 }, '')),
        h('tr', {}, ['Entitled', 'Carried', 'Taken', 'Other', 'Balance', 'Entitled', 'Taken', 'Balance', 'Left', 'Left', 'Balance'].map((t) => h('th', { class: 'num' }, t)))),
      h('tbody', {}, shown.map(({ p, b }) => h('tr', {},
        h('td', {}, h('a', { href: `#/employees/${p.id}?tab=leave`, class: 'row-link' }, p.full_name),
          h('div', { class: 'small muted' }, [p.emp_id, p.employment?.job_status === 'PT' ? 'Part-time' : null, p.status.key === 'former' ? 'Left' : null].filter(Boolean).join(' · '))),
        h('td', { class: 'num' }, b.AL.entitled, b.AL.needsHours ? h('span', { class: 'tag warn', title: 'Part-timer without weekly hours: full-time entitlement shown' }, '!') : null),
        h('td', { class: 'num' }, b.AL.carried || ''), h('td', { class: 'num' }, b.AL.taken || ''),
        h('td', { class: 'num', title: 'Manual adjustments, buy-back, forfeited or expired days' }, (b.AL.adjusted - b.AL.buyback - b.AL.forfeit - b.AL.carriedExpired) || ''),
        h('td', { class: `num strong ${neg(b.AL.balance)}` }, b.AL.balance),
        h('td', { class: 'num' }, b.SL.entitled), h('td', { class: 'num' }, b.SL.taken || ''), h('td', { class: `num strong ${neg(b.SL.balance)}` }, b.SL.balance),
        h('td', { class: `num ${neg(b.HPL.balance)}` }, b.HPL.balance), h('td', { class: `num ${neg(b.CPL.balance)}` }, b.CPL.balance), h('td', { class: `num ${neg(b.RL.balance)}` }, b.RL.balance || ''),
        h('td', { class: 'actions' }, h('a', { class: 'btn sm', href: `#/leave/al-calculator?emp=${p.id}&year=${year}` }, 'Breakdown'),
          h('button', { class: 'btn sm ghost', type: 'button', onclick: () => adjust(p) }, 'Adjust')))))));
  }
  search.addEventListener('input', draw);
  draw();

  function adjust(p) {
    const F = {
      leave_type: field('Leave type', { type: 'select', value: 'AL', options: [['AL', 'Annual'], ['RL', 'Replacement'], ['SL', 'Sick'], ['CPL', 'Compassionate']] }),
      kind: field('What', { type: 'select', value: 'manual', options: [['manual', 'Correction (+ adds, − removes)'], ['earned', 'Replacement leave earned'], ['opening', 'Opening / brought-forward balance'], ['forfeit', 'Forfeit days'], ['buyback', 'Buy back days']] }),
      days: field('Days', { type: 'number', step: '0.5', required: true }),
      buyback_pct: field('Buy-back rate (%)', { type: 'number', value: 100, hint: 'Only for buy-back.' }),
      effective_date: field('Date', { type: 'date', value: asOf }),
      note: field('Reason', { type: 'textarea', span2: true, required: true }),
    };
    openModal({ title: `Adjust leave · ${p.full_name}`, body: h('div', { class: 'form-grid' }, Object.values(F)),
      actions: [{ label: 'Save adjustment', primary: true, onClick: async (close) => {
        const v = Object.fromEntries(Object.entries(F).map(([k, f]) => [k, f.getValue()]));
        if (v.days === null || !v.note) { toast('Days and a reason are required.', 'error'); return false; }
        if (v.kind !== 'buyback') v.buyback_pct = null;
        const { error } = await ctx.sb.from('eppd_leave_adjustments').insert({ ...v, employee_id: p.id, year, source: 'manual' });
        if (failed(error)) return false;
        toast('Adjustment saved.'); close(); window.dispatchEvent(new HashChangeEvent('hashchange')); return true;
      } }] });
  }

  function exportCsv() {
    const head = ['Employee ID', 'Name', 'AL entitled', 'AL carried', 'AL taken', 'AL other', 'AL balance', 'SL entitled', 'SL taken', 'SL balance', 'HPL left', 'CPL left', 'RL balance'];
    const lines = rows.map(({ p, b }) => [p.emp_id || '', p.full_name, b.AL.entitled, b.AL.carried, b.AL.taken, b.AL.adjusted - b.AL.buyback - b.AL.forfeit - b.AL.carriedExpired,
      b.AL.balance, b.SL.entitled, b.SL.taken, b.SL.balance, b.HPL.balance, b.CPL.balance, b.RL.balance].map((x) => (/[",]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : x)).join(','));
    const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + [head.join(','), ...lines].join('\r\n')], { type: 'text/csv' })), download: `leave-balances-${year}.csv` });
    document.body.append(a); a.click(); a.remove();
  }
}
