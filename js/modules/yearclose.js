// Year-end close: KPI grades -> carry forward (confirmed staff), buy-back or forfeit the rest
import { h, clear, pageHead, toast, failed, confirmDialog, fmtDateTime, openModal, field } from '../ui.js';
import { loadLeaveYear, balancesFor, peopleInYear } from '../leave-data.js';
import { closeYearFor, gradeOrder } from '../engines/leave.js';
import { todayIso } from '../engines/employee.js';

export async function render(el, ctx, params, query) {
  const thisYear = Number(todayIso().slice(0, 4));
  const year = Number(query.year) || thisYear;
  const D = await loadLeaveYear(ctx.sb, year);
  const cf = D.ref.policies.carry_forward || { confirmed_only: true, grades: { E: 6, S: 3, A: 1, I: 0, U: 0 }, buyback_grades: ['E', 'S', 'A'], buyback_options: [50, 25, 10] };
  const labels = cf.grade_labels || { E: 'Excellent', S: 'Satisfactory', A: 'Average', I: 'Needs improvement', U: 'Under performing' };
  const yearEnd = `${year}-12-31`;
  // staff still employed at year end
  const people = peopleInYear(D.people, year).filter((p) => !p.employment?.resigned_date || p.employment.resigned_date >= yearEnd)
    .filter((p) => p.status.key !== 'former');
  // balance as at 31 Dec ignoring this year's own close (so re-closing shows the true position)
  const D2 = { ...D, adjustments: D.adjustments.filter((a) => !(a.source === 'year_close' && a.close_year === year)) };
  const grades = new Map(D.kpi.map((k) => [k.employee_id, k]));
  const choice = new Map();   // employee_id -> buyback pct
  for (const a of D.adjustments.filter((x) => x.source === 'year_close' && x.close_year === year && x.kind === 'buyback')) choice.set(a.employee_id, Number(a.buyback_pct));

  const yearSel = h('select', { 'aria-label': 'Year', style: 'width:auto' }, [thisYear - 1, thisYear].map((y) => h('option', { value: y, selected: y === year }, y)));
  yearSel.addEventListener('change', () => { location.hash = `#/leave/year-end?year=${yearSel.value}`; });
  const body = h('div', { class: 'table-wrap' }); const sum = h('div', { class: 'facts' });
  const goBtn = h('button', { class: 'btn primary', type: 'button' }, D.closed ? `Close ${year} again` : `Close ${year}`);
  el.append(pageHead(`Year-end close ${year}`, `Grade each confirmed employee. Unused annual leave up to their grade's cap carries into ${year + 1}${cf.expiry ? ` (expires ${cf.expiry.replace('-', '/')}/${year + 1})` : ''}; any excess is bought back (E, S, A only) or forfeited. Staff on probation carry nothing.`, yearSel),
    D.closed ? h('p', { class: 'setup-warning', style: 'margin-bottom:1rem' }, `${year} was closed on ${fmtDateTime(D.closed.closed_at)}. Closing again replaces that close.`) : null,
    h('div', { class: 'facts' }, gradeOrder(cf.grades).map((g) => [g, cf.grades[g]]).map(([g, n]) => h('div', { class: 'fact' }, h('b', {}, g), h('span', {}, `${labels[g]} · carry ${n} day${n === 1 ? '' : 's'}${(cf.buyback_grades || []).includes(g) ? ' · buy-back' : ''}`)))),
    h('section', { class: 'panel' }, body), sum, h('div', { class: 'import-bar' }, h('p', { class: 'small muted' }, 'Grades are saved as you choose them. Nothing else changes until you close the year.'), goBtn));

  let results = [];
  function compute() {
    results = people.map((p) => {
      const b = balancesFor(p, D2, yearEnd);
      const confirmed = p.employment?.confirmation_status === 'C';
      const grade = grades.get(p.id)?.grade || null;
      const r = closeYearFor({ employee_id: p.id, confirmed, grade, balance: b.AL.balance }, cf, year, { buybackPct: choice.get(p.id) || null });
      return { p, b, confirmed, grade, r };
    });
  }
  function draw() {
    compute();
    clear(body).append(h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ['Employee', 'Status', 'KPI grade', 'Unused at 31 Dec', 'Carry forward', 'Excess', 'Buy-back', 'Forfeit'].map((t, i) => h('th', { class: i >= 3 && i !== 6 ? 'num' : '' }, t)))),
      h('tbody', {}, results.map(({ p, b, confirmed, grade, r }) => {
        const gSel = h('select', { 'aria-label': `KPI grade for ${p.full_name}`, style: 'width:auto' }, h('option', { value: '' }, '—'),
          gradeOrder(cf.grades).map((g) => h('option', { value: g, selected: g === grade }, `${g} · ${labels[g]}`)));
        gSel.addEventListener('change', () => saveGrade(p, gSel.value));
        const excess = Math.max(0, Math.round((Math.max(0, b.AL.balance) - r.carry) * 100) / 100);
        const canBuy = excess > 0 && grade && (cf.buyback_grades || []).includes(grade) && (!cf.confirmed_only || confirmed);
        let buy = h('span', { class: 'small muted' }, excess > 0 ? 'Not eligible' : '');
        if (canBuy) {
          const opts = [...new Set([...(cf.buyback_options || []), ...(choice.get(p.id) && !(cf.buyback_options || []).includes(choice.get(p.id)) ? [choice.get(p.id)] : [])])];
          buy = h('select', { 'aria-label': `Buy-back for ${p.full_name}`, style: 'width:auto' }, h('option', { value: '' }, 'No buy-back (forfeit)'),
            opts.map((o) => h('option', { value: o, selected: choice.get(p.id) === o }, `${o}% of daily rate`)), h('option', { value: 'custom' }, 'Custom %…'));
          buy.addEventListener('change', () => {
            if (buy.value === 'custom') {
              const f = field('Buy-back rate (% of the daily rate)', { type: 'number', value: 30, step: '1' });
              openModal({ title: `Custom buy-back · ${p.full_name}`, body: f, onClose: draw,
                actions: [{ label: 'Use this rate', primary: true, onClick: (close) => {
                  const v = f.getValue();
                  if (!(v > 0 && v <= 100)) { toast('Enter a rate between 1 and 100.', 'error'); return false; }
                  choice.set(p.id, Number(v)); close(); return true;
                } }] });
              return;
            }
            if (buy.value) choice.set(p.id, Number(buy.value)); else choice.delete(p.id);
            draw();
          });
        }
        return h('tr', {},
          h('td', {}, h('a', { href: `#/employees/${p.id}?tab=leave`, class: 'row-link' }, p.full_name), h('div', { class: 'small muted' }, p.emp_id || '')),
          h('td', {}, confirmed ? h('span', { class: 'tag ok' }, 'Confirmed') : h('span', { class: 'tag info' }, D.ref.label('confirmation_status', p.employment?.confirmation_status) || '—')),
          h('td', {}, confirmed || !cf.confirmed_only ? gSel : h('span', { class: 'small muted' }, 'Not eligible')),
          h('td', { class: 'num' }, b.AL.balance), h('td', { class: 'num strong' }, r.carry || ''), h('td', { class: 'num' }, excess || ''),
          h('td', {}, buy, r.buyback ? h('span', { class: 'small', style: 'margin-left:.4rem' }, `${r.buyback} days`) : null),
          h('td', { class: 'num' }, r.forfeit || ''));
      }))));
    const tot = (k) => Math.round(results.reduce((s, x) => s + x.r[k], 0) * 100) / 100;
    const ungraded = results.filter((x) => x.confirmed && !x.grade && x.b.AL.balance > 0).length;
    clear(sum).append(...[[`${results.length}`, 'staff at year end'], [tot('carry'), `days carried into ${year + 1}`], [tot('buyback'), 'days bought back'],
      [tot('forfeit'), 'days forfeited'], [ungraded, 'confirmed staff without a grade']].map(([n, l]) => h('div', { class: `fact ${l.includes('without') && n ? 'bad' : ''}` }, h('b', {}, n), h('span', {}, l))));
  }

  async function saveGrade(p, g) {
    const existing = grades.get(p.id);
    let res;
    if (!g && existing) res = await ctx.sb.from('eppd_kpi_ratings').delete().eq('id', existing.id);
    else if (g && existing) res = await ctx.sb.from('eppd_kpi_ratings').update({ grade: g }).eq('id', existing.id).select().single();
    else if (g) res = await ctx.sb.from('eppd_kpi_ratings').insert({ employee_id: p.id, year, grade: g }).select().single();
    if (res && failed(res.error)) { draw(); return; }
    if (!g) grades.delete(p.id); else grades.set(p.id, res.data);
    draw();
  }

  goBtn.addEventListener('click', async () => {
    compute();
    const ungraded = results.filter((x) => x.confirmed && !x.grade && x.b.AL.balance > 0);
    const msg = `${ungraded.length ? `${ungraded.length} confirmed staff have no grade, so their unused leave will be forfeited. ` : ''}Post the ${year} close: carry ${results.reduce((s, x) => s + x.r.carry, 0)} days into ${year + 1}, buy back ${results.reduce((s, x) => s + x.r.buyback, 0)} days and forfeit ${results.reduce((s, x) => s + x.r.forfeit, 0)} days?`;
    if (!(await confirmDialog(`Close ${year}`, msg, `Close ${year}`))) return;
    const adjustments = results.flatMap((x) => x.r.adjustments);
    const summary = { staff: results.length, carried: results.reduce((s, x) => s + x.r.carry, 0), bought_back: results.reduce((s, x) => s + x.r.buyback, 0), forfeited: results.reduce((s, x) => s + x.r.forfeit, 0) };
    goBtn.disabled = true;
    const { data, error } = await ctx.sb.rpc('eppd_close_leave_year', { p: { year, adjustments, summary } });
    goBtn.disabled = false;
    if (failed(error, 'Close year')) return;
    toast(`${year} closed: ${data.adjustments} adjustments posted.`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  draw();
}
