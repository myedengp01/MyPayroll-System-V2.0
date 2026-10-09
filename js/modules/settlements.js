// Final settlement: what is added to a leaver's last pay — unused annual leave, notice pay in lieu, loan balance
import { h, clear, pageHead, toast, failed, openModal, field, money, fmtDate } from '../ui.js';
import { fetchAll, loadRef } from '../data.js';
import { loadPayPeople } from '../pay-data.js';
import { loadLeaveYear, balancesFor, loadPeople } from '../leave-data.js';
import { computeNotice } from '../engines/notice.js';
import { ratesOfPay, monthLabel, periodOf } from '../engines/payroll.js';
import { salaryAsOf, todayIso, addDays } from '../engines/employee.js';

const r2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export async function render(el, ctx) {
  const ref = await loadRef(ctx.sb);
  const today = todayIso();
  const from = addDays(today, -120), to = addDays(today, 150);
  const [people, settlements, runs, loans, payLines] = await Promise.all([
    loadPayPeople(ctx.sb, ref),
    fetchAll(() => ctx.sb.from('eppd_settlements').select('*')),
    fetchAll(() => ctx.sb.from('eppd_pay_runs').select('period,status')),
    ctx.modules?.loans ? fetchAll(() => ctx.sb.from('eppd_loans').select('*').eq('status', 'active')) : Promise.resolve([]),
    ctx.modules?.loans ? fetchAll(() => ctx.sb.from('eppd_pay_lines').select('items,excluded,eppd_pay_runs!inner(status)').eq('eppd_pay_runs.status', 'finalised')) : Promise.resolve([]),
  ]);
  const stBy = new Map(settlements.map((s) => [s.employment_id, s]));
  const runBy = new Map(runs.map((r) => [r.period, r.status]));
  const repaid = new Map();
  for (const l of payLines) if (!l.excluded) for (const i of l.items || []) { const m = /^LOAN:(\d+)$/.exec(i.key || ''); if (m) repaid.set(Number(m[1]), (repaid.get(Number(m[1])) || 0) + (Number(i.override ?? i.amount) || 0)); }
  const notice = ref.policies.notice_period;
  const defMode = ref.policies.settlement?.al_mode_default || 'auto';

  // leavers: last working day in the window, or a resignation letter on record
  const rows = [];
  for (const p of people) for (const em of p.employments || []) {
    const inWindow = em.resigned_date && em.resigned_date >= from && em.resigned_date <= to;
    if (!inWindow && !stBy.has(em.id)) continue;
    const asg = (em.assignments || []).find((a) => a.is_primary) || em.assignments?.[0];
    const sal = asg ? salaryAsOf(asg.salary_history || [], em.resigned_date || today) : null;
    const R = ratesOfPay(sal, em);
    const n = em.resignation_letter_date && notice ? computeNotice({ joinDate: em.join_date, letterDate: em.resignation_letter_date, onProbation: em.confirmation_status === 'UP' }, notice) : null;
    const shortCal = n && em.resigned_date && em.resigned_date < n.noticeEnd ? daysBetween(em.resigned_date, n.noticeEnd) : 0;
    const shortDays = Math.round(shortCal * 6 / 7 * 2) / 2;   // calendar days short → working days (6-day week), to the half day
    const myLoans = loans.filter((ln) => ln.employee_id === p.id).map((ln) => ({ ...ln, balance: Math.max(0, r2(Number(ln.principal) - (repaid.get(ln.id) || 0))) }));
    rows.push({ p, em, R, n, shortCal, shortDays, st: stBy.get(em.id) || null, loanBal: r2(myLoans.reduce((s, ln) => s + ln.balance, 0)), period: em.resigned_date ? periodOf(em.resigned_date) : null });
  }
  rows.sort((a, b) => String(a.em.resigned_date).localeCompare(String(b.em.resigned_date)));
  // unused annual leave at each last working day
  const years = [...new Set(rows.filter((r) => r.em.resigned_date).map((r) => Number(r.em.resigned_date.slice(0, 4))))];
  const al = new Map();
  for (const y of years) {
    try {
      const L = await loadLeaveYear(ctx.sb, y); const lp = new Map((await loadPeople(ctx.sb, L.ref)).map((x) => [x.id, x]));
      for (const r of rows.filter((x) => x.em.resigned_date?.startsWith(String(y)))) {
        const person = lp.get(r.p.id); if (!person) continue;
        const b = balancesFor({ ...person, employment: { ...(person.employment || {}), ...r.em } }, L, r.em.resigned_date);
        al.set(r.em.id, b?.AL ? r2(b.AL.balance) : null);
      }
    } catch { /* leave data unavailable */ }
  }

  el.append(pageHead('Final settlement', 'Leavers whose last working day is within the last four months or the next five. What you set here is added to their pay in the month of their last working day (Recalculate that month if it is already open).'));
  if (!rows.length) { el.append(h('div', { class: 'empty-state' }, 'Nobody is leaving in this period. Record a resignation on the employee’s profile first.')); return; }
  el.append(h('section', { class: 'panel' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Employee', 'Last working day', 'Unused AL', 'Notice', 'Loan balance', 'Settlement', 'Payroll month', ''].map((t, i) => h('th', { class: i === 2 || i === 4 ? 'num' : '' }, t)))),
    h('tbody', {}, rows.map((r) => {
      const st = r.st || {}; const mode = st.al_mode || defMode; const days = al.get(r.em.id);
      const alTxt = mode === 'none' ? 'Not paid' : mode === 'custom' ? `Custom: ${st.al_amount !== null && st.al_amount !== undefined ? `RM${money(st.al_amount)}` : `${st.al_days} day(s)`}` : (days === null || days === undefined ? '—' : `${days} day(s) = RM${money(r2(days * r.R.orp))}`);
      const ntc = st.notice_mode === 'employer_pays' ? `We pay ${st.notice_days ?? '?'} day(s)` : st.notice_mode === 'employee_pays' ? `They pay ${st.notice_days ?? '?'} day(s)` : (r.shortCal > 0 ? `${r.shortCal} calendar day(s) short` : (r.n ? 'Served in full' : 'No letter date'));
      const status = r.period ? runBy.get(r.period) : null;
      return h('tr', { class: r.shortCal > 0 && !st.notice_mode ? 'flag' : '' },
        h('td', {}, h('a', { href: `#/employees/${r.p.id}?tab=employment` }, r.p.full_name), h('div', { class: 'small muted' }, r.p.emp_id || '')),
        h('td', { class: 'nowrap' }, r.em.resigned_date ? fmtDate(r.em.resigned_date) : '—', r.n ? h('div', { class: 'small muted' }, `Notice ${r.n.weeks} week(s), letter ${fmtDate(r.em.resignation_letter_date)}`) : null),
        h('td', { class: 'num' }, alTxt), h('td', { class: 'small' }, ntc), h('td', { class: 'num' }, r.loanBal ? money(r.loanBal) : ''),
        h('td', {}, r.st ? h('span', { class: 'tag info' }, 'Set by HR') : h('span', { class: 'tag' }, 'Default')),
        h('td', {}, r.period ? h('a', { href: `#/payroll/${r.period.slice(0, 7)}` }, monthLabel(r.period)) : '—', status ? h('div', { class: 'small muted' }, status === 'finalised' ? 'Finalised' : 'Draft') : null),
        h('td', {}, status === 'finalised' ? null : h('button', { class: 'btn sm', type: 'button', onclick: () => edit(r, days) }, 'Edit')));
    }))))),
    h('p', { class: 'small muted', style: 'margin-top:.8rem' }, 'Days are paid at the daily rate (basic ÷ 26). Suggested notice days count working days (6-day week) between the last working day and the end of the notice period.'));

  function edit(r, days) {
    const st = r.st || {};
    const alMode = field('Unused annual leave', { type: 'select', value: st.al_mode || defMode, options: [['auto', `Pay out the balance (${days ?? '—'} day(s) on the last day)`], ['none', 'Do not pay out'], ['custom', 'Custom days or amount']] });
    const alDays = field('Custom: days (negative = deduct leave taken in advance)', { type: 'number', step: '0.5', value: st.al_days });
    const alAmt = field('Custom: amount (RM, overrides days)', { type: 'number', step: '0.01', value: st.al_amount });
    const nMode = field('Notice period', { type: 'select', value: st.notice_mode || 'none', options: [['none', 'Nothing to settle'], ['employer_pays', 'Company pays notice in lieu'], ['employee_pays', 'Employee pays for notice not served']] });
    const nDays = field('Notice days (working days)', { type: 'number', step: '0.5', value: st.notice_days ?? (r.shortDays || '') , hint: r.shortCal > 0 ? `Suggested: ${r.shortDays} (${r.shortCal} calendar days short)` : undefined });
    const nAmt = field('Notice amount (RM, overrides days)', { type: 'number', step: '0.01', value: st.notice_amount });
    const loansF = field(`Recover the whole loan balance (RM${money(r.loanBal)})`, { type: 'switch', value: st.recover_loans !== false, span2: true });
    const note = field('Note', { type: 'textarea', value: st.note, span2: true });
    const preview = h('p', { class: 'small', style: 'grid-column:1/-1' });
    const upd = () => {
      const m = alMode.getValue();
      const alV = m === 'auto' ? (days ?? 0) * r.R.orp : m === 'custom' ? (alAmt.getValue() ?? (Number(alDays.getValue()) || 0) * r.R.orp) : 0;
      const nm = nMode.getValue(); const nv = nm === 'none' ? 0 : (nAmt.getValue() ?? (Number(nDays.getValue()) || 0) * r.R.orp);
      preview.textContent = `Daily rate RM${money(r.R.orp)}. Leave: ${alV >= 0 ? '+' : '−'}RM${money(Math.abs(alV))} · Notice: ${nm === 'employee_pays' ? '−' : '+'}RM${money(nv)}${loansF.getValue() && r.loanBal ? ` · Loan recovered: −RM${money(r.loanBal)}` : ''}`;
    };
    for (const f of [alMode, alDays, alAmt, nMode, nDays, nAmt, loansF]) f.input.addEventListener('input', upd);
    for (const f of [alMode, nMode, loansF]) f.input.addEventListener('change', upd);
    upd();
    openModal({ title: `Final settlement · ${r.p.full_name}`, wide: true, body: h('div', { class: 'form-grid' }, alMode, h('div', {}), alDays, alAmt, nMode, h('div', {}), nDays, nAmt, loansF, note, preview),
      actions: [{ label: 'Save', primary: true, onClick: async (close) => {
        const v = { employment_id: r.em.id, al_mode: alMode.getValue(), al_days: alDays.getValue(), al_amount: alAmt.getValue(), notice_mode: nMode.getValue(),
          notice_days: nDays.getValue(), notice_amount: nAmt.getValue(), recover_loans: loansF.getValue(), note: note.getValue() };
        if (v.al_mode === 'custom' && v.al_days === null && v.al_amount === null) { toast('Enter custom days or an amount.', 'error'); return false; }
        const { error } = await ctx.sb.from('eppd_settlements').upsert(v, { onConflict: 'employment_id' });
        if (failed(error)) return false;
        close(); toast('Final settlement saved. Recalculate the payroll month if it is already open.'); window.dispatchEvent(new HashChangeEvent('hashchange')); return true;
      } }] });
  }
}
