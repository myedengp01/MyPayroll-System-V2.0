// Time & leave › KPI grades & carry forward (PRI-004): one KPI grade per person per year, the days each grade may carry
// into next year, and a management override (days + reason). The year-end close and Leave balances read the same rows.
import { h, clear, pageHead, openModal, field, toast, failed, fmtDateTime } from '../ui.js';
import { loadLeaveYear, balancesFor, peopleInYear } from '../leave-data.js';
import { eligibleCarry, gradeOrder, canBuyBack } from '../engines/leave.js';
import { todayIso } from '../engines/employee.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DEF_LABELS = { E: 'Excellent', S: 'Satisfactory', A: 'Average', I: 'Needs improvement', U: 'Under performing' };

/** Grade / note / override dialog for one person and year. onSaved(row). */
export function editKpi(ctx, { person, year, row, cf, onSaved }) {
  const labels = cf.grade_labels || DEF_LABELS;
  const F = {
    grade: field('KPI grade', { type: 'select', value: row?.grade || '', options: [['', '— no grade (carries 0 days)'], ...gradeOrder(cf.grades).map((g) => [g, `${g} · ${labels[g] || ''} · carry up to ${cf.grades[g]} day${cf.grades[g] === 1 ? '' : 's'}`])] }),
    note: field('Note', { type: 'textarea', value: row?.note }),
    cf_override: field('Override: days to carry forward', { type: 'number', step: '0.5', value: row?.cf_override ?? '', hint: 'Leave blank to use the grade. Management decision only.' }),
    cf_override_reason: field('Reason for the override', { type: 'textarea', value: row?.cf_override_reason, hint: 'Required with an override.' }),
  };
  const conf = person.employment?.confirmation_status === 'C';
  openModal({ title: `KPI ${year} · ${person.full_name}`,
    body: h('div', { style: 'display:grid;gap:.9rem' },
      !conf && cf.confirmed_only ? h('p', { class: 'setup-warning' }, 'Not confirmed: carries nothing under the confirmed-staff-only rule, unless you set an override.') : null,
      ...Object.values(F),
      row?.graded_at ? h('p', { class: 'small muted' }, `Last graded ${fmtDateTime(row.graded_at)}.`) : null),
    actions: [{ label: 'Save', primary: true, onClick: async (close) => {
      const v = Object.fromEntries(Object.entries(F).map(([k, f]) => [k, f.getValue()]));
      if (v.cf_override !== null && v.cf_override < 0) { toast('Override days cannot be negative.', 'error'); return false; }
      if (v.cf_override !== null && !v.cf_override_reason) { toast('Give the reason for the override.', 'error'); return false; }
      if (v.cf_override === null) v.cf_override_reason = null;
      const rec = { ...v, graded_by: ctx.session?.user?.id || null, graded_at: new Date().toISOString() };
      const res = row ? await ctx.sb.from('eppd_kpi_ratings').update(rec).eq('id', row.id).select().single()
                      : await ctx.sb.from('eppd_kpi_ratings').insert({ ...rec, employee_id: person.id, year }).select().single();
      if (failed(res.error)) return false;
      toast('KPI saved.'); close(); onSaved?.(res.data); return true;
    } }] });
}

export async function render(el, ctx, params, query) {
  const thisYear = Number(todayIso().slice(0, 4));
  const year = Number(query.year) || thisYear;
  const D = await loadLeaveYear(ctx.sb, year);
  const cf = D.ref.policies.carry_forward || { confirmed_only: true, grades: { E: 6, S: 3, A: 1, I: 0, U: 0 }, buyback_grades: ['E', 'S', 'A'] };
  const labels = cf.grade_labels || DEF_LABELS;
  const cutM = Number(cf.kpi_cutoff_month ?? 10);
  const cutoff = new Date(Date.UTC(year, cutM, 0)).toISOString().slice(0, 10);          // last day of the cut-off month
  const startM = cutM === 12 ? `${year}-01-01` : new Date(Date.UTC(year - 1, cutM, 1)).toISOString().slice(0, 10);
  const yearEnd = `${year}-12-31`;
  const kpi = new Map(D.kpi.map((k) => [k.employee_id, k]));
  const graders = new Map();
  try { const { data } = await ctx.sb.from('eppd_user_roles').select('user_id,email,display_name'); (data || []).forEach((u) => graders.set(u.user_id, u.display_name || u.email)); } catch (e) { /* not visible to HR */ }
  // staff still employed at the cut-off (graded on the KPI year), current ones first
  const people = peopleInYear(D.people, year).filter((p) => !p.employment?.resigned_date || p.employment.resigned_date >= cutoff);
  const st = { q: query.q || '', show: query.show || 'all' };

  const yearSel = h('select', { 'aria-label': 'Year', style: 'width:auto' }, [thisYear - 1, thisYear, thisYear + 1].map((y) => h('option', { value: y, selected: y === year }, y)));
  yearSel.addEventListener('change', () => { location.hash = `#/leave/kpi?year=${yearSel.value}`; });
  const search = h('input', { type: 'search', placeholder: 'Search name or ID', 'aria-label': 'Search', value: st.q });
  const showSel = h('select', { 'aria-label': 'Show', style: 'width:auto' }, [['all', 'Everyone'], ['ungraded', 'No grade yet'], ['override', 'With an override']].map(([v, l]) => h('option', { value: v, selected: v === st.show }, l)));
  const body = h('div', { class: 'table-wrap' }); const facts = h('div', { class: 'facts' });
  el.append(pageHead(`KPI grades & carry forward ${year}`,
    `KPI year ${startM} to ${cutoff} (cut-off: end of ${MONTHS[cutM - 1]}, set in HR policies). The grade decides how many unused annual leave days carry from 31 Dec ${year} into ${year + 1}: ${gradeOrder(cf.grades).map((g) => `${g} ${cf.grades[g]}`).join(', ')}. No grade = 0 days.${cf.confirmed_only ? ' Only confirmed staff carry leave.' : ''} An override (days + reason) replaces the grade for that person.`,
    yearSel, h('a', { class: 'btn', href: `#/leave/balances?year=${year}` }, 'Leave balances'), h('a', { class: 'btn', href: `#/leave/year-end?year=${year}` }, 'Year-end close')),
  facts, h('section', { class: 'panel' }, h('div', { class: 'panel-head filters' }, h('div', { class: 'filter-row', style: 'justify-content:flex-start' }, search, showSel)), body));

  function draw() {
    const q = st.q.trim().toLowerCase();
    const rows = people.map((p) => {
      const k = kpi.get(p.id) || null; const conf = p.employment?.confirmation_status === 'C';
      const e = eligibleCarry({ confirmed: conf, grade: k?.grade || null, override: k?.cf_override ?? null }, cf);
      const b = balancesFor(p, D, yearEnd);
      return { p, k, conf, e, bal: b.AL.balance };
    });
    const shown = rows.filter((r) => (!q || `${r.p.full_name} ${r.p.emp_id}`.toLowerCase().includes(q))
      && (st.show !== 'ungraded' || !r.k?.grade) && (st.show !== 'override' || (r.k?.cf_override ?? null) !== null));
    clear(facts).append(...[[rows.filter((r) => r.k?.grade).length, 'graded'], [rows.filter((r) => !r.k?.grade && (r.conf || !cf.confirmed_only)).length, 'eligible staff with no grade', true],
      [rows.filter((r) => (r.k?.cf_override ?? null) !== null).length, 'overrides'], ...gradeOrder(cf.grades).map((g) => [rows.filter((r) => r.k?.grade === g).length, `${g} · ${labels[g]}`])]
      .map(([n, l, bad]) => h('div', { class: `fact ${bad && n ? 'bad' : ''}` }, h('b', {}, n), h('span', {}, l))));
    clear(body);
    if (!shown.length) { body.append(h('div', { class: 'empty-state' }, 'No one to show.')); return; }
    body.append(h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ['Employee', 'Status', 'KPI grade', 'Note', 'Graded', 'Eligible carry', 'Override', `AL balance now → 31 Dec`, ''].map((t, i) => h('th', { class: [5, 7].includes(i) ? 'num' : '' }, t)))),
      h('tbody', {}, shown.map(({ p, k, conf, e, bal }) => {
        const gSel = h('select', { 'aria-label': `KPI grade for ${p.full_name}`, style: 'width:auto' }, h('option', { value: '' }, '—'),
          gradeOrder(cf.grades).map((g) => h('option', { value: g, selected: g === k?.grade }, `${g} · ${labels[g]}`)));
        gSel.addEventListener('change', () => quickGrade(p, gSel.value));
        return h('tr', {},
          h('td', {}, h('a', { href: `#/employees/${p.id}?tab=leave`, class: 'row-link' }, p.full_name), h('div', { class: 'small muted' }, p.emp_id || '')),
          h('td', {}, conf ? h('span', { class: 'tag ok' }, 'Confirmed') : h('span', { class: 'tag info' }, D.ref.label('confirmation_status', p.employment?.confirmation_status) || '—')),
          h('td', {}, gSel),
          h('td', { class: 'small', style: 'max-width:22ch' }, k?.note || ''),
          h('td', { class: 'small muted nowrap' }, k?.graded_at ? `${String(k.graded_at).slice(0, 10)}${graders.get(k.graded_by) ? ` · ${graders.get(k.graded_by)}` : ''}` : ''),
          h('td', { class: 'num strong' }, e.days, h('div', { class: 'small muted' }, { grade: `grade ${k?.grade}`, override: 'override', no_grade: 'no grade', not_confirmed: 'not confirmed' }[e.basis]),
            canBuyBack({ confirmed: conf, grade: k?.grade }, cf) ? h('div', { class: 'small muted' }, 'buy-back eligible') : null),
          h('td', { class: 'small', style: 'max-width:24ch' }, (k?.cf_override ?? null) !== null ? [h('b', {}, `${k.cf_override} days`), h('div', { class: 'muted' }, k.cf_override_reason || '')] : ''),
          h('td', { class: `num ${bal < 0 ? 'neg' : ''}` }, bal),
          h('td', { class: 'actions' }, h('button', { class: 'btn sm', type: 'button', onclick: () => editKpi(ctx, { person: p, year, row: k, cf, onSaved: (row) => { kpi.set(p.id, row); draw(); } }) }, 'Note / override')));
      }))));
  }
  async function quickGrade(p, g) {
    const k = kpi.get(p.id);
    const rec = { grade: g || null, graded_by: ctx.session?.user?.id || null, graded_at: new Date().toISOString() };
    const res = k ? await ctx.sb.from('eppd_kpi_ratings').update(rec).eq('id', k.id).select().single()
                  : await ctx.sb.from('eppd_kpi_ratings').insert({ ...rec, employee_id: p.id, year }).select().single();
    if (failed(res.error)) { draw(); return; }
    kpi.set(p.id, res.data); toast(`${p.full_name}: ${g ? `grade ${g}` : 'no grade'}.`); draw();
  }
  search.addEventListener('input', () => { st.q = search.value; draw(); });
  showSel.addEventListener('change', () => { st.show = showSel.value; draw(); });
  draw();
}
