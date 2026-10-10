// Payslips & reports: payslips (print / PDF), monthly summary, payment list, EPF / SOCSO & EIS / PCB lists,
// year to date, EA forms. Finalised months only.
import { h, clear, pageHead, toast, failed, money, fmtDate, field } from '../ui.js';
import { loadRef } from '../data.js';
import { loadFinalisedRuns, loadLines, loadPeopleDetails } from '../report-data.js';
import { downloadXlsx } from '../xlsx-export.js';
import { loadLeaveYear, balancesFor, loadPeople } from '../leave-data.js';
import { payslipModel, sumLines, paidLines, summaryColumns, itemsByCode, ytdRows, eaFigures, socsoNo } from '../engines/reports.js';
import { monthLabel, periodOf, STAT_COLS, STAT_LEGEND, statVal } from '../engines/payroll.js';
import { lastDayOfMonth, todayIso } from '../engines/employee.js';

const VIEWS = [['payslips', 'Payslips'], ['summary', 'Monthly summary'], ['payment', 'Payment list'], ['epf', 'EPF'], ['socso', 'SOCSO & EIS'], ['pcb', 'PCB'], ['ytd', 'Year to date'], ['ea', 'EA forms']];
const YEAR_VIEWS = new Set(['ytd', 'ea']);
const shortMonth = (p) => new Date(periodOf(p) + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const n2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

export async function render(el, ctx, params, query) {
  const ref = await loadRef(ctx.sb);
  const runs = await loadFinalisedRuns(ctx.sb);
  const view = VIEWS.some(([k]) => k === query.view) ? query.view : 'payslips';
  el.append(pageHead('Payslips & reports', 'Everything here comes from finalised payroll months, so it cannot change after it is issued.'));
  if (!runs.length) {
    el.append(h('div', { class: 'empty-state' }, h('p', {}, 'No finalised payroll months yet.'), h('p', {}, h('a', { href: '#/payroll' }, 'Payroll › Monthly payroll'), ' – finalise a month, or import past months first.')));
    return;
  }
  const month = runs.some((r) => r.period.slice(0, 7) === query.month) ? `${query.month}-01` : runs[0].period;
  const years = [...new Set(runs.map((r) => Number(r.period.slice(0, 4))))].sort((a, b) => b - a);
  const year = years.includes(Number(query.year)) ? Number(query.year) : Number(month.slice(0, 4));
  const company = query.company || '';
  const go = (patch) => {
    const q = new URLSearchParams({ view, month: month.slice(0, 7), year: String(year), company, ...patch });
    for (const [k, v] of [...q]) if (v === '' || v === undefined || v === 'undefined') q.delete(k);
    location.hash = `#/reports?${q}`;
  };

  // ---- data
  const fromP = YEAR_VIEWS.has(view) ? `${year}-01-01` : `${month.slice(0, 4)}-01-01`;
  const toP = YEAR_VIEWS.has(view) ? `${year}-12-01` : month;
  const [P, allLines] = await Promise.all([loadPeopleDetails(ctx.sb, ref), loadLines(ctx.sb, fromP, toP)]);
  const coName = (id) => P.companies.get(Number(id))?.name || 'No company';
  const coShort = (id) => P.companies.get(Number(id))?.short_name || coName(id);
  const inCompany = (l) => !company || String(l.company_id || '') === company;
  const monthLines = paidLines(allLines.filter((l) => l.period === month)).filter(inCompany);
  const companiesIn = (lines) => [...new Set(lines.map((l) => l.company_id || 0))].sort((a, b) => coName(a).localeCompare(coName(b)));
  const person = (id) => P.people.get(id) || { priv: {}, employments: [] };

  // ---- toolbar
  const monthSel = h('select', { 'aria-label': 'Month', style: 'width:auto' }, runs.map((r) => h('option', { value: r.period.slice(0, 7), selected: r.period === month }, monthLabel(r.period))));
  monthSel.addEventListener('change', () => go({ month: monthSel.value, year: monthSel.value.slice(0, 4) }));
  const yearSel = h('select', { 'aria-label': 'Year', style: 'width:auto' }, years.map((y) => h('option', { value: y, selected: y === year }, y)));
  yearSel.addEventListener('change', () => go({ year: yearSel.value }));
  const compSel = h('select', { 'aria-label': 'Company', style: 'width:auto' }, h('option', { value: '' }, 'All companies'),
    [...P.companies.values()].filter((c) => allLines.some((l) => l.company_id === c.id)).map((c) => h('option', { value: c.id, selected: String(c.id) === company }, c.short_name || c.name)));
  compSel.addEventListener('change', () => go({ company: compSel.value }));
  const tabs = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Report' }, VIEWS.map(([k, l]) =>
    h('button', { type: 'button', role: 'tab', 'aria-selected': String(view === k), onclick: () => go({ view: k }) }, l)));
  const actions = h('div', { class: 'side-actions' });
  el.append(h('section', { class: 'panel no-print' }, h('div', { class: 'panel-head filters' }, tabs,
    h('div', { class: 'filter-row', style: 'justify-content:flex-start;gap:.6rem' }, YEAR_VIEWS.has(view) ? yearSel : monthSel, compSel, actions))));
  const body = h('div', {}); el.append(body);

  // ---- print mode: a toolbar and A4 sheets; the rest of the app is hidden when printing
  const printDoc = (sheets, title) => {
    document.title = `${title} · MyPayroll V2.0`;
    const bar = h('div', { class: 'print-bar no-print' },
      h('button', { class: 'btn', type: 'button', onclick: () => go({ print: '' }) }, '‹ Back'),
      h('span', { class: 'small muted' }, `${sheets.length} page${sheets.length === 1 ? '' : 's'} · choose “Save as PDF” as the printer to get a PDF`),
      h('button', { class: 'btn primary', type: 'button', onclick: () => window.print() }, 'Print / Save as PDF'));
    clear(el).append(bar, h('div', { class: 'print-doc' }, sheets));
  };
  const companyHead = (cid, title, sub) => {
    const c = P.companies.get(Number(cid)) || {};
    return h('div', { class: 'doc-head' },
      c.logo ? h('img', { class: 'doc-logo', src: c.logo, alt: '' }) : null,
      h('div', { class: 'doc-co' }, h('div', { class: 'doc-co-name' }, c.name || 'No company'),
        h('div', {}, [c.registration_no ? `(${c.registration_no})` : null, c.address].filter(Boolean).join(' · ')),
        h('div', {}, [c.phone ? `Tel ${c.phone}` : null, c.email].filter(Boolean).join(' · '))),
      h('div', { class: 'doc-title' }, h('div', {}, title), sub ? h('div', { class: 'doc-sub' }, sub) : null));
  };

  // ======================================================== PAYSLIPS
  if (view === 'payslips') {
    const lines = monthLines.slice().sort((a, b) => coName(a.company_id).localeCompare(coName(b.company_id)) || a.emp_name.localeCompare(b.emp_name));
    if (query.print) {
      const pick = query.print === 'all' ? lines : lines.filter((l) => String(l.id) === query.print);
      const L = await loadLeaveYear(ctx.sb, Number(month.slice(0, 4)));
      const leavePeople = new Map((await loadPeople(ctx.sb, L.ref)).map((p) => [p.id, p]));
      const asOf = lastDayOfMonth(month);
      const sheets = pick.map((l) => {
        const ytd = allLines.filter((x) => x.employee_id === l.employee_id && (x.company_id || 0) === (l.company_id || 0) && x.period <= month);
        let leave = null;
        try { const lp = leavePeople.get(l.employee_id); if (lp) leave = balancesFor(lp, L, asOf); } catch { leave = null; }
        return payslipSheet(l, payslipModel(l, ytd), leave);
      });
      printDoc(sheets, `Payslips ${shortMonth(month)}`);
      return;
    }
    actions.append(h('button', { class: 'btn primary', type: 'button', disabled: !lines.length, onclick: () => go({ print: 'all' }) }, `Print all ${lines.length} payslips`));
    body.append(h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, `Payslips · ${monthLabel(month)}`),
      h('p', { class: 'small muted' }, 'One page per person per paying company, with the company logo, year-to-date totals and leave balances at the month end. Use "Save as PDF" in the print window to get PDF files.'))),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ['Employee', 'Company', 'Gross', 'Deductions', 'Net paid', ''].map((t, i) => h('th', { class: i >= 2 && i <= 4 ? 'num' : '' }, t)))),
        h('tbody', {}, lines.map((l) => h('tr', {},
          h('td', {}, h('span', { class: 'strong' }, l.emp_name), h('div', { class: 'small muted' }, l.emp_code || '')),
          h('td', { class: 'small' }, coShort(l.company_id)),
          h('td', { class: 'num' }, money(l.gross)), h('td', { class: 'num' }, money(n2(l.epf_ee) + n2(l.socso_ee) + n2(l.eis_ee) + n2(l.pcb) + n2(l.personal_deductions))),
          h('td', { class: 'num strong' }, money(l.net_paid)),
          h('td', {}, h('button', { class: 'btn sm', type: 'button', onclick: () => go({ print: String(l.id) }) }, 'Payslip')))))))));
    return;
  }

  function payslipSheet(l, m, leave) {
    const p = person(l.employee_id); const em = P.employmentFor(p, month);
    const kv = (k, v) => h('div', { class: 'kv-row' }, h('span', {}, k), h('b', {}, v || '—'));
    const amtRows = (list, sign = '') => list.map((i) => h('tr', {}, h('td', {}, i.label), h('td', { class: 'num' }, `${sign}${money(i.amount)}`)));
    return h('section', { class: 'sheet payslip' },
      companyHead(l.company_id, 'PAYSLIP', monthLabel(month)),
      h('div', { class: 'doc-grid' },
        h('div', {}, kv('Employee', l.emp_name), kv('Employee ID', l.emp_code), kv('NRIC / Passport', p.priv.nric || p.priv.passport_no)),
        h('div', {}, kv('Department', em?.department_id ? P.dept(em.department_id)?.code : ''), kv('Job title', em?.job_title_id ? P.title(em.job_title_id)?.name : ''),
          kv('EPF / SOCSO / Tax no.', [p.priv.epf_no || '—', socsoNo(p.priv) || '—', p.priv.tax_no || '—'].join(' · ')))),
      h('div', { class: 'doc-two' },
        h('table', { class: 'doc-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Earnings'), h('th', { class: 'num' }, 'RM'))),
          h('tbody', {}, ...amtRows(m.earnings), ...amtRows(m.deductions, '−')),
          h('tfoot', {}, h('tr', {}, h('th', {}, 'Gross pay'), h('th', { class: 'num' }, money(m.gross))))),
        h('table', { class: 'doc-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Deductions'), h('th', { class: 'num' }, 'RM'))),
          h('tbody', {}, ...m.statutory.map((s) => h('tr', {}, h('td', {}, s.label), h('td', { class: 'num' }, money(s.ee)))),
            h('tr', {}, h('td', {}, 'PCB (monthly tax deduction)'), h('td', { class: 'num' }, money(m.pcb))), ...amtRows(m.personal)),
          h('tfoot', {}, h('tr', {}, h('th', {}, 'Total deductions'), h('th', { class: 'num' }, money(m.totalDeductions)))))),
      m.claims.length ? h('table', { class: 'doc-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Claims reimbursed (not taxed)'), h('th', { class: 'num' }, 'RM'))),
        h('tbody', {}, ...amtRows(m.claims)), h('tfoot', {}, h('tr', {}, h('th', {}, 'Total claims'), h('th', { class: 'num' }, money(m.claimsTotal))))) : null,
      h('div', { class: 'doc-net' }, h('span', {}, m.claims.length ? 'NET PAY (incl. claims)' : 'NET PAY'), h('b', {}, `RM ${money(m.netPaid)}`)),
      h('div', { class: 'doc-three' },
        h('table', { class: 'doc-table small' }, h('thead', {}, h('tr', {}, h('th', {}, 'Employer contributions'), h('th', { class: 'num' }, 'RM'))),
          h('tbody', {}, m.statutory.filter((s) => s.er !== null).map((s) => h('tr', {}, h('td', {}, s.label.replace(' – Invalidity', '')), h('td', { class: 'num' }, money(s.er)))))),
        h('table', { class: 'doc-table small' }, h('thead', {}, h('tr', {}, h('th', {}, `Year to date ${month.slice(0, 4)}`), h('th', { class: 'num' }, 'RM'))),
          h('tbody', {}, [['Gross pay', m.ytd.gross], ['EPF', m.ytd.epf_ee], ['SOCSO – Invalidity', statVal(m.ytd, 'socso_ee_inv')], ['SOCSO – NEI', m.ytd.socso_ee_nei], ['EIS', m.ytd.eis_ee], ['PCB', m.ytd.pcb], ['Net paid', m.ytd.net_paid]]
            .map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { class: 'num' }, money(v)))))),
        h('table', { class: 'doc-table small' }, h('thead', {}, h('tr', {}, h('th', {}, `Leave at ${fmtDate(lastDayOfMonth(month))}`), h('th', { class: 'num' }, 'Days left'))),
          h('tbody', {}, leave ? [['Annual leave', leave.AL.balance], ['Sick leave', leave.SL.balance], ['Replacement leave', leave.RL.balance]].map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { class: 'num' }, String(v ?? '—'))))
            : h('tr', {}, h('td', { colspan: 2, class: 'muted' }, 'Not available'))))),
      h('div', { class: 'doc-foot' }, h('span', {}, `Paid to: ${[P.bank(p.priv.bank_code), p.priv.bank_account_no].filter(Boolean).join(' ') || 'bank details not recorded'}`),
        h('span', {}, 'This is a computer-generated payslip; no signature is required.')));
  }

  // ======================================================== generic list (screen + print + Excel)
  function listView({ title, desc, header, rowFor, totalsFor, file, check, numCols }) {
    const groups = companiesIn(monthLines).map((cid) => ({ cid, lines: monthLines.filter((l) => (l.company_id || 0) === cid).sort((a, b) => a.emp_name.localeCompare(b.emp_name)) }));
    const rowsOf = (g) => g.lines.map((l, i) => rowFor(l, i + 1)).filter(Boolean);
    const isNum = (i) => numCols.includes(i);
    const cell = (v, i) => h('td', { class: isNum(i) ? 'num' : '' }, isNum(i) ? money(v) : (v ?? ''));
    if (query.print === 'list') {
      printDoc(groups.map((g) => h('section', { class: 'sheet list-sheet' }, companyHead(g.cid, title, monthLabel(month)),
        h('table', { class: 'doc-table' }, h('thead', {}, h('tr', {}, header.map((t, i) => h('th', { class: isNum(i) ? 'num' : '' }, t)))),
          h('tbody', {}, rowsOf(g).map((r) => h('tr', {}, r.map(cell)))), h('tfoot', {}, h('tr', {}, totalsFor(g.lines).map((v, i) => h('th', { class: isNum(i) ? 'num' : '' }, isNum(i) ? money(v) : v))))),
        h('div', { class: 'doc-sign' }, h('div', {}, 'Prepared by'), h('div', {}, 'Checked by'), h('div', {}, 'Approved by')))), `${title} ${shortMonth(month)}`);
      return;
    }
    actions.append(h('button', { class: 'btn', type: 'button', disabled: !groups.length, onclick: () => go({ print: 'list' }) }, 'Print / PDF'),
      h('button', { class: 'btn primary', type: 'button', disabled: !groups.length, onclick: excel }, 'Download Excel'));
    async function excel() {
      try {
        await downloadXlsx(`${file}_${month.slice(0, 7)}.xlsx`, groups.map((g) => {
          const c = P.companies.get(Number(g.cid)) || {};
          return { name: c.short_name || c.code || 'No company', title: [c.name || 'No company', `${title} · ${monthLabel(month)}`],
            header, rows: rowsOf(g).map((r) => r.map((v, i) => (isNum(i) ? n2(v) : (v ?? '')))), total: totalsFor(g.lines).map((v, i) => (isNum(i) ? n2(v) : v)) };
        }));
      } catch (e) { toast(e.message || String(e), 'error'); }
    }
    const problems = check ? monthLines.map((l) => check(l)).filter(Boolean) : [];
    body.append(
      problems.length ? h('div', { class: 'setup-warning', style: 'margin-bottom:1rem' }, h('b', {}, `${problems.length} to check: `), problems.slice(0, 8).join(' · '), problems.length > 8 ? ` … and ${problems.length - 8} more` : '') : null,
      desc ? h('p', { class: 'small muted', style: 'margin-bottom:1rem' }, desc) : null,
      ...groups.map((g) => h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, coName(g.cid)), h('span', { class: 'small muted' }, `${g.lines.length} staff · ${monthLabel(month)}`)),
        h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, header.map((t, i) => h('th', { class: isNum(i) ? 'num' : '' }, t)))),
          h('tbody', {}, rowsOf(g).map((r) => h('tr', {}, r.map(cell)))),
          h('tfoot', {}, h('tr', {}, totalsFor(g.lines).map((v, i) => h('th', { class: isNum(i) ? 'num' : '' }, isNum(i) ? money(v) : v)))))))),
      groups.length ? null : h('div', { class: 'empty-state' }, 'Nobody was paid in this month for the selected company.'));
  }
  const sumK = (lines, k) => n2(lines.reduce((s, l) => s + (Number(l[k]) || 0), 0));
  const sumS = (lines, k) => n2(lines.reduce((s, l) => s + statVal(l, k), 0));
  const nric = (l) => person(l.employee_id).priv.nric || person(l.employee_id).priv.passport_no || '';

  if (view === 'payment') {
    return listView({ title: 'Salary payment list', file: 'payment_list', numCols: [6],
      desc: 'Net pay per person with the bank account to pay into. Key these into your bank; the total per company matches the finalised payroll.',
      header: ['No.', 'Employee ID', 'Name', 'NRIC / Passport', 'Bank', 'Account no.', 'Net pay (RM)'],
      rowFor: (l, i) => [i, l.emp_code || '', l.emp_name, nric(l), P.bank(person(l.employee_id).priv.bank_code) || '', person(l.employee_id).priv.bank_account_no || '', l.net_paid],
      totalsFor: (ls) => ['', '', `Total (${ls.length})`, '', '', '', sumK(ls, 'net_paid')],
      check: (l) => (!person(l.employee_id).priv.bank_account_no ? `${l.emp_name}: no bank account` : null) });
  }
  if (view === 'epf') {
    return listView({ title: 'EPF (KWSP) contributions', file: 'epf', numCols: [4, 5, 6, 7],
      desc: 'Wages are the amounts subject to EPF. Key these into KWSP i-Akaun (Majikan).',
      header: ['No.', 'Name', 'NRIC / Passport', 'EPF no.', 'Wage (RM)', 'Employee (RM)', 'Employer (RM)', 'Total to pay (RM)'],
      rowFor: (l, i) => (n2(l.epf_ee) || n2(l.epf_er) ? [i, l.emp_name, nric(l), person(l.employee_id).priv.epf_no || '', l.epf_wage, l.epf_ee, l.epf_er, n2(l.epf_ee) + n2(l.epf_er)] : null),
      totalsFor: (ls) => ['', 'Total', '', '', sumK(ls, 'epf_wage'), sumK(ls, 'epf_ee'), sumK(ls, 'epf_er'), sumK(ls, 'epf_ee') + sumK(ls, 'epf_er')],
      check: (l) => ((n2(l.epf_ee) || n2(l.epf_er)) && !person(l.employee_id).priv.epf_no ? `${l.emp_name}: no EPF number` : null) });
  }
  if (view === 'socso') {
    return listView({ title: 'SOCSO & EIS contributions', file: 'socso_eis', numCols: [4, 5, 6, 7, 8, 9, 10, 11],
      desc: `SOCSO number is the one on record, otherwise the NRIC digits. Key these into PERKESO ASSIST. ${STAT_LEGEND}. Total to pay = all SOCSO and EIS shares.`,
      header: ['No.', 'Name', 'NRIC / Passport', 'SOCSO no.', 'SOCSO wage', 'SOCSO ee Inv.', 'SOCSO ee NEI', 'SOCSO er', 'EIS wage', 'EIS ee', 'EIS er', 'Total to pay (RM)'],
      rowFor: (l, i) => (n2(l.socso_ee) + n2(l.socso_er) + n2(l.eis_ee) + n2(l.eis_er) ? [i, l.emp_name, nric(l), socsoNo(person(l.employee_id).priv), l.socso_wage,
        statVal(l, 'socso_ee_inv'), statVal(l, 'socso_ee_nei'), l.socso_er, l.eis_wage, l.eis_ee, l.eis_er,
        n2(l.socso_ee) + n2(l.socso_er) + n2(l.eis_ee) + n2(l.eis_er)] : null),
      totalsFor: (ls) => ['', 'Total', '', '', sumK(ls, 'socso_wage'), sumS(ls, 'socso_ee_inv'), sumK(ls, 'socso_ee_nei'), sumK(ls, 'socso_er'), sumK(ls, 'eis_wage'), sumK(ls, 'eis_ee'), sumK(ls, 'eis_er'),
        sumK(ls, 'socso_ee') + sumK(ls, 'socso_er') + sumK(ls, 'eis_ee') + sumK(ls, 'eis_er')] });
  }
  if (view === 'pcb') {
    return listView({ title: 'PCB (monthly tax deduction)', file: 'pcb', numCols: [4],
      desc: 'Only staff with PCB this month. Key these into LHDN e-PCB / e-CP39.',
      header: ['No.', 'Name', 'NRIC / Passport', 'Tax no. (TIN)', 'PCB (RM)'],
      rowFor: (l, i) => (n2(l.pcb) ? [i, l.emp_name, nric(l), person(l.employee_id).priv.tax_no || '', l.pcb] : null),
      totalsFor: (ls) => ['', 'Total', '', '', sumK(ls, 'pcb')],
      check: (l) => (n2(l.pcb) && !person(l.employee_id).priv.tax_no ? `${l.emp_name}: no tax number` : null) });
  }

  // ======================================================== MONTHLY SUMMARY
  if (view === 'summary') {
    const cols = summaryColumns(monthLines, new Map((await ctx.sb.from('eppd_payment_types').select('code,name,sort_order')).data?.map((t) => [t.code, t]) || []));
    const fixed = [['gross', 'Gross'], ...STAT_COLS, ['pcb', 'PCB'], ['net', 'Net pay'], ['personal_deductions', 'Personal deductions'], ['net_paid', 'Net paid']];
    const header = ['No.', 'Employee ID', 'Name', ...cols.map((c) => (c.kind === 'deduction' ? `${c.label} (−)` : c.label)), ...fixed.map(([, l]) => l)];
    const rowOf = (l, i) => { const m = itemsByCode(l); return [i, l.emp_code || '', l.emp_name, ...cols.map((c) => m[c.code] || 0), ...fixed.map(([k]) => statVal(l, k))]; };
    const totalOf = (ls, label) => ['', '', label, ...cols.map((c) => n2(ls.reduce((s, l) => s + (itemsByCode(l)[c.code] || 0), 0))), ...fixed.map(([k]) => sumS(ls, k))];
    const groups = companiesIn(monthLines).map((cid) => ({ cid, lines: monthLines.filter((l) => (l.company_id || 0) === cid).sort((a, b) => a.emp_name.localeCompare(b.emp_name)) }));
    const numFrom = 3;
    actions.append(h('button', { class: 'btn primary', type: 'button', disabled: !groups.length, onclick: async () => {
      try {
        await downloadXlsx(`monthly_summary_${month.slice(0, 7)}.xlsx`, [
          { name: 'All companies', title: ['MyEden Group · monthly payroll summary', monthLabel(month)], header: ['Company', ...header],
            rows: groups.flatMap((g) => g.lines.map((l, i) => [coShort(g.cid), ...rowOf(l, i + 1)])), total: ['', ...totalOf(monthLines, `Total (${monthLines.length})`)] },
          ...groups.map((g) => ({ name: coShort(g.cid), title: [coName(g.cid), `Payroll summary · ${monthLabel(month)}`], header, rows: g.lines.map(rowOf), total: totalOf(g.lines, `Total (${g.lines.length})`) })),
        ]);
      } catch (e) { toast(e.message || String(e), 'error'); }
    } }, 'Download Excel'));
    const tbl = (ls, label) => h('table', { class: 'data dense' },
      h('thead', {}, h('tr', {}, header.map((t, i) => h('th', { class: i >= numFrom ? 'num' : '' }, t)))),
      h('tbody', {}, ls.map((l, i) => h('tr', {}, rowOf(l, i + 1).map((v, j) => h('td', { class: j >= numFrom ? 'num' : (j === 2 ? 'nowrap' : '') }, j >= numFrom ? (v ? money(v) : '') : v))))),
      h('tfoot', {}, h('tr', {}, totalOf(ls, label).map((v, j) => h('th', { class: j >= numFrom ? 'num' : '' }, j >= numFrom ? money(v) : v)))));
    const T = sumLines(monthLines);
    body.append(h('div', { class: 'facts' }, [[T.lines, 'staff paid'], [money(T.gross), 'gross'],
      ...STAT_COLS.map(([k, l]) => [money(statVal(T, k)), l]), [money(T.pcb), 'PCB'], [money(T.net_paid), 'net paid'], [money(T.employer_cost), 'employer cost']].map(([v, l]) => h('div', { class: 'fact' }, h('b', {}, v), h('span', {}, l)))),
      h('p', { class: 'small muted', style: 'margin:-.4rem 0 1rem' }, STAT_LEGEND),
      ...groups.map((g) => h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, coName(g.cid))), h('div', { class: 'table-wrap' }, tbl(g.lines, `Total (${g.lines.length})`)))));
    return;
  }

  // ======================================================== YEAR TO DATE
  const yearLines = paidLines(allLines.filter((l) => l.period.startsWith(String(year)))).filter(inCompany);
  const lastMonth = yearLines.reduce((m, l) => (l.period > m ? l.period : m), '');
  if (view === 'ytd') {
    const rows = ytdRows(yearLines);
    const keys = [['gross', 'Gross'], ...STAT_COLS, ['pcb', 'PCB'], ['net_paid', 'Net paid']];
    const header = ['Employee ID', 'Name', 'Company', 'Months', ...keys.map(([, l]) => l)];
    const rowOf = (r) => [r.emp_code || '', r.emp_name, coShort(r.company_id), r.months, ...keys.map(([k]) => statVal(r, k))];
    const T = sumLines(yearLines);
    const total = ['', `Total (${rows.length})`, '', '', ...keys.map(([k]) => statVal(T, k))];
    actions.append(h('button', { class: 'btn primary', type: 'button', disabled: !rows.length, onclick: async () => {
      try { await downloadXlsx(`year_to_date_${year}.xlsx`, [{ name: `YTD ${year}`, title: ['MyEden Group · year to date', `${year} · January to ${lastMonth ? monthLabel(lastMonth) : '—'}`], header, rows: rows.map(rowOf), total }]); }
      catch (e) { toast(e.message || String(e), 'error'); }
    } }, 'Download Excel'));
    body.append(h('p', { class: 'small muted', style: 'margin-bottom:1rem' }, `Finalised months of ${year}${lastMonth ? `, January to ${monthLabel(lastMonth)}` : ''}. One row per person per paying company. ${STAT_LEGEND}.`),
      h('section', { class: 'panel' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, header.map((t, i) => h('th', { class: i >= 3 ? 'num' : '' }, t)))),
        h('tbody', {}, rows.map((r) => h('tr', {}, rowOf(r).map((v, i) => h('td', { class: i >= 3 ? 'num' : '' }, i >= 4 ? money(v) : v))))),
        h('tfoot', {}, h('tr', {}, total.map((v, i) => h('th', { class: i >= 3 ? 'num' : '' }, i >= 4 ? money(v) : v))))))));
    return;
  }

  // ======================================================== EA FORMS
  if (view === 'ea') {
    const ea = eaFigures(yearLines);
    const sig = { name: '', position: '', phone: '', ...(ref.policies.ea_signatory || {}) };
    const fName = field('Signed by (name)', { value: sig.name }); const fPos = field('Position', { value: sig.position }); const fTel = field('Employer telephone (if not on the company record)', { value: sig.phone });
    const fDate = field('Date', { type: 'date', value: todayIso() });
    const sign = () => ({ name: fName.getValue() || '', position: fPos.getValue() || '', phone: fTel.getValue() || '', date: fDate.getValue() || todayIso() });
    const issues = (e) => {
      const p = person(e.employee_id); const c = P.companies.get(Number(e.company_id)) || {}; const out = [];
      if (!p.priv.tax_no) out.push('no tax number (TIN)');
      if (!c.tax_employer_no) out.push(`${c.short_name || c.name || 'company'} has no E number`);
      if (!e.balanced) out.push('B + F does not equal gross pay');
      return out;
    };
    if (query.print === 'ea') {
      const s = JSON.parse(sessionStorageGet('eppd-ea-sign') || 'null') || sign();
      const list = query.only !== undefined ? [ea[Number(query.only)]].filter(Boolean) : ea;
      printDoc(list.map((e) => eaSheet(e, s)), list.length === 1 ? `EA ${year} ${list[0].emp_name}` : `EA forms ${year}`);
      return;
    }
    actions.append(h('button', { class: 'btn primary', type: 'button', disabled: !ea.length, onclick: () => { sessionStorageSet('eppd-ea-sign', JSON.stringify(sign())); go({ print: 'ea' }); } }, `Print ${ea.length} EA form${ea.length === 1 ? '' : 's'}`),
      h('button', { class: 'btn', type: 'button', disabled: !ea.length, onclick: async () => {
        try {
          await downloadXlsx(`EA_${year}.xlsx`, [{ name: `EA ${year}`, title: [`Borang EA (C.P.8A) figures · ${year}`, 'B1(a) salary incl. overtime & leave pay · B1(b) commission & bonus · B1(c) allowances & perquisites · F exempt'],
            header: ['Employee ID', 'Name', 'Company', 'Months', 'B1(a)', 'B1(b)', 'B1(c)', 'B6 compensation', 'Total B', 'F exempt', 'D1 PCB', 'E1 EPF (employee)', 'E2 PERKESO (SOCSO + EIS, employee)'],
            rows: ea.map((e) => [e.emp_code || '', e.emp_name, coShort(e.company_id), e.months, e.b1a, e.b1b, e.b1c, e.b6 || 0, e.totalB, e.f_exempt, e.d1_pcb, e.e1_epf, e.e2_perkeso]) }]);
        } catch (err) { toast(err.message || String(err), 'error'); }
      } }, 'Download Excel'));
    const missing = ea.filter((e) => issues(e).length).length;
    body.append(
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, `Borang EA ${year}`),
        h('p', { class: 'small muted' }, `One form per person per paying company, from the finalised months of ${year}${lastMonth ? ` (January to ${monthLabel(lastMonth)})` : ''}. Give each employee their EA form by the end of February ${year + 1}.`))),
        h('div', { class: 'panel-body' },
          h('div', { class: 'form-grid' }, fName, fPos, fTel, fDate),
          ctx.can(['admin']) ? h('button', { class: 'btn sm', type: 'button', style: 'margin-top:.6rem', onclick: async () => {
            const v = sign(); delete v.date;
            const { error } = await ctx.sb.from('eppd_policies').upsert({ key: 'ea_signatory', value: v, description: 'Person who signs the EA forms.' });
            if (!failed(error)) toast('Saved as the default signatory.');
          } }, 'Save as default signatory') : null,
          h('p', { class: 'small muted', style: 'margin-top:.8rem' }, 'How pay is placed on the form: B1(a) basic, overtime and leave pay (AL buy-back), less unpaid leave · B1(b) commission, incentives and bonus · B1(c) allowances, gifts (ang bao) and other perquisites · F payment types marked "not subject to PCB" in Settings › Payment types. Ask your tax agent to confirm the treatment of each allowance.'))),
      missing ? h('p', { class: 'setup-warning', style: 'margin-bottom:1rem' }, `${missing} form(s) have something to fix first (see the last column).`) : null,
      h('section', { class: 'panel' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ['Employee', 'Company', 'Months', 'B1(a)', 'B1(b)', 'B1(c)', 'F exempt', 'PCB', 'EPF', 'PERKESO', 'To fix', ''].map((t, i) => h('th', { class: i >= 2 && i <= 9 ? 'num' : '' }, t)))),
        h('tbody', {}, ea.map((e, idx) => { const is = issues(e);
          return h('tr', { class: is.length ? 'flag' : '' }, h('td', {}, h('span', { class: 'strong' }, e.emp_name), h('div', { class: 'small muted' }, e.emp_code || '')),
            h('td', { class: 'small' }, coShort(e.company_id)), h('td', { class: 'num' }, e.months),
            ...[e.b1a, e.b1b, e.b1c, e.f_exempt, e.d1_pcb, e.e1_epf, e.e2_perkeso].map((v) => h('td', { class: 'num' }, money(v))),
            h('td', { class: 'small' }, is.join('; ')),
            h('td', {}, h('button', { class: 'btn sm', type: 'button', onclick: () => { sessionStorageSet('eppd-ea-sign', JSON.stringify(sign())); go({ print: 'ea', only: String(idx) }); } }, 'EA form')));
        }))))));
    return;
  }

  function eaSheet(e, s) {
    const p = person(e.employee_id); const c = P.companies.get(Number(e.company_id)) || {};
    const empls = p.employments || [];
    const joinedInYear = empls.find((x) => x.join_date && x.join_date.startsWith(String(year)) && x.join_date > `${year}-01-01`);
    const leftInYear = empls.find((x) => x.resigned_date && x.resigned_date.startsWith(String(year)));
    const em = P.employmentFor(p, e.lastPeriod);
    const row = (no, label, v, opts = {}) => h('tr', {}, h('td', { class: 'ea-no' }, no), h('td', {}, label), h('td', { class: 'num' }, v === null ? '' : money(v)), opts.extra || null);
    return h('section', { class: 'sheet ea' },
      h('div', { class: 'ea-top' }, h('div', {}, h('div', { class: 'small' }, 'Malaysia · Cukai Pendapatan'), h('div', { class: 'ea-form' }, 'EA'), h('div', { class: 'small' }, 'C.P.8A – Pin. 2023')),
        h('div', { class: 'ea-title' }, h('b', {}, `PENYATA SARAAN DARIPADA PENGGAJIAN BAGI TAHUN BERAKHIR 31 DISEMBER ${year}`), h('div', { class: 'small' }, `Statement of remuneration from employment for the year ended 31 December ${year}`)),
        h('div', { class: 'ea-ids' }, h('div', {}, 'No. Majikan E: ', h('b', {}, c.tax_employer_no || '—')), h('div', {}, 'No. Pengenalan Cukai (TIN) Pekerja: ', h('b', {}, p.priv.tax_no || '—')), h('div', {}, 'LHDNM Negeri: ', h('b', {}, '')))),
      h('h3', { class: 'ea-h' }, 'A. BUTIRAN PEKERJA / EMPLOYEE PARTICULARS'),
      h('table', { class: 'doc-table ea-tbl' }, h('tbody', {},
        [['1', 'Nama penuh pekerja / Full name', e.emp_name], ['2', 'Jawatan / Position', em?.job_title_id ? P.title(em.job_title_id)?.name : ''], ['3', 'No. kakitangan / Staff no.', e.emp_code || ''],
          ['4', 'No. K.P. baru / NRIC', p.priv.nric || ''], ['5', 'No. pasport / Passport no.', p.priv.passport_no || ''], ['6', 'No. KWSP / EPF no.', p.priv.epf_no || ''], ['7', 'No. PERKESO / SOCSO no.', socsoNo(p.priv)],
          ['8', 'Bilangan anak yang layak untuk pelepasan cukai / Children qualifying for tax relief', ''],
          ['9', 'Jika bekerja tidak genap setahun / If employed for part of the year: (a) tarikh mula / start date  (b) tarikh berhenti / end date',
            [joinedInYear ? `(a) ${fmtDate(joinedInYear.join_date)}` : null, leftInYear ? `(b) ${fmtDate(leftInYear.resigned_date)}` : null].filter(Boolean).join('   ')]]
          .map(([n1, l, v]) => h('tr', {}, h('td', { class: 'ea-no' }, n1), h('td', {}, l), h('td', { class: 'strong' }, v || ''))))),
      h('h3', { class: 'ea-h' }, 'B. PENDAPATAN PENGGAJIAN, MANFAAT DAN TEMPAT KEDIAMAN / EMPLOYMENT INCOME, BENEFITS AND LIVING ACCOMMODATION'),
      h('table', { class: 'doc-table ea-tbl' }, h('tbody', {},
        row('1(a)', 'Gaji kasar, upah atau gaji cuti (termasuk gaji lebih masa) / Gross salary, wages or leave pay (including overtime)', e.b1a),
        row('1(b)', 'Fi (termasuk fi pengarah), komisen atau bonus / Fees (including director fees), commission or bonus', e.b1b),
        row('1(c)', 'Tip kasar, perkuisit, penerimaan sagu hati atau elaun-elaun lain / Gross tips, perquisites, awards or other allowances', e.b1c),
        row('1(d)', 'Cukai pendapatan yang dibayar oleh majikan bagi pihak pekerja / Income tax borne by the employer', 0),
        row('1(e)', 'Manfaat Skim Opsyen Saham Pekerja (ESOS) / ESOS benefit', 0),
        row('1(f)', 'Ganjaran / Gratuity', 0),
        row('2', 'Bayaran tunggakan dan lain-lain bagi tahun terdahulu / Arrears and others for preceding years', 0),
        row('3', 'Manfaat berupa barangan / Benefits in kind', 0),
        row('4', 'Nilai tempat kediaman / Value of living accommodation', 0),
        row('5', 'Bayaran balik daripada Kumpulan Wang Simpanan/Pencen yang tidak diluluskan / Refund from unapproved provident/pension fund', 0),
        row('6', 'Pampasan kerana kehilangan pekerjaan / Compensation for loss of employment', e.b6 || 0)),
        h('tfoot', {}, h('tr', {}, h('th', {}), h('th', {}, 'JUMLAH / TOTAL'), h('th', { class: 'num' }, money(e.totalB))))),
      h('h3', { class: 'ea-h' }, 'C. PENCEN DAN LAIN-LAIN / PENSION AND OTHERS'),
      h('table', { class: 'doc-table ea-tbl' }, h('tbody', {}, row('1', 'Pencen / Pension', 0), row('2', 'Anuiti atau bayaran berkala yang lain / Annuities or other periodical payments', 0))),
      h('h3', { class: 'ea-h' }, 'D. JUMLAH POTONGAN / TOTAL DEDUCTIONS'),
      h('table', { class: 'doc-table ea-tbl' }, h('tbody', {},
        row('1', 'Potongan cukai bulanan (PCB) yang dibayar kepada LHDNM / Monthly tax deductions (MTD) remitted to LHDNM', e.d1_pcb),
        row('2', 'Arahan potongan CP38 / CP38 deductions', 0), row('3', 'Zakat yang dibayar melalui potongan gaji / Zakat paid via salary deduction', 0),
        row('4', 'Derma / hadiah / sumbangan diluluskan melalui potongan gaji / Approved donations via salary deduction', 0),
        row('5', 'Jumlah tuntutan potongan oleh pekerja melalui Borang TP1 / Total claims via Form TP1: (a) pelepasan / relief  (b) zakat', 0),
        row('6', 'Jumlah pelepasan bagi anak yang layak / Total qualifying child relief', 0))),
      h('h3', { class: 'ea-h' }, 'E. CARUMAN YANG DIBAYAR OLEH PEKERJA / CONTRIBUTIONS PAID BY THE EMPLOYEE'),
      h('table', { class: 'doc-table ea-tbl' }, h('tbody', {},
        row('1', 'Nama Kumpulan Wang: KUMPULAN WANG SIMPANAN PEKERJA (KWSP) — amaun caruman yang wajib dibayar (bahagian pekerja sahaja) / compulsory contribution (employee share only)', e.e1_epf),
        row('2', 'PERKESO (termasuk SIP) — amaun caruman yang wajib dibayar (bahagian pekerja sahaja) / SOCSO incl. EIS, employee share only', e.e2_perkeso))),
      h('h3', { class: 'ea-h' }, 'F. JUMLAH ELAUN / PERKUISIT / PEMBERIAN / MANFAAT YANG DIKECUALIKAN CUKAI / TOTAL TAX-EXEMPT ALLOWANCES / PERQUISITES / GIFTS / BENEFITS'),
      h('table', { class: 'doc-table ea-tbl' }, h('tbody', {}, row('', 'RM', e.f_exempt))),
      h('div', { class: 'ea-sign' },
        h('div', {}, h('div', { class: 'small muted' }, 'Nama pegawai / Officer'), h('b', {}, s.name || ' '), h('div', { class: 'small muted', style: 'margin-top:.4rem' }, 'Jawatan / Position'), h('b', {}, s.position || ' ')),
        h('div', {}, h('div', { class: 'small muted' }, 'Nama dan alamat majikan / Employer'), h('b', {}, c.name || ''), h('div', {}, c.address || ''),
          h('div', { class: 'small muted', style: 'margin-top:.4rem' }, 'No. telefon majikan / Telephone'), h('b', {}, c.phone || s.phone || '')),
        h('div', {}, h('div', { class: 'small muted' }, 'Tarikh / Date'), h('b', {}, fmtDate(s.date)), h('div', { class: 'ea-sigline' }, 'Tandatangan / Signature'))));
  }
  function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
  function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } }
}
