// Monthly payroll: list of months, and the pay run for one month (prepare → finalise)
import { h, clear, pageHead, toast, failed, confirmDialog, openModal, field, money, fmtDateTime, switchToggle } from '../ui.js';
import { fetchAll } from '../data.js';
import { loadPayMonth } from '../pay-data.js';
import { buildRun, recomputeLine, runTotals, lineSummary, groupItems, itemFromType, itemAmount, monthLabel, periodOf, STAT_KEYS, STAT_LABELS, r2 } from '../engines/payroll.js';
import { todayIso, addDays } from '../engines/employee.js';

const ym = (period) => String(period).slice(0, 7);
const nextPeriod = (period) => periodOf(addDays(periodOf(period), 32));
const statusTag = (run) => !run ? h('span', { class: 'tag' }, 'Not started')
  : run.status === 'finalised' ? h('span', { class: 'tag ok' }, run.source === 'import' ? 'Finalised · imported' : 'Finalised')
  : h('span', { class: 'tag warn' }, 'Draft');

// ============================================================ list of months
export async function render(el, ctx, params, query) {
  if (params.period) return renderRun(el, ctx, params.period);
  const runs = await fetchAll(() => ctx.sb.from('eppd_pay_runs').select('id,period,status,source,totals,finalised_at,updated_at').order('period', { ascending: false }));
  const thisMonth = periodOf(todayIso());
  const next = runs.length ? nextPeriod(runs[0].period) : thisMonth;
  const pick = h('input', { type: 'month', value: ym(next), 'aria-label': 'Month', style: 'width:auto' });
  const open = h('button', { class: 'btn', type: 'button', onclick: () => { if (pick.value) location.hash = `#/payroll/${pick.value}`; } }, 'Open month');
  el.append(pageHead('Monthly payroll', 'One pay run a month. Each line is one employee paid by one company. Prepare the month, check it, then finalise it to lock it.',
    pick, open, h('a', { class: 'btn primary', href: `#/payroll/${ym(next)}` }, runs.some((r) => r.period === next) ? `Open ${monthLabel(next)}` : `Start ${monthLabel(next)}`)));
  if (!runs.length) {
    el.append(h('div', { class: 'empty-state' }, h('p', {}, 'No payroll months yet.'),
      ctx.can(['admin']) ? h('p', {}, 'Bring in January–September 2026 from the workbook first: ', h('a', { href: '#/payroll/import' }, 'Payroll › Import past months'), '.') : null));
    return;
  }
  const t = (r, k) => money(r.totals?.all?.[k] ?? 0);
  el.append(h('section', { class: 'panel' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data clickable' },
    h('thead', {}, h('tr', {}, ['Month', 'Status', 'Staff', 'Gross', 'EPF', 'SOCSO', 'EIS', 'PCB', 'Net paid', 'Last change'].map((x, i) => h('th', { class: i >= 2 && i <= 8 ? 'num' : '' }, x)))),
    h('tbody', {}, runs.map((r) => {
      const a = r.totals?.all || {};
      const tr = h('tr', {},
        h('td', {}, h('a', { href: `#/payroll/${ym(r.period)}`, class: 'row-link' }, monthLabel(r.period))), h('td', {}, statusTag(r)),
        h('td', { class: 'num' }, a.lines ?? ''), h('td', { class: 'num' }, t(r, 'gross')),
        h('td', { class: 'num' }, money((a.epf_ee || 0) + (a.epf_er || 0))), h('td', { class: 'num' }, money((a.socso_ee || 0) + (a.socso_er || 0))),
        h('td', { class: 'num' }, money((a.eis_ee || 0) + (a.eis_er || 0))), h('td', { class: 'num' }, t(r, 'pcb')), h('td', { class: 'num strong' }, t(r, 'net_paid')),
        h('td', { class: 'small muted' }, fmtDateTime(r.finalised_at || r.updated_at)));
      tr.addEventListener('click', (e) => { if (!e.target.closest('a')) location.hash = `#/payroll/${ym(r.period)}`; });
      return tr;
    }))))));
}

// ============================================================ one month
async function renderRun(el, ctx, param) {
  if (!/^\d{4}-\d{2}$/.test(param)) { el.append(h('div', { class: 'empty-state' }, 'Month not recognised.')); return; }
  const D = await loadPayMonth(ctx.sb, `${param}-01`);
  const run = D.run;
  const locked = run?.status === 'finalised';
  const isAdmin = ctx.can(['admin']);
  let lines; let dirty = false; let refreshed = false; let notices = [];
  if (locked) lines = run.lines;
  else {
    const res = buildRun(D);
    lines = res.lines; notices = res.notices || [];
    if (!run) dirty = true;
    else {
      const before = JSON.stringify(runTotals(run.lines).all), after = JSON.stringify(runTotals(lines).all);
      if (before !== after || run.lines.length !== lines.length) { dirty = true; refreshed = true; }
    }
  }
  const companyName = (id) => D.companies.get(Number(id))?.short_name || D.companies.get(Number(id))?.name || (id ? `Company ${id}` : 'No company');

  const head = h('div', {}); const notice = h('div', {}); const facts = h('div', { class: 'facts' }); const compBox = h('section', { class: 'panel' });
  const search = h('input', { type: 'search', placeholder: 'Search name or ID', 'aria-label': 'Search' });
  let onlyWarn = false;
  const warnToggle = h('label', { class: 'check-row small' }, switchToggle(false, (v) => { onlyWarn = v; drawLines(); }, { label: 'Only lines with warnings' }), 'Only lines with warnings');
  const linesBody = h('div', { class: 'table-wrap' });
  const bar = h('div', { class: 'import-bar' });
  el.append(head, notice, facts, compBox,
    h('section', { class: 'panel' }, h('div', { class: 'panel-head filters' }, h('div', { class: 'filter-row', style: 'justify-content:flex-start;gap:1rem' }, search, warnToggle)), linesBody), bar);
  search.addEventListener('input', drawLines);

  const leaveGuard = (e) => { if (dirty && !locked) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', leaveGuard);
  const offHash = () => { window.removeEventListener('beforeunload', leaveGuard); window.removeEventListener('hashchange', offHash); };
  window.addEventListener('hashchange', offHash);

  function drawHead() {
    const actions = [];
    actions.push(h('button', { class: 'btn', type: 'button', onclick: exportCsv }, 'Export CSV'));
    if (!locked) {
      actions.push(h('button', { class: 'btn', type: 'button', onclick: recalc }, 'Recalculate'));
      if (run) actions.push(h('button', { class: 'btn danger', type: 'button', onclick: deleteDraft }, 'Delete draft'));
    } else if (isAdmin) actions.push(h('button', { class: 'btn', type: 'button', onclick: reopen }, 'Reopen'));
    clear(head).append(h('p', { class: 'crumbs' }, h('a', { href: '#/payroll' }, 'Monthly payroll'), ` / ${monthLabel(D.period)}`),
      pageHead(`Payroll · ${monthLabel(D.period)}`, locked
        ? `Finalised${run.finalised_at ? ` on ${fmtDateTime(run.finalised_at)}` : ''}. This month is locked${isAdmin ? '; an admin can reopen it with a reason' : ''}.`
        : 'Figures come from salary history, allowances, unpaid leave and overtime & hours. Click a line to add one-off items (bonus, commission, MVC…), type PCB or adjust an amount.',
      statusTag(run), ...actions));
    const n = [];
    if (refreshed) n.push(h('p', { class: 'setup-warning', style: 'margin-bottom:1rem' }, 'Figures were refreshed from the latest salary, leave and overtime records since this draft was saved. Save to keep them.'));
    if (run?.reopen_reason && !locked) n.push(h('p', { class: 'setup-warning', style: 'margin-bottom:1rem' }, `Reopened by an admin: ${run.reopen_reason}`));
    for (const t of locked ? [] : notices) n.push(h('p', { class: 'setup-warning', style: 'margin-bottom:1rem' }, t));
    if (locked && run.source === 'import') n.push(h('p', { class: 'small muted', style: 'margin-bottom:1rem' }, 'Imported from the MEG-EPPD workbook: the figures are exactly as the workbook calculated them.'));
    clear(notice).append(...n);
  }

  function drawTotals() {
    const T = runTotals(lines); const a = T.all;
    const warnLines = lines.filter((l) => !l.excluded && (l.warnings || []).some((w) => w.level === 'warn')).length;
    clear(facts).append(...[[a.lines, 'staff paid'], [money(a.gross), 'gross pay'], [money(a.epf_ee + a.epf_er), 'EPF (both shares)'],
      [money(a.socso_ee + a.socso_er), 'SOCSO (both shares)'], [money(a.eis_ee + a.eis_er), 'EIS (both shares)'], [money(a.pcb), 'PCB'],
      [money(a.net_paid), 'net paid to staff'], [money(a.employer_cost), 'total employer cost'], [warnLines, 'lines with warnings']]
      .map(([v, l]) => h('div', { class: `fact ${l.includes('warnings') && v ? 'bad' : ''}` }, h('b', {}, v), h('span', {}, l))));
    const ids = Object.keys(T.companies);
    clear(compBox).append(h('div', { class: 'panel-head' }, h('h2', {}, 'By paying company')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ['Company', 'Staff', 'Gross', 'EPF ee', 'EPF er', 'SOCSO ee', 'SOCSO er', 'EIS ee', 'EIS er', 'PCB', 'Net paid'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
        h('tbody', {}, ids.map((id) => { const c = T.companies[id];
          return h('tr', {}, h('td', {}, companyName(id)), h('td', { class: 'num' }, c.lines), ...['gross', 'epf_ee', 'epf_er', 'socso_ee', 'socso_er', 'eis_ee', 'eis_er', 'pcb'].map((k) => h('td', { class: 'num' }, money(c[k]))), h('td', { class: 'num strong' }, money(c.net_paid))); })),
        h('tfoot', {}, h('tr', {}, h('th', {}, 'Total'), h('th', { class: 'num' }, a.lines), ...['gross', 'epf_ee', 'epf_er', 'socso_ee', 'socso_er', 'eis_ee', 'eis_er', 'pcb', 'net_paid'].map((k) => h('th', { class: 'num' }, money(a[k]))))))));
  }

  function drawLines() {
    const q = search.value.trim().toLowerCase();
    const shown = lines.filter((l) => (!q || `${l.emp_name} ${l.emp_code || ''}`.toLowerCase().includes(q)) && (!onlyWarn || (l.warnings || []).some((w) => w.level === 'warn')));
    clear(linesBody).append(h('table', { class: 'data clickable' },
      h('thead', {}, h('tr', {}, ['Employee', 'Company', 'Basic', 'Overtime', 'Other pay', 'Unpaid leave', 'Gross', 'EPF', 'SOCSO', 'EIS', 'PCB', 'Net paid'].map((x, i) => h('th', { class: i >= 2 ? 'num' : '' }, x)))),
      h('tbody', {}, shown.length ? shown.map((l) => {
        const s = lineSummary(l); const warn = (l.warnings || []).filter((w) => w.level === 'warn').length;
        const tr = h('tr', { class: l.excluded ? 'inactive' : '' },
          h('td', {}, h('span', { class: 'strong' }, l.emp_name), warn ? h('span', { class: 'tag warn', style: 'margin-left:.4rem', title: l.warnings.map((w) => w.text).join('\n') }, `${warn} warning${warn > 1 ? 's' : ''}`) : null,
            l.excluded ? h('span', { class: 'tag', style: 'margin-left:.4rem' }, 'Left out') : null, h('div', { class: 'small muted' }, l.emp_code || '')),
          h('td', { class: 'small' }, companyName(l.company_id)),
          h('td', { class: 'num' }, money(s.basic)), h('td', { class: 'num' }, s.overtime ? money(s.overtime) : ''), h('td', { class: 'num' }, s.other ? money(s.other) : ''),
          h('td', { class: 'num' }, s.unpaid ? `−${money(s.unpaid)}` : ''), h('td', { class: 'num' }, money(l.gross)),
          h('td', { class: 'num' }, money(l.epf_ee)), h('td', { class: 'num' }, money(l.socso_ee)), h('td', { class: 'num' }, money(l.eis_ee)),
          h('td', { class: 'num' }, l.pcb ? money(l.pcb) : ''), h('td', { class: 'num strong' }, money(l.net_paid)));
        tr.addEventListener('click', () => openLine(l));
        return tr;
      }) : h('tr', {}, h('td', { colspan: 12, class: 'muted' }, lines.length ? 'No lines match.' : 'Nobody is employed in this month.')))));
  }

  function drawBar() {
    if (locked) { clear(bar).append(h('p', { class: 'small muted' }, 'Finalised months cannot be changed. Corrections go into the next month.')); return; }
    const save = h('button', { class: 'btn', type: 'button', onclick: () => saveRun() }, run ? 'Save draft' : 'Save as draft');
    const fin = h('button', { class: 'btn primary', type: 'button', onclick: finalise }, `Finalise ${monthLabel(D.period)}`);
    clear(bar).append(h('p', { class: `small ${dirty ? 'strong' : 'muted'}` }, dirty ? 'Unsaved changes.' : 'All changes saved.'), h('div', { class: 'side-actions' }, save, fin));
  }
  const drawAll = () => { drawHead(); drawTotals(); drawLines(); drawBar(); };

  // ---------------------------------------------------------- actions
  function recalc() {
    const res = buildRun({ ...D, existing: lines });
    lines = res.lines; notices = res.notices || []; dirty = true; drawAll();
    toast(res.skipped.length ? `Recalculated. ${res.skipped.length} line(s) removed: ${res.skipped.map((s) => s.name).join(', ')}.` : 'Recalculated from the latest records.');
  }
  const dbLine = (l) => ({ employee_id: l.employee_id, assignment_id: l.assignment_id, company_id: l.company_id, emp_name: l.emp_name, emp_code: l.emp_code,
    mode: l.mode || 'auto', excluded: !!l.excluded, items: l.items, overrides: l.overrides || {}, inputs: l.inputs || {}, warnings: l.warnings || [], note: l.note || null,
    gross: l.gross, epf_wage: l.epf_wage, socso_wage: l.socso_wage, eis_wage: l.eis_wage, ...Object.fromEntries(STAT_KEYS.map((k) => [k, l[k]])),
    pcb: l.pcb, net: l.net, personal_deductions: l.personal_deductions, net_paid: l.net_paid });
  async function saveRun(quiet = false) {
    const { data, error } = await ctx.sb.rpc('eppd_save_pay_run', { p: { period: D.period, notes: run?.notes || null, totals: runTotals(lines), lines: lines.map(dbLine),
      expected_updated_at: run?.updated_at || null } });
    if (failed(error, 'Save')) return null;
    dirty = false;
    if (!quiet) { toast(`${monthLabel(D.period)} saved as a draft.`); reload(); }
    return data;
  }
  async function finalise() {
    const a = runTotals(lines).all;
    const warn = lines.filter((l) => !l.excluded && (l.warnings || []).some((w) => w.level === 'warn')).length;
    const noPcb = lines.filter((l) => !l.excluded && !Number(l.pcb)).length;
    const msg = `${warn ? `${warn} line(s) still have warnings. ` : ''}Lock ${monthLabel(D.period)}: ${a.lines} staff, gross RM${money(a.gross)}, net paid RM${money(a.net_paid)}. ` +
      `${noPcb} line(s) have no PCB. After finalising nobody can change this month; corrections go into the next month.`;
    if (!(await confirmDialog(`Finalise ${monthLabel(D.period)}`, msg, 'Finalise'))) return;
    const saved = await saveRun(true); if (!saved) return;
    const { error } = await ctx.sb.rpc('eppd_finalise_pay_run', { p_run: saved.run_id });
    if (failed(error, 'Finalise')) { reload(); return; }
    toast(`${monthLabel(D.period)} finalised.`); reload();
  }
  async function deleteDraft() {
    if (!(await confirmDialog('Delete draft', `Delete the ${monthLabel(D.period)} draft and every change typed into it? Salary, leave and overtime records are not affected.`, 'Delete draft', true))) return;
    const { error } = await ctx.sb.from('eppd_pay_runs').delete().eq('id', run.id);
    if (failed(error, 'Delete')) return;
    dirty = false; toast('Draft deleted.'); location.hash = '#/payroll';
  }
  function reopen() {
    const f = field('Reason (kept in the audit log)', { type: 'textarea', required: true });
    openModal({ title: `Reopen ${monthLabel(D.period)}`, body: h('div', {}, h('p', { style: 'margin-bottom:.8rem' }, 'Reopening unlocks the month so it can be changed and finalised again. Payslips already given out will no longer match until it is finalised again.'), f),
      actions: [{ label: 'Reopen month', danger: true, onClick: async (close) => {
        const reason = f.getValue(); if (!reason) { toast('Give a reason.', 'error'); return false; }
        const { error } = await ctx.sb.rpc('eppd_reopen_pay_run', { p_run: run.id, p_reason: reason });
        if (failed(error, 'Reopen')) return false;
        close(); toast(`${monthLabel(D.period)} reopened.`); reload(); return true;
      } }] });
  }
  function reload() { window.removeEventListener('beforeunload', leaveGuard); window.dispatchEvent(new HashChangeEvent('hashchange')); }
  function exportCsv() {
    const cols = ['Employee ID', 'Name', 'Company', 'Basic', 'Overtime', 'Other pay', 'Unpaid leave', 'Gross', 'EPF wage', 'EPF ee', 'EPF er', 'SOCSO wage', 'SOCSO ee', 'SOCSO er', 'EIS wage', 'EIS ee', 'EIS er', 'PCB', 'Net', 'Personal deductions', 'Net paid', 'Left out', 'Warnings'];
    const rows = lines.map((l) => { const s = lineSummary(l); return [l.emp_code || '', l.emp_name, companyName(l.company_id), s.basic, s.overtime, s.other, s.unpaid, l.gross, l.epf_wage, l.epf_ee, l.epf_er, l.socso_wage, l.socso_ee, l.socso_er, l.eis_wage, l.eis_ee, l.eis_er, l.pcb, l.net, l.personal_deductions, l.net_paid, l.excluded ? 'Yes' : '', (l.warnings || []).map((w) => w.text).join(' | ')]; });
    const csv = [cols, ...rows].map((r) => r.map((v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n');
    const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })), download: `payroll_${ym(D.period)}.csv` }); document.body.append(a); a.click(); a.remove();
  }

  // ---------------------------------------------------------- one line
  function openLine(orig) {
    let L = JSON.parse(JSON.stringify(orig));
    const ro = locked;
    const box = h('div', {});
    // edits arrive on 'change' (fired on blur); redraw on the next tick so the field being left is not removed mid-event
    let pending = false;
    const redraw = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; draw(); }, 0); };
    const draw = () => {
      L = recomputeLine(L, D);
      const g = groupItems(L.items); const inp = L.inputs || {};
      const itemRow = (i) => {
        const idx = L.items.indexOf(i);
        let amountCell;
        if (ro || L.mode === 'fixed') amountCell = h('td', { class: 'num' }, money(itemAmount(i)));
        else if (i.auto) {
          const x = h('input', { type: 'number', step: '0.01', value: i.override ?? '', placeholder: money(i.amount), 'aria-label': `Amount for ${i.label}`, style: 'width:8rem;text-align:right' });
          x.addEventListener('change', () => { i.override = x.value === '' ? null : Number(x.value); redraw(); });
          amountCell = h('td', { class: 'num' }, x, i.override !== null && i.override !== undefined ? h('div', { class: 'small muted' }, `calculated ${money(i.amount)}`) : null);
        } else {
          const x = h('input', { type: 'number', step: '0.01', value: i.amount, 'aria-label': `Amount for ${i.label}`, style: 'width:8rem;text-align:right' });
          x.addEventListener('change', () => { i.amount = Number(x.value) || 0; redraw(); });
          amountCell = h('td', { class: 'num' }, x);
        }
        return h('tr', {}, h('td', {}, i.label, i.auto ? null : h('span', { class: 'tag', style: 'margin-left:.4rem' }, L.mode === 'fixed' ? 'recorded' : 'added')),
          h('td', { class: 'small muted' }, i.note || ''), amountCell,
          h('td', {}, !ro && L.mode !== 'fixed' && !i.auto ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { L.items.splice(idx, 1); draw(); } }, 'Remove') : null));
      };
      const section = (title, list, sign) => list.length ? [h('tr', { class: 'sub-row' }, h('th', { colspan: 4 }, title)), ...list.map(itemRow),
        h('tr', {}, h('td', { colspan: 2, class: 'muted' }, `Total ${title.toLowerCase()}`), h('td', { class: 'num strong' }, `${sign}${money(list.reduce((s, i) => s + itemAmount(i), 0))}`), h('td', {}))] : [];

      // add item
      let addRow = null;
      if (!ro && L.mode !== 'fixed') {
        const typeSel = h('select', { 'aria-label': 'Payment type' }, D.typeList.filter((t) => t.is_active && t.code !== 'BASIC').map((t) => h('option', { value: t.code }, `${t.name}${t.kind === 'deduction' ? ' (deduction)' : ''}`)));
        const amt = h('input', { type: 'number', step: '0.01', placeholder: 'Amount', 'aria-label': 'Amount', style: 'width:8rem' });
        const note = h('input', { type: 'text', placeholder: 'Note (optional)', 'aria-label': 'Note' });
        const add = h('button', { class: 'btn sm', type: 'button' }, 'Add');
        add.addEventListener('click', () => {
          const v = Number(amt.value); if (!(v > 0)) { toast('Enter an amount above 0.', 'error'); return; }
          L.items.push(itemFromType(D.types.get(typeSel.value), { auto: false, amount: v, note: note.value.trim() || null })); draw();
        });
        addRow = h('div', { class: 'filter-row', style: 'justify-content:flex-start;gap:.5rem;margin:.6rem 0 1rem;flex-wrap:wrap' }, h('b', { class: 'small' }, 'Add a one-off item:'), typeSel, amt, note, add);
      }

      // statutory
      const statRows = [['EPF', 'epf', L.epf_wage], ['SOCSO', 'socso', L.socso_wage], ['EIS', 'eis', L.eis_wage]].map(([label, k, wage]) => {
        const cellFor = (side) => {
          const key = `${k}_${side}`; const ov = L.overrides?.[key];
          if (ro || L.mode === 'fixed') return h('td', { class: 'num' }, money(L[key]));
          const x = h('input', { type: 'number', step: '0.01', value: ov ?? '', placeholder: money(L[key]), 'aria-label': `${label} ${side === 'ee' ? 'employee' : 'employer'}`, style: 'width:7rem;text-align:right' });
          x.addEventListener('change', () => { L.overrides = { ...(L.overrides || {}) }; if (x.value === '') delete L.overrides[key]; else L.overrides[key] = Number(x.value); redraw(); });
          return h('td', { class: 'num' }, x, ov !== undefined && ov !== null ? h('div', { class: 'small muted' }, 'typed') : null);
        };
        const off = inp.flags && (inp.flags[`${k}_ee`] === false || inp.flags[`${k}_er`] === false);
        return h('tr', {}, h('td', {}, label, off ? h('div', { class: 'small muted' }, `switched off: ${[inp.flags[`${k}_ee`] === false ? 'employee' : null, inp.flags[`${k}_er`] === false ? 'employer' : null].filter(Boolean).join(' & ')}`) : null),
          h('td', { class: 'num' }, money(wage)), cellFor('ee'), cellFor('er'));
      });
      const pcbIn = h('input', { type: 'number', step: '0.01', value: L.pcb || '', placeholder: '0.00', 'aria-label': 'PCB', style: 'width:8rem;text-align:right', disabled: ro || L.mode === 'fixed' });
      pcbIn.addEventListener('change', () => { L.pcb = Number(pcbIn.value) || 0; redraw(); });
      const excl = switchToggle(L.excluded, (v) => { L.excluded = v; }, { label: 'Leave out of this month', disabled: ro });
      const noteIn = h('textarea', { 'aria-label': 'Note', rows: 2, disabled: ro, placeholder: 'Note for this month (optional)' }); noteIn.value = L.note || '';
      noteIn.addEventListener('change', () => { L.note = noteIn.value.trim() || null; });

      const kv = [['Pay basis', inp.basis === 'hourly' ? `Hourly · RM${money(inp.salary)} an hour` : inp.basis === 'monthly' ? `Monthly · RM${money(inp.salary)}` : '—'],
        ['Days employed', inp.window ? `${inp.window.days} of ${inp.window.cal_days}` : (inp.workbook_row ? `Workbook row ${inp.workbook_row}` : '—')],
        ['Daily / hourly rate', inp.orp ? `RM${money(inp.orp)} / RM${money(inp.hrp)} (${inp.normal_hours} h day)` : '—'],
        ['Age for statutory rates', inp.age ?? '—'], ['Statutory class', inp.stat_class || '—'], ['Company', companyName(L.company_id)]];
      clear(box).append(
        h('div', { class: 'kv', style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.6rem 1.2rem;margin-bottom:1rem' },
          kv.map(([k, v]) => h('div', {}, h('div', { class: 'small muted' }, k), h('div', { class: 'strong' }, String(v))))),
        (L.warnings || []).length ? h('ul', { class: 'setup-warning', style: 'margin-bottom:1rem;padding-left:1.8rem' }, L.warnings.map((w) => h('li', {}, w.text))) : null,
        h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Details'), h('th', { class: 'num' }, 'Amount (RM)'), h('th', {}))),
          h('tbody', {}, ...section('Earnings', g.earnings, ''), ...section('Deductions before statutory', g.deductions, '−'), ...section('Personal deductions', g.personal, '−')))),
        addRow,
        h('div', { class: 'grid-2', style: 'margin-top:1rem;gap:1.2rem;align-items:start' },
          h('div', {}, h('h3', { style: 'margin-bottom:.4rem' }, 'Statutory'),
            h('table', { class: 'data' }, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', { class: 'num' }, 'Wage'), h('th', { class: 'num' }, 'Employee'), h('th', { class: 'num' }, 'Employer'))), h('tbody', {}, statRows)),
            !ro && L.mode !== 'fixed' ? h('p', { class: 'small muted', style: 'margin-top:.4rem' }, 'Leave a box empty to use the table amount. Type an amount only for a special case (e.g. a voluntary higher EPF rate).') : null),
          h('div', {}, h('h3', { style: 'margin-bottom:.4rem' }, 'Pay'),
            h('table', { class: 'data' }, h('tbody', {},
              h('tr', {}, h('td', {}, 'Gross pay'), h('td', { class: 'num' }, money(L.gross))),
              h('tr', {}, h('td', {}, 'EPF + SOCSO + EIS (employee)'), h('td', { class: 'num' }, `−${money(L.epf_ee + L.socso_ee + L.eis_ee)}`)),
              h('tr', {}, h('td', {}, h('label', {}, 'PCB (from the LHDN calculator)')), h('td', { class: 'num' }, pcbIn)),
              h('tr', {}, h('td', { class: 'strong' }, 'Net pay'), h('td', { class: 'num strong' }, money(L.net))),
              L.personal_deductions ? h('tr', {}, h('td', {}, 'Personal deductions'), h('td', { class: 'num' }, `−${money(L.personal_deductions)}`)) : null,
              h('tr', {}, h('td', { class: 'strong' }, 'Paid to employee'), h('td', { class: 'num strong' }, money(L.net_paid))))))),
        h('div', { style: 'margin-top:1rem;display:grid;gap:.6rem' }, h('label', { class: 'check-row' }, excl, 'Leave this line out of the month (not paid, not counted)'), noteIn),
        h('p', { class: 'small', style: 'margin-top:.6rem' }, h('a', { href: `#/employees/${L.employee_id}?tab=pay` }, 'Open employee profile ›')));
    };
    draw();
    openModal({ title: `${L.emp_name} · ${monthLabel(D.period)}`, body: box, wide: true,
      actions: ro ? [] : [{ label: 'Apply', primary: true, onClick: async (close) => {
        await new Promise((r) => setTimeout(r, 0));
        const i = lines.indexOf(orig); lines[i] = recomputeLine(L, D); dirty = true; close(); drawTotals(); drawLines(); drawBar(); return true;
      } }] });
  }

  drawAll();
}
