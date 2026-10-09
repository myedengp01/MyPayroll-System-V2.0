// Company loans: monthly instalments deducted from net pay until repaid (repayments come from finalised payroll months)
import { h, clear, pageHead, toast, failed, confirmDialog, openModal, field, money, fmtDate } from '../ui.js';
import { fetchAll, loadRef } from '../data.js';
import { monthLabel, periodOf } from '../engines/payroll.js';
import { todayIso } from '../engines/employee.js';

export async function render(el, ctx, params, query) {
  const ref = await loadRef(ctx.sb);
  const [loans, people, lines] = await Promise.all([
    fetchAll(() => ctx.sb.from('eppd_loans').select('*').order('id', { ascending: false })),
    fetchAll(() => ctx.sb.from('eppd_employee_list').select('id,emp_id,full_name,resigned_date').order('full_name')),
    fetchAll(() => ctx.sb.from('eppd_pay_lines').select('employee_id,items,excluded,eppd_pay_runs!inner(period,status)').eq('eppd_pay_runs.status', 'finalised').order('id')),
  ]);
  const byId = new Map(people.map((p) => [p.id, p]));
  // repayments per loan from finalised months
  const pays = new Map();
  for (const l of lines) {
    if (l.excluded) continue;
    for (const i of l.items || []) {
      const m = /^LOAN:(\d+)$/.exec(i.key || ''); if (!m) continue;
      const id = Number(m[1]); if (!pays.has(id)) pays.set(id, []);
      pays.get(id).push({ period: l.eppd_pay_runs.period, amount: Number(i.override ?? i.amount) || 0 });
    }
  }
  const repaid = (ln) => (pays.get(ln.id) || []).reduce((s, x) => s + x.amount, 0);
  const balance = (ln) => Math.max(0, Math.round((Number(ln.principal) - repaid(ln)) * 100) / 100);
  const showClosed = query.all === '1';
  const list = loans.filter((ln) => showClosed || ln.status === 'active');
  el.append(pageHead('Company loans', 'Each active loan is deducted from net pay every month (from its first month) until it is repaid. Change an instalment for one month in the payroll line; final settlement recovers the whole balance.',
    h('a', { class: 'btn', href: showClosed ? '#/loans' : '#/loans?all=1' }, showClosed ? 'Active loans only' : 'Show closed loans too'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => edit(null) }, 'Add loan')));
  const act = loans.filter((ln) => ln.status === 'active');
  el.append(h('div', { class: 'facts' }, [[act.length, 'active loans'], [money(act.reduce((s, ln) => s + Number(ln.principal), 0)), 'lent (RM)'],
    [money(act.reduce((s, ln) => s + balance(ln), 0)), 'still owed (RM)'], [money(act.reduce((s, ln) => s + Math.min(Number(ln.monthly_instalment), balance(ln)), 0)), 'next month’s instalments (RM)']]
    .map(([n, l]) => h('div', { class: 'fact' }, h('b', {}, n), h('span', {}, l)))));
  el.append(h('section', { class: 'panel' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Employee', 'Paid by', 'Loan', 'Amount', 'Instalment', 'From', 'Repaid', 'Balance', 'Status', ''].map((t, i) => h('th', { class: i >= 3 && i <= 7 && i !== 5 ? 'num' : '' }, t)))),
    h('tbody', {}, list.length ? list.map((ln) => {
      const p = byId.get(ln.employee_id); const bal = balance(ln);
      return h('tr', { class: ln.status === 'closed' ? 'inactive' : '' },
        h('td', {}, h('a', { href: `#/employees/${ln.employee_id}?tab=pay` }, p?.full_name || `#${ln.employee_id}`), p?.resigned_date ? h('div', { class: 'small tag warn' }, `Last day ${fmtDate(p.resigned_date)}`) : null),
        h('td', { class: 'small' }, ln.company_id ? (ref.company(ln.company_id)?.short_name || '') : 'Main company'),
        h('td', {}, ln.description || '—', ln.loan_date ? h('div', { class: 'small muted' }, fmtDate(ln.loan_date)) : null),
        h('td', { class: 'num' }, money(ln.principal)), h('td', { class: 'num' }, money(ln.monthly_instalment)), h('td', { class: 'nowrap' }, monthLabel(ln.start_period)),
        h('td', { class: 'num' }, h('button', { class: 'linkish', type: 'button', onclick: () => history(ln) }, money(repaid(ln)))), h('td', { class: 'num strong' }, money(bal)),
        h('td', {}, ln.status === 'closed' ? h('span', { class: 'tag' }, 'Closed') : bal === 0 ? h('span', { class: 'tag ok' }, 'Repaid') : h('span', { class: 'tag info' }, 'Active')),
        h('td', { class: 'nowrap' }, ln.status === 'active' ? [h('button', { class: 'btn sm', type: 'button', onclick: () => edit(ln) }, 'Edit'), ' ',
          h('button', { class: 'btn sm', type: 'button', onclick: () => closeLoan(ln, bal) }, 'Close')] : null));
    }) : h('tr', {}, h('td', { colspan: 10, class: 'muted' }, 'No loans.')))))));

  function edit(ln) {
    const cur = people.filter((p) => !p.resigned_date || p.resigned_date >= todayIso() || p.id === ln?.employee_id);
    const F = {
      employee_id: field('Employee', { type: 'select', required: true, value: ln?.employee_id, options: [['', '— choose —'], ...cur.map((p) => [p.id, `${p.full_name}${p.emp_id ? ` · ${p.emp_id}` : ''}`])] }),
      company_id: field('Deduct from pay by', { type: 'select', value: ln?.company_id || '', options: [['', 'Their main paying company'], ...ref.companies.filter((c) => c.is_active).map((c) => [c.id, c.short_name || c.name])] }),
      description: field('Description', { value: ln?.description, placeholder: 'e.g. Advance for laptop' }),
      loan_date: field('Date lent', { type: 'date', value: ln?.loan_date || todayIso() }),
      principal: field('Amount lent (RM)', { type: 'number', step: '0.01', required: true, value: ln?.principal }),
      monthly_instalment: field('Monthly instalment (RM)', { type: 'number', step: '0.01', required: true, value: ln?.monthly_instalment }),
      start: field('First payroll month to deduct', { type: 'month', required: true, value: (ln?.start_period || periodOf(todayIso())).slice(0, 7) }),
    };
    openModal({ title: ln ? 'Edit loan' : 'Add loan', wide: true, body: h('div', { class: 'form-grid' }, Object.values(F)),
      actions: [{ label: 'Save', primary: true, onClick: async (close) => {
        const v = { employee_id: Number(F.employee_id.getValue()), company_id: F.company_id.getValue() ? Number(F.company_id.getValue()) : null, description: F.description.getValue(),
          loan_date: F.loan_date.getValue(), principal: Number(F.principal.getValue()), monthly_instalment: Number(F.monthly_instalment.getValue()),
          start_period: F.start.getValue() ? `${F.start.getValue()}-01` : null };
        if (!v.employee_id || !(v.principal > 0) || !(v.monthly_instalment > 0) || !v.start_period) { toast('Choose the employee and enter the amount, instalment and first month.', 'error'); return false; }
        if (ln && v.principal < repaid(ln)) { toast(`RM${money(repaid(ln))} has already been repaid; the amount cannot be less.`, 'error'); return false; }
        const { error } = ln ? await ctx.sb.from('eppd_loans').update(v).eq('id', ln.id) : await ctx.sb.from('eppd_loans').insert(v);
        if (failed(error)) return false;
        close(); toast(ln ? 'Loan updated.' : 'Loan added. It is deducted from the payroll month you chose (Recalculate open months).'); window.dispatchEvent(new HashChangeEvent('hashchange')); return true;
      } }] });
  }
  async function closeLoan(ln, bal) {
    const f = field('Reason', { type: 'textarea', value: bal > 0 ? '' : 'Repaid in full' });
    openModal({ title: 'Close loan', body: h('div', {}, h('p', { style: 'margin-bottom:.8rem' }, bal > 0 ? `RM${money(bal)} is still owed. Closing stops further deductions (for example when it was repaid in cash or written off).` : 'This loan is fully repaid.'), f),
      actions: [{ label: 'Close loan', primary: true, onClick: async (close) => {
        const { error } = await ctx.sb.from('eppd_loans').update({ status: 'closed', closed_note: f.getValue() }).eq('id', ln.id);
        if (failed(error)) return false; close(); toast('Loan closed.'); window.dispatchEvent(new HashChangeEvent('hashchange')); return true;
      } }] });
  }
  function history(ln) {
    const rows = (pays.get(ln.id) || []).sort((a, b) => a.period.localeCompare(b.period));
    let run = Number(ln.principal);
    openModal({ title: `Repayments · ${byId.get(ln.employee_id)?.full_name || ''}`, body: h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ['Payroll month', 'Repaid', 'Balance'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
      h('tbody', {}, h('tr', {}, h('td', {}, `Lent${ln.loan_date ? ` ${fmtDate(ln.loan_date)}` : ''}`), h('td', {}), h('td', { class: 'num' }, money(run))),
        rows.map((r) => { run -= r.amount; return h('tr', {}, h('td', {}, monthLabel(r.period)), h('td', { class: 'num' }, money(r.amount)), h('td', { class: 'num' }, money(Math.max(0, run)))); }))) });
  }
}
