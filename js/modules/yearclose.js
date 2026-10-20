// Year-end close: the 31 Dec annual leave balance → carry forward by KPI grade (or override), buy-back with management approval
// or forfeit the rest; a negative balance becomes unpaid leave in December's payroll (PRI-004)
import { h, clear, pageHead, toast, failed, confirmDialog, fmtDateTime, openModal, field } from '../ui.js';
import { loadLeaveYear, balancesFor, peopleInYear } from '../leave-data.js';
import { closeYearFor, gradeOrder, canBuyBack } from '../engines/leave.js';
import { todayIso } from '../engines/employee.js';
import { fetchAll } from '../data.js';

export const UPL_MARK = (year) => `Year-end ${year}: negative annual leave balance`;

export async function render(el, ctx, params, query) {
  const thisYear = Number(todayIso().slice(0, 4));
  const year = Number(query.year) || thisYear;
  const D = await loadLeaveYear(ctx.sb, year);
  const cf = D.ref.policies.carry_forward || { confirmed_only: true, grades: { E: 6, S: 3, A: 1, I: 0, U: 0 }, buyback_grades: ['E', 'S', 'A'], buyback_options: [50, 25, 10] };
  const labels = cf.grade_labels || { E: 'Excellent', S: 'Satisfactory', A: 'Average', I: 'Needs improvement', U: 'Under performing' };
  const needsApproval = cf.buyback_needs_approval !== false;
  const yearEnd = `${year}-12-31`;
  // staff still employed at year end
  const people = peopleInYear(D.people, year).filter((p) => !p.employment?.resigned_date || p.employment.resigned_date >= yearEnd)
    .filter((p) => p.status.key !== 'former');
  // balance as at 31 Dec ignoring this year's own close (so re-closing shows the true position)
  const D2 = { ...D, adjustments: D.adjustments.filter((a) => !(a.source === 'year_close' && a.close_year === year)) };
  const grades = new Map(D.kpi.map((k) => [k.employee_id, k]));
  // employee_id -> { pct, by, on }: buy-back chosen (re-read from an earlier close)
  const choice = new Map();
  for (const a of D.adjustments.filter((x) => x.source === 'year_close' && x.close_year === year && x.kind === 'buyback')) {
    const m = /approved by (.+) on (\d{4}-\d{2}-\d{2})/.exec(a.note || '');
    choice.set(a.employee_id, { pct: Number(a.buyback_pct), by: m?.[1] || null, on: m?.[2] || null });
  }
  const { data: decRun } = await ctx.sb.from('eppd_pay_runs').select('id,status').eq('period', `${year}-12-01`).maybeSingle();
  const decFinal = decRun?.status === 'finalised';
  const uplDate = decFinal ? `${year + 1}-01-01` : yearEnd;

  const yearSel = h('select', { 'aria-label': 'Year', style: 'width:auto' }, [thisYear - 1, thisYear].map((y) => h('option', { value: y, selected: y === year }, y)));
  yearSel.addEventListener('change', () => { location.hash = `#/leave/year-end?year=${yearSel.value}`; });
  const body = h('div', { class: 'table-wrap' }); const sum = h('div', { class: 'facts' });
  const goBtn = h('button', { class: 'btn primary', type: 'button' }, D.closed ? `Close ${year} again` : `Close ${year}`);
  el.append(pageHead(`Year-end close ${year}`, `The annual leave balance at 31 Dec ${year}: nothing if there is none; the whole balance if it is within the person's eligible days (KPI grade or override); otherwise the eligible days carry into ${year + 1}${cf.expiry ? ` (expires ${cf.expiry.replace('-', '/')}/${year + 1})` : ''} and the rest is bought back (eligible staff, ${needsApproval ? 'with management approval' : 'at the rate chosen'}) or forfeited. A negative balance becomes unpaid leave in ${decFinal ? `January ${year + 1}` : 'December'}'s payroll.${cf.confirmed_only ? ' Only confirmed staff carry leave.' : ''} No KPI grade = 0 days.`,
    yearSel, h('a', { class: 'btn', href: `#/leave/kpi?year=${year}` }, 'KPI grades')),
    D.closed ? h('p', { class: 'setup-warning', style: 'margin-bottom:1rem' }, `${year} was closed on ${fmtDateTime(D.closed.closed_at)}. Closing again replaces that close.`) : null,
    decFinal ? h('p', { class: 'setup-warning', style: 'margin-bottom:1rem' }, `December ${year} payroll is already finalised, so unpaid leave from negative balances will be dated 1 Jan ${year + 1} and deducted in January's payroll.`) : null,
    h('div', { class: 'facts' }, gradeOrder(cf.grades).map((g) => [g, cf.grades[g]]).map(([g, n]) => h('div', { class: 'fact' }, h('b', {}, g), h('span', {}, `${labels[g]} · carry ${n} day${n === 1 ? '' : 's'}${(cf.buyback_grades || []).includes(g) ? ' · buy-back' : ''}`)))),
    h('section', { class: 'panel' }, body), sum, h('div', { class: 'import-bar' }, h('p', { class: 'small muted' }, 'Grades are saved as you choose them. Nothing else changes until you close the year.'), goBtn));

  let results = [];
  function compute() {
    results = people.map((p) => {
      const b = balancesFor(p, D2, yearEnd);
      const confirmed = p.employment?.confirmation_status === 'C';
      const k = grades.get(p.id); const grade = k?.grade || null; const override = k?.cf_override ?? null;
      const c = choice.get(p.id);
      const r = closeYearFor({ employee_id: p.id, confirmed, grade, override, balance: b.AL.balance }, cf, year,
        { buybackPct: c?.pct || null, approvedBy: c?.by || null, approvedOn: c?.on || null });
      return { p, b, confirmed, grade, override, r };
    });
  }
  function askApproval(p, pct) {
    const by = field('Approved by (management)', { value: choice.get(p.id)?.by || '', required: true });
    const on = field('Approval date', { type: 'date', value: choice.get(p.id)?.on || todayIso(), required: true });
    let rate = null;
    if (pct === 'custom') rate = field('Buy-back rate (% of the daily rate)', { type: 'number', value: 30, step: '1' });
    openModal({ title: `Buy-back · ${p.full_name}`, onClose: draw, body: h('div', { style: 'display:grid;gap:.9rem' }, rate, needsApproval ? by : null, needsApproval ? on : null,
      h('p', { class: 'small muted' }, 'Days not bought back are forfeited.')),
    actions: [{ label: 'Use this buy-back', primary: true, onClick: (close) => {
      const v = rate ? Number(rate.getValue()) : Number(pct);
      if (!(v > 0 && v <= 100)) { toast('Enter a rate between 1 and 100.', 'error'); return false; }
      if (needsApproval && (!by.getValue() || !on.getValue())) { toast('Buy-back needs the approver and the approval date.', 'error'); return false; }
      choice.set(p.id, { pct: v, by: needsApproval ? by.getValue() : null, on: needsApproval ? on.getValue() : null }); close(); return true;
    } }] });
  }
  function draw() {
    compute();
    clear(body).append(h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ['Employee', 'Status', 'KPI grade', 'Balance at 31 Dec', 'Eligible', 'Carry forward', 'Excess', 'Buy-back', 'Forfeit', 'Unpaid leave'].map((t, i) => h('th', { class: i >= 3 && i !== 7 ? 'num' : '' }, t)))),
      h('tbody', {}, results.map(({ p, b, confirmed, grade, override, r }) => {
        const gSel = h('select', { 'aria-label': `KPI grade for ${p.full_name}`, style: 'width:auto' }, h('option', { value: '' }, '—'),
          gradeOrder(cf.grades).map((g) => h('option', { value: g, selected: g === grade }, `${g} · ${labels[g]}`)));
        gSel.addEventListener('change', () => saveGrade(p, gSel.value));
        const excess = Math.max(0, Math.round((Math.max(0, b.AL.balance) - r.carry) * 100) / 100);
        const canBuy = excess > 0 && canBuyBack({ confirmed, grade }, cf);
        const c = choice.get(p.id);
        let buy = h('span', { class: 'small muted' }, excess > 0 ? 'Not eligible' : '');
        if (canBuy) {
          const opts = [...new Set([...(cf.buyback_options || []), ...(c?.pct && !(cf.buyback_options || []).includes(c.pct) ? [c.pct] : [])])];
          const sel = h('select', { 'aria-label': `Buy-back for ${p.full_name}`, style: 'width:auto' }, h('option', { value: '' }, 'No buy-back (forfeit)'),
            opts.map((o) => h('option', { value: o, selected: c?.pct === o }, `${o}% of daily rate`)), h('option', { value: 'custom' }, 'Custom %…'));
          sel.addEventListener('change', () => {
            if (!sel.value) { choice.delete(p.id); draw(); return; }
            if (sel.value === 'custom' || needsApproval) { askApproval(p, sel.value); return; }
            choice.set(p.id, { pct: Number(sel.value) }); draw();
          });
          buy = h('div', {}, sel, c?.by ? h('div', { class: 'small muted' }, `approved by ${c.by} · ${c.on}`) : null);
        }
        return h('tr', {},
          h('td', {}, h('a', { href: `#/employees/${p.id}?tab=leave`, class: 'row-link' }, p.full_name), h('div', { class: 'small muted' }, p.emp_id || '')),
          h('td', {}, confirmed ? h('span', { class: 'tag ok' }, 'Confirmed') : h('span', { class: 'tag info' }, D.ref.label('confirmation_status', p.employment?.confirmation_status) || '—')),
          h('td', {}, gSel),
          h('td', { class: `num ${b.AL.balance < 0 ? 'neg' : ''}` }, b.AL.balance),
          h('td', { class: 'num', title: r.reason }, r.cap, override !== null ? h('span', { class: 'tag warn', style: 'margin-left:.3rem', title: grades.get(p.id)?.cf_override_reason || '' }, 'override') : null),
          h('td', { class: 'num strong' }, r.carry || ''), h('td', { class: 'num' }, excess || ''),
          h('td', {}, buy, r.buyback ? h('span', { class: 'small', style: 'margin-left:.4rem' }, `${r.buyback} days`) : null),
          h('td', { class: 'num' }, r.forfeit || ''), h('td', { class: 'num neg' }, r.upl || ''));
      }))));
    const tot = (k) => Math.round(results.reduce((s, x) => s + x.r[k], 0) * 100) / 100;
    const ungraded = results.filter((x) => !x.grade && x.override === null && x.b.AL.balance > 0 && (x.confirmed || !cf.confirmed_only)).length;
    clear(sum).append(...[[`${results.length}`, 'staff at year end'], [tot('carry'), `days carried into ${year + 1}`], [tot('buyback'), 'days bought back'],
      [tot('forfeit'), 'days forfeited'], [tot('upl'), 'days of unpaid leave'], [ungraded, 'eligible staff without a grade']].map(([n, l]) => h('div', { class: `fact ${l.includes('without') && n ? 'bad' : ''}` }, h('b', {}, n), h('span', {}, l))));
  }

  async function saveGrade(p, g) {
    const existing = grades.get(p.id);
    const rec = { grade: g || null, graded_by: ctx.session?.user?.id || null, graded_at: new Date().toISOString() };
    const res = existing ? await ctx.sb.from('eppd_kpi_ratings').update(rec).eq('id', existing.id).select().single()
                         : g ? await ctx.sb.from('eppd_kpi_ratings').insert({ ...rec, employee_id: p.id, year }).select().single() : null;
    if (res && failed(res.error)) { draw(); return; }
    if (res) grades.set(p.id, res.data);
    draw();
  }

  /** Unpaid leave records for negative balances: one per person, replaced on a re-close. */
  async function postUpl() {
    const mark = UPL_MARK(year);
    const old = await fetchAll(() => ctx.sb.from('eppd_leave_records').select('id,employee_id,days,date_from').eq('leave_type', 'UPL').eq('note', mark));
    const want = new Map(results.filter((x) => x.r.upl > 0).map((x) => [x.p.id, x.r.upl]));
    for (const o of old) {
      const d = want.get(o.employee_id);
      if (d === undefined) { const { error } = await ctx.sb.from('eppd_leave_records').delete().eq('id', o.id); if (error) throw error; continue; }
      if (Number(o.days) !== d || o.date_from !== uplDate) { const { error } = await ctx.sb.from('eppd_leave_records').update({ days: d, date_from: uplDate, date_to: uplDate }).eq('id', o.id); if (error) throw error; }
      want.delete(o.employee_id);
    }
    const ins = [...want].map(([employee_id, days]) => ({ employee_id, leave_type: 'UPL', date_from: uplDate, date_to: uplDate, days, days_override: true, status: 'taken', source: 'manual', note: mark }));
    if (ins.length) { const { error } = await ctx.sb.from('eppd_leave_records').insert(ins); if (error) throw error; }
  }

  goBtn.addEventListener('click', async () => {
    compute();
    const ungraded = results.filter((x) => !x.grade && x.override === null && x.b.AL.balance > 0 && (x.confirmed || !cf.confirmed_only));
    const sumOf = (k) => Math.round(results.reduce((s, x) => s + x.r[k], 0) * 100) / 100;
    const msg = `${ungraded.length ? `${ungraded.length} eligible staff have no grade, so their unused leave will be forfeited. ` : ''}Post the ${year} close: carry ${sumOf('carry')} days into ${year + 1}, buy back ${sumOf('buyback')} days, forfeit ${sumOf('forfeit')} days${sumOf('upl') ? ` and record ${sumOf('upl')} days of unpaid leave (dated ${uplDate})` : ''}?`;
    if (!(await confirmDialog(`Close ${year}`, msg, `Close ${year}`))) return;
    const adjustments = results.flatMap((x) => x.r.adjustments);
    const summary = { staff: results.length, carried: sumOf('carry'), bought_back: sumOf('buyback'), forfeited: sumOf('forfeit'), unpaid_leave: sumOf('upl'),
      buyback_approvals: results.filter((x) => x.r.buyback).map((x) => ({ employee_id: x.p.id, days: x.r.buyback, pct: x.r.buybackPct, by: choice.get(x.p.id)?.by || null, on: choice.get(x.p.id)?.on || null })) };
    goBtn.disabled = true;
    try {
      const { data, error } = await ctx.sb.rpc('eppd_close_leave_year', { p: { year, adjustments, summary } });
      if (failed(error, 'Close year')) return;
      await postUpl();
      toast(`${year} closed: ${data.adjustments} adjustments posted${summary.unpaid_leave ? `, ${summary.unpaid_leave} days of unpaid leave recorded` : ''}.`);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (e) { failed(e, 'Unpaid leave'); } finally { goBtn.disabled = false; }
  });
  draw();
}
