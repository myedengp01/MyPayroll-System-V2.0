// Employee profile: personal, employment periods, pay (salary history, allowances, statutory switches)
import { h, clear, fmtDate, money, toast, failed, switchToggle, confirmDialog, field, openModal } from '../ui.js';
import { loadRef } from '../data.js';
import { employmentStatus, serviceLength, formatService, todayIso, ageOn, socsoFromNric, salaryAsOf } from '../engines/employee.js';
import { computeNotice } from '../engines/notice.js';
import { statusTag } from './employees.js';
import { editPerson, editPrivate, editEmployment, recordResignation, editAssignment, editSalary, editAllowance, deleteRow } from '../employee-forms.js';
import { loadLeaveYear, balancesFor, loadHolidaySet, LEAVE_LABELS } from '../leave-data.js';
import { openLeaveForm } from './leave.js';

const STAT_FLAGS = [['epf_ee', 'EPF', 'employee'], ['epf_er', 'EPF', 'employer'], ['socso_ee', 'SOCSO', 'employee'], ['socso_er', 'SOCSO', 'employer'],
  ['eis_ee', 'EIS', 'employee'], ['eis_er', 'EIS', 'employer']];

export async function render(el, ctx, params, query) {
  const id = Number(params.id);
  const canHR = ctx.can(['admin', 'hr']);
  const ref = await loadRef(ctx.sb);
  const today = todayIso();
  const st = { tab: query.tab || 'personal', emplId: query.period ? Number(query.period) : null };
  let D = null;

  async function load() {
    const [emp, priv, empls] = await Promise.all([
      ctx.sb.from('eppd_employees').select('*').eq('id', id).maybeSingle(),
      canHR ? ctx.sb.from('eppd_employee_private').select('*').eq('employee_id', id).maybeSingle() : Promise.resolve({ data: null }),
      ctx.sb.from('eppd_employments').select('*').eq('employee_id', id).order('join_date', { ascending: false, nullsFirst: false }).order('id', { ascending: false }),
    ]);
    if (failed(emp.error, 'Load') || failed(empls.error, 'Load')) return false;
    if (!emp.data) return null;
    const emplIds = empls.data.map((e) => e.id);
    const asg = emplIds.length ? await ctx.sb.from('eppd_assignments').select('*').in('employment_id', emplIds).order('is_primary', { ascending: false }).order('id') : { data: [] };
    const asgIds = (asg.data || []).map((a) => a.id);
    let sal = { data: [] }, alw = { data: [] };
    if (canHR && asgIds.length) {
      [sal, alw] = await Promise.all([
        ctx.sb.from('eppd_salary_history').select('*').in('assignment_id', asgIds).order('effective_from', { ascending: false }),
        ctx.sb.from('eppd_allowances').select('*').in('assignment_id', asgIds).order('start_date', { ascending: false, nullsFirst: false }),
      ]);
    }
    D = { emp: emp.data, priv: priv.data, empls: empls.data, asg: asg.data || [], sal: sal.data || [], alw: alw.data || [] };
    if (!st.emplId || !D.empls.some((e) => e.id === st.emplId)) st.emplId = D.empls[0]?.id || null;
    return true;
  }

  const loaded = await load();
  if (loaded === null) {
    el.append(h('div', { class: 'empty-state' }, h('h2', {}, 'Employee not found'), h('a', { class: 'btn', href: '#/employees' }, 'Back to employees')));
    return;
  }
  if (!loaded) return;

  const headEl = h('div', {}); const tabsEl = h('div', { class: 'tabs', role: 'tablist' }); const bodyEl = h('div', {});
  el.append(h('p', { class: 'crumbs' }, h('a', { href: '#/employees' }, 'Employees'), ' / ', D.emp.full_name), headEl,
    h('section', { class: 'panel' }, tabsEl, h('div', { class: 'panel-body' }, bodyEl)));

  const reload = async () => { await load(); draw(); };
  const cur = () => D.empls[0];
  const asgOf = (emplId) => D.asg.filter((a) => a.employment_id === emplId);

  function draw() {
    // ---- header ----
    const e = D.emp; const em = cur(); const status = employmentStatus(em, ref.confMeta, today);
    const mainAsg = em ? asgOf(em.id)[0] : null;
    const end = status.key === 'former' ? (em?.resigned_date || null) : today;
    const missingLastDay = status.key === 'former' && em && !em.resigned_date;
    const facts = [
      ['Paid by', mainAsg ? asgOf(em.id).map((a) => ref.company(a.company_id)?.short_name || ref.company(a.company_id)?.name).join(', ') : '—'],
      ['Department', em?.department_id ? (ref.department(em.department_id)?.code || '') : '—'],
      ['Job title', em?.job_title_id ? ref.jobTitle(em.job_title_id)?.name : '—'],
      ['Joined', em?.join_date ? fmtDate(em.join_date) : '—'],
      ['Service', em?.join_date && end ? formatService(serviceLength(em.join_date, end)) : (missingLastDay ? 'Last working day missing' : '—')],
      ...(status.key === 'former' && em?.resigned_date ? [['Last working day', fmtDate(em.resigned_date)]] : []),
    ];
    if (canHR && D.priv?.dob) facts.push(['Age', `${ageOn(D.priv.dob, today)}`]);
    clear(headEl).append(h('section', { class: 'profile-head' },
      h('div', { class: 'profile-title' },
        h('h1', {}, e.full_name),
        h('div', { class: 'profile-sub' },
          e.chinese_name ? h('span', {}, e.chinese_name) : null,
          h('span', { class: 'id-chip' }, e.emp_id || 'No Employee ID'),
          statusTag(status, em?.confirmation_status),
          missingLastDay ? h('span', { class: 'tag warn', title: 'Add it in the Employment tab (Edit). Payroll leaves this person out until then.' }, 'No last working day') : null,
          D.empls.length > 1 ? h('span', { class: 'tag' }, `${D.empls.length} employment periods`) : null)),
      canHR ? h('div', { class: 'page-actions' },
        !e.emp_id ? h('button', { class: 'btn', type: 'button', onclick: generateId }, 'Generate Employee ID') : null,
        em && status.key === 'current' ? h('button', { class: 'btn', type: 'button', onclick: () => recordResignation(ctx, ref, em, reload) }, 'Record resignation') : null) : null,
      h('dl', { class: 'facts-row' }, facts.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v || '—'))))));

    // ---- tabs ----
    const tabs = [['personal', 'Personal'], ['employment', 'Employment'], ...(canHR ? [['pay', 'Pay'], ['leave', 'Leave']] : [])];
    if (!tabs.some(([k]) => k === st.tab)) st.tab = 'personal';
    clear(tabsEl).append(...tabs.map(([k, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(st.tab === k),
      onclick: () => { st.tab = k; history.replaceState(null, '', `#/employees/${id}?tab=${k}`); draw(); } }, l)));
    clear(bodyEl).append(st.tab === 'personal' ? personalTab() : st.tab === 'employment' ? employmentTab() : st.tab === 'leave' ? leaveTab() : payTab());
  }

  // ---------------------------------------------------------------- personal
  function kv(rows) {
    return h('dl', { class: 'kv' }, rows.filter(Boolean).map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v === null || v === undefined || v === '' ? '—' : v))));
  }
  function personalTab() {
    const e = D.emp;
    const blocks = [h('div', { class: 'block' },
      h('div', { class: 'block-head' }, h('h2', {}, 'Personal details'),
        canHR ? h('button', { class: 'btn sm', type: 'button', onclick: () => editPerson(ctx, ref, e, reload) }, 'Edit') : null),
      kv([['Full name', e.full_name], ['Chinese name', e.chinese_name], ['Gender', ref.label('gender', e.gender)],
        ['Nationality', ref.label('nationality', e.nationality)], ['Race', ref.label('race', e.race)],
        ['Marital status', ref.label('marital_status', e.marital_status)], ['Contact no.', e.phone], ['Email', e.email],
        ['Remarks', e.remarks]]))];
    if (canHR) {
      const p = D.priv || {};
      const socso = p.socso_no || socsoFromNric(p.nric);
      blocks.push(h('div', { class: 'block' },
        h('div', { class: 'block-head' }, h('div', {}, h('h2', {}, 'Identity & bank'), h('p', { class: 'small muted' }, 'Visible to admins and HR only.')),
          h('button', { class: 'btn sm', type: 'button', onclick: () => editPrivate(ctx, ref, e, D.priv, reload) }, 'Edit')),
        kv([['NRIC', p.nric], ['Passport no.', p.passport_no], ['Date of birth', p.dob ? `${fmtDate(p.dob)} (age ${ageOn(p.dob, today)})` : null],
          ['Home address', p.home_address], ['Spouse', p.spouse_name],
          ['Bank', [ref.label('bank', p.bank_code), p.bank_account_no].filter(Boolean).join(' · ')],
          ['EPF no.', p.epf_no], ['SOCSO no.', socso ? `${socso}${p.socso_no ? '' : ' (from NRIC)'}` : null], ['Income tax no.', p.tax_no],
          ['Emergency contact', [p.emergency_name, p.emergency_relation, p.emergency_phone].filter(Boolean).join(' · ')]])));
    }
    return h('div', { class: 'grid-2 blocks' }, blocks);
  }

  // ---------------------------------------------------------------- employment
  function employmentTab() {
    const wrap = h('div', { class: 'stack' });
    if (canHR) wrap.append(h('div', { class: 'side-actions' },
      h('button', { class: 'btn sm', type: 'button', onclick: () => editEmployment(ctx, ref, id, null, reload, { companyForNew: asgOf(cur()?.id)[0]?.company_id }) }, 'Add employment period (rehire)')));
    if (!D.empls.length) wrap.append(h('div', { class: 'empty-state' }, 'No employment record yet.'));
    D.empls.forEach((em, i) => {
      const status = employmentStatus(em, ref.confMeta, today);
      let notice = null;
      if (em.resignation_letter_date && ref.policies.notice_period) {
        const r = computeNotice({ joinDate: em.join_date, letterDate: em.resignation_letter_date, onProbation: em.confirmation_status === 'UP' }, ref.policies.notice_period);
        if (r) notice = `${r.weeks} weeks (${r.days} days) from ${fmtDate(em.resignation_letter_date)} → ${fmtDate(r.noticeEnd)}`;
      }
      const hours = em.work_from && em.work_to ? `${String(em.work_from).slice(0, 5)} – ${String(em.work_to).slice(0, 5)}, ${em.meal_hours ?? 1} h meal` : null;
      wrap.append(h('div', { class: 'block' },
        h('div', { class: 'block-head' },
          h('div', {}, h('h2', {}, i === 0 ? 'Current / latest period' : `Earlier period`),
            h('p', { class: 'small muted' }, `${fmtDate(em.join_date) || 'No join date'} – ${em.resigned_date ? fmtDate(em.resigned_date) : 'present'}`)),
          h('div', { class: 'side-actions' }, statusTag(status, em.confirmation_status),
            canHR ? h('button', { class: 'btn sm', type: 'button', onclick: () => editEmployment(ctx, ref, id, em, reload) }, 'Edit') : null,
            canHR && status.key !== 'former' ? h('button', { class: 'btn sm', type: 'button', onclick: () => recordResignation(ctx, ref, em, reload) }, em.resignation_letter_date ? 'Edit resignation' : 'Record resignation') : null)),
        kv([['Employment status', ref.label('confirmation_status', em.confirmation_status)], ['Confirmed on', fmtDate(em.confirmed_date)],
          ['Job status', ref.label('job_status', em.job_status)],
          ['Department', em.department_id ? `${ref.department(em.department_id)?.code} · ${ref.department(em.department_id)?.name}` : null],
          ['Job title', ref.jobTitle(em.job_title_id)?.name], ['Paid by', asgOf(em.id).map((a) => ref.company(a.company_id)?.name).join(', ')],
          ['Working hours', hours], em.job_status === 'PT' ? ['Weekly hours', em.weekly_hours ? `${em.weekly_hours} h (leave pro-rated)` : 'Not recorded: leave shown at full-time rates'] : null, ['OT basis', `÷ ${em.ot_days ?? 26} days · normal-day OT × ${em.ot_multiplier ?? 1.5}`],
          ['Resignation letter', fmtDate(em.resignation_letter_date)], ['Notice period', notice], ['Last working day', fmtDate(em.resigned_date)],
          ['Notes', em.notes]])));
    });
    return wrap;
  }

  // ---------------------------------------------------------------- leave (HR only)
  function leaveTab() {
    const wrap = h('div', { class: 'stack' }, h('div', { class: 'loading' }, 'Loading leave…'));
    const year = Number(today.slice(0, 4));
    (async () => {
      const L = await loadLeaveYear(ctx.sb, year);
      const holidays = await loadHolidaySet(ctx.sb, [year - 1, year, year + 1]);
      const ww = L.ref.policies.working_week || { rest_days: [0], off_days: [6] };
      const me = L.people.find((p) => p.id === id);
      if (!me) { clear(wrap).append(h('p', { class: 'muted' }, 'No employment record.')); return; }
      const b = balancesFor(me, L);
      const mine = L.records.filter((r) => r.employee_id === id);
      const refresh = () => { draw(); };
      const tile = (label, main, sub) => h('div', { class: 'fact' }, h('b', {}, main), h('span', {}, label, sub ? h('div', { class: 'small muted' }, sub) : null));
      clear(wrap).append(
        h('div', { class: 'block-head' }, h('div', {}, h('h2', {}, `Leave ${year}`), h('p', { class: 'small muted' }, 'Balances as at today.')),
          h('div', { class: 'side-actions' }, h('a', { class: 'btn sm', href: `#/leave/al-calculator?emp=${id}&year=${year}` }, 'AL breakdown'),
            h('button', { class: 'btn sm primary', type: 'button', onclick: () => openLeaveForm(ctx, L, holidays, ww, null, { employeeId: id, onSaved: refresh }) }, 'Record leave'))),
        b.AL.needsHours ? h('p', { class: 'setup-warning' }, 'Part-timer without weekly hours: full-time entitlements shown. Add weekly hours in the Employment tab.') : null,
        h('div', { class: 'facts' },
          tile('Annual leave left', b.AL.balance, `${b.AL.entitled} entitled${b.AL.carried ? ` + ${b.AL.carried} carried` : ''} − ${b.AL.taken} taken${b.AL.buyback ? ` − ${b.AL.buyback} bought back` : ''}`),
          tile('Sick leave left', b.SL.balance, `${b.SL.entitled} entitled − ${b.SL.taken} taken`),
          tile('Hospitalisation pool', b.HPL.balance, 'shared with sick leave (60 days)'),
          tile('Compassionate left', b.CPL.balance, `${b.CPL.perEvent} per occasion, ${b.CPL.entitled} a year`),
          tile('Replacement leave', b.RL.balance, `${b.RL.earned} earned − ${b.RL.taken} taken`),
          b.UPL.taken ? tile('Unpaid leave taken', b.UPL.taken) : null),
        mine.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Type'), h('th', {}, 'Dates'), h('th', { class: 'num' }, 'Days'), h('th', {}, 'Note'), h('th', {}))),
          h('tbody', {}, mine.map((r) => h('tr', { class: r.status === 'cancelled' ? 'inactive' : '' },
            h('td', {}, LEAVE_LABELS[r.leave_type] || r.leave_type), h('td', { class: 'nowrap' }, r.source === 'import' ? `${r.date_from.slice(0, 7)} (workbook total)` : (r.date_from === r.date_to ? fmtDate(r.date_from) : `${fmtDate(r.date_from)} – ${fmtDate(r.date_to)}`)),
            h('td', { class: 'num' }, Number(r.days)), h('td', { class: 'small muted' }, r.note || ''),
            h('td', { class: 'actions' }, h('button', { class: 'btn sm', type: 'button', onclick: () => openLeaveForm(ctx, L, holidays, ww, r, { onSaved: refresh }) }, 'Edit')))))))
          : h('p', { class: 'muted small' }, `No leave recorded in ${year}.`));
    })().catch((e) => { clear(wrap).append(h('p', { class: 'muted' }, String(e.message || e))); });
    return wrap;
  }

  // ---------------------------------------------------------------- pay (HR only)
  function payTab() {
    const wrap = h('div', { class: 'stack' });
    if (!D.empls.length) { wrap.append(h('div', { class: 'empty-state' }, 'Add an employment period first.')); return wrap; }
    const em = D.empls.find((x) => x.id === st.emplId) || D.empls[0];
    if (D.empls.length > 1) {
      const sel = h('select', { 'aria-label': 'Employment period', style: 'width:auto' }, D.empls.map((x) => h('option', { value: x.id, selected: x.id === em.id },
        `${fmtDate(x.join_date) || 'No join date'} – ${x.resigned_date ? fmtDate(x.resigned_date) : 'present'}`)));
      sel.addEventListener('change', () => { st.emplId = Number(sel.value); draw(); });
      wrap.append(h('label', { class: 'check-row' }, 'Employment period', sel));
    }
    for (const a of asgOf(em.id)) wrap.append(assignmentBlock(a, em));
    wrap.append(h('div', { class: 'side-actions' },
      h('button', { class: 'btn sm', type: 'button', onclick: () => editAssignment(ctx, ref, em.id, null, reload, { joinDate: em.join_date }) }, 'Add another paying company')));
    wrap.append(taxBlock(), payHistoryBlock());
    return wrap;
  }

  // tax details used by automatic PCB (Phase 6)
  function taxBlock() {
    const box = h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('h3', {}, 'Tax details (PCB)')), h('p', { class: 'small muted' }, 'Loading…'));
    (async () => {
      const { data, error } = await ctx.sb.from('eppd_tax_profiles').select('*').eq('employee_id', id).maybeSingle();
      if (error) { clear(box).append(h('div', { class: 'block-head' }, h('h3', {}, 'Tax details (PCB)')), h('p', { class: 'small muted' }, 'Not set up yet (run sql/008_phase6.sql).')); return; }
      const t = data || { pcb_manual: false, resident: true, category: 1, children: 0, child_relief_extra: 0, disabled: false, spouse_disabled: false, tp1_monthly: 0, zakat_monthly: 0, prev_gross: 0, prev_epf: 0, prev_pcb: 0, prev_zakat: 0 };
      const CAT = { 1: 'Single (or spouse claims own relief)', 2: 'Married, spouse not working', 3: 'Married, spouse working' };
      const on = !!ctx.modules?.pcb_auto;
      const kv = [['PCB', t.pcb_manual ? 'Typed by hand each month' : (on ? 'Automatic' : 'Automatic PCB is switched off (Settings › HR policies)')],
        ['Residency', t.resident === false ? 'Non-resident (flat rate)' : 'Resident'], ['Category', `${t.category} · ${CAT[t.category]}`],
        ['Children (basic relief)', String(t.children || 0)], ['Extra child relief a year', t.child_relief_extra ? `RM${money(t.child_relief_extra)}` : '—'],
        ['Disabled', [t.disabled ? 'employee' : null, t.spouse_disabled ? 'spouse' : null].filter(Boolean).join(', ') || '—'],
        ['TP1 claims a month', t.tp1_monthly ? `RM${money(t.tp1_monthly)}` : '—'], ['Zakat through payroll a month', t.zakat_monthly ? `RM${money(t.zakat_monthly)}` : '—'],
        ['Previous employment (TP3)', t.prev_year ? `${t.prev_year}: pay RM${money(t.prev_gross)}, EPF RM${money(t.prev_epf)}, PCB RM${money(t.prev_pcb)}` : '—']];
      clear(box).append(h('div', { class: 'block-head' }, h('h3', {}, 'Tax details (PCB)'), canHR ? h('button', { class: 'btn sm', type: 'button', onclick: () => editTax(t, !data) }, 'Edit') : null),
        h('dl', { class: 'kv-grid' }, kv.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))));
    })();
    return box;
  }
  function editTax(t, isNew) {
    const F = {
      pcb_manual: field('Type PCB by hand for this person (no automatic PCB)', { type: 'switch', value: t.pcb_manual, span2: true }),
      resident: field('Tax resident in Malaysia', { type: 'switch', value: t.resident !== false, span2: true }),
      category: field('Category', { type: 'select', value: t.category, options: [[1, '1 · Single (or spouse claims own relief)'], [2, '2 · Married, spouse not working'], [3, '3 · Married, spouse working']] }),
      children: field('Children claimed (basic child relief)', { type: 'number', value: t.children, min: 0, step: '1' }),
      child_relief_extra: field('Extra child relief a year (RM)', { type: 'number', value: t.child_relief_extra, step: '0.01', hint: 'Higher education or disabled children: the relief above the basic amount.' }),
      disabled: field('Employee is disabled', { type: 'switch', value: t.disabled }),
      spouse_disabled: field('Spouse is disabled', { type: 'switch', value: t.spouse_disabled }),
      tp1_monthly: field('Other reliefs claimed via TP1, per month (RM)', { type: 'number', value: t.tp1_monthly, step: '0.01' }),
      zakat_monthly: field('Zakat through payroll, per month (RM)', { type: 'number', value: t.zakat_monthly, step: '0.01', hint: 'Deducted from pay and from PCB.' }),
      prev_year: field('Previous employment this year (TP3): year', { type: 'number', value: t.prev_year, step: '1', hint: 'Leave blank if none.' }),
      prev_gross: field('TP3: pay received (RM)', { type: 'number', value: t.prev_gross, step: '0.01' }),
      prev_epf: field('TP3: EPF (RM)', { type: 'number', value: t.prev_epf, step: '0.01' }),
      prev_pcb: field('TP3: PCB (RM)', { type: 'number', value: t.prev_pcb, step: '0.01' }),
      prev_zakat: field('TP3: zakat (RM)', { type: 'number', value: t.prev_zakat, step: '0.01' }),
      note: field('Note', { type: 'textarea', value: t.note, span2: true }),
    };
    openModal({ title: 'Tax details (PCB)', wide: true, body: h('div', { class: 'form-grid' }, Object.values(F)),
      actions: [{ label: 'Save', primary: true, onClick: async (close) => {
        const v = Object.fromEntries(Object.entries(F).map(([k, f]) => [k, f.getValue()]));
        for (const k of ['children', 'child_relief_extra', 'tp1_monthly', 'zakat_monthly', 'prev_gross', 'prev_epf', 'prev_pcb', 'prev_zakat']) v[k] = Number(v[k]) || 0;
        v.category = Number(v.category) || 1; v.prev_year = v.prev_year ? Number(v.prev_year) : null;
        const { error } = await ctx.sb.from('eppd_tax_profiles').upsert({ employee_id: id, ...v });
        if (failed(error)) return false;
        toast('Tax details saved. Recalculate open payroll months to use them.'); close(); draw(); return true;
      } }] });
  }

  // pay lines from the monthly payroll (finalised and draft months)
  function payHistoryBlock() {
    const box = h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('h3', {}, 'Payroll history')), h('p', { class: 'small muted' }, 'Loading…'));
    (async () => {
      const { data, error } = await ctx.sb.from('eppd_pay_lines').select('id,run_id,company_id,gross,epf_ee,socso_ee,eis_ee,pcb,net_paid,excluded,eppd_pay_runs(period,status)')
        .eq('employee_id', id).order('id', { ascending: false }).limit(60);
      const body = error ? h('p', { class: 'small muted' }, 'Payroll is not set up yet (run sql/006_payroll.sql).')
        : !data.length ? h('p', { class: 'small muted' }, 'Not in any payroll month yet.')
        : h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, ['Month', 'Company', 'Gross', 'EPF', 'SOCSO', 'EIS', 'PCB', 'Net paid', ''].map((t, i) => h('th', { class: i >= 2 && i <= 7 ? 'num' : '' }, t)))),
          h('tbody', {}, data.filter((l) => l.eppd_pay_runs).sort((a, b) => b.eppd_pay_runs.period.localeCompare(a.eppd_pay_runs.period)).map((l) => h('tr', { class: l.excluded ? 'inactive' : '' },
            h('td', {}, h('a', { href: `#/payroll/${l.eppd_pay_runs.period.slice(0, 7)}` }, new Date(l.eppd_pay_runs.period + 'T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }))),
            h('td', { class: 'small' }, ref.company(l.company_id)?.short_name || ''),
            ...['gross', 'epf_ee', 'socso_ee', 'eis_ee', 'pcb'].map((k) => h('td', { class: 'num' }, money(l[k]))), h('td', { class: 'num strong' }, money(l.net_paid)),
            h('td', {}, l.excluded ? h('span', { class: 'tag' }, 'Left out') : l.eppd_pay_runs.status === 'draft' ? h('span', { class: 'tag warn' }, 'Draft') : null))))));
      clear(box).append(h('div', { class: 'block-head' }, h('h3', {}, 'Payroll history')), body);
    })();
    return box;
  }

  function assignmentBlock(a, em) {
    const c = ref.company(a.company_id);
    const sal = D.sal.filter((s) => s.assignment_id === a.id);
    const alw = D.alw.filter((x) => x.assignment_id === a.id);
    const inForce = salaryAsOf(sal, today);
    const toggles = h('div', { class: 'stat-toggles' }, STAT_FLAGS.map(([k, scheme, who]) => h('label', { class: 'check-row' },
      switchToggle(a[k], (v, input) => saveFlag(a, k, v, input), { label: `${scheme} ${who}` }), `${scheme} (${who})`)),
      h('label', { class: 'check-row' }, switchToggle(a.socso_nei_opt_out, (v, input) => saveFlag(a, 'socso_nei_opt_out', v, input), { label: 'SOCSO NEI opt-out' }),
        'SOCSO NEI opt-out (pays invalidity only)'));
    const salTable = sal.length ? h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Effective from'), h('th', { class: 'num' }, 'Basic (RM)'), h('th', {}, 'Paid'), h('th', {}, 'Reason'), h('th', {}))),
      h('tbody', {}, sal.map((s) => h('tr', { class: s === inForce ? 'hit' : '' },
        h('td', {}, fmtDate(s.effective_from), s === inForce ? h('span', { class: 'tag ok', style: 'margin-left:.5rem' }, 'In force') : null,
          s.effective_from > today ? h('span', { class: 'tag info', style: 'margin-left:.5rem' }, 'Upcoming') : null),
        h('td', { class: 'num' }, money(s.amount)), h('td', {}, s.pay_basis === 'hourly' ? 'Per hour' : 'Monthly'),
        h('td', { class: 'small' }, s.reason || '', s.note ? h('div', { class: 'muted' }, s.note) : null),
        h('td', { class: 'actions' }, h('button', { class: 'btn sm', type: 'button', onclick: () => editSalary(ctx, a.id, s, reload) }, 'Edit'),
          h('button', { class: 'btn sm ghost', type: 'button', onclick: () => deleteRow(ctx, 'eppd_salary_history', s.id, 'salary record', reload) }, 'Delete'))))))
      : h('p', { class: 'muted small' }, 'No salary recorded yet.');
    const alwTable = alw.length ? h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Allowance'), h('th', { class: 'num' }, 'Per month (RM)'), h('th', {}, 'From'), h('th', {}, 'Until'), h('th', {}, ''), h('th', {}))),
      h('tbody', {}, alw.map((x) => {
        const live = (!x.start_date || x.start_date <= today) && (!x.end_date || x.end_date >= today);
        return h('tr', { class: live ? '' : 'inactive' },
          h('td', {}, ref.paymentTypes.find((t) => t.id === x.payment_type_id)?.name || '?'),
          h('td', { class: 'num' }, money(x.amount)), h('td', {}, fmtDate(x.start_date) || '—'), h('td', {}, fmtDate(x.end_date) || 'Ongoing'),
          h('td', {}, live ? h('span', { class: 'tag ok' }, 'Paying') : h('span', { class: 'tag' }, x.start_date > today ? 'Starts later' : 'Ended')),
          h('td', { class: 'actions' }, h('button', { class: 'btn sm', type: 'button', onclick: () => editAllowance(ctx, ref, a.id, x, reload) }, 'Edit'),
            h('button', { class: 'btn sm ghost', type: 'button', onclick: () => deleteRow(ctx, 'eppd_allowances', x.id, 'allowance', reload) }, 'Delete')));
      })))
      : h('p', { class: 'muted small' }, 'No recurring allowances.');

    return h('div', { class: 'block' },
      h('div', { class: 'block-head' },
        h('div', {}, h('h2', {}, c?.name || 'Company'),
          h('p', { class: 'small muted' }, `${a.is_primary ? 'Main company · ' : ''}${fmtDate(a.start_date) || '—'} – ${a.end_date ? fmtDate(a.end_date) : 'ongoing'}`)),
        h('div', { class: 'side-actions' },
          inForce ? h('span', { class: 'big-num' }, `RM ${money(inForce.amount)}${inForce.pay_basis === 'hourly' ? ' / hr' : ''}`) : null,
          h('button', { class: 'btn sm', type: 'button', onclick: () => editAssignment(ctx, ref, em.id, a, reload) }, 'Edit'),
          asgOf(em.id).length > 1 ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => removeAssignment(a) }, 'Remove') : null)),
      h('h3', { class: 'sub' }, 'Statutory contributions'), toggles,
      h('div', { class: 'sub-head' }, h('h3', { class: 'sub' }, 'Salary history'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => editSalary(ctx, a.id, null, reload) }, 'Add salary change')),
      h('div', { class: 'table-wrap' }, salTable),
      h('div', { class: 'sub-head' }, h('h3', { class: 'sub' }, 'Recurring allowances'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => editAllowance(ctx, ref, a.id, null, reload, { joinDate: em.join_date }) }, 'Add allowance')),
      h('div', { class: 'table-wrap' }, alwTable));
  }

  async function saveFlag(a, k, v, input) {
    const { error } = await ctx.sb.from('eppd_assignments').update({ [k]: v }).eq('id', a.id);
    if (failed(error)) { input.checked = !v; return; }
    a[k] = v; toast('Saved.');
  }
  async function removeAssignment(a) {
    if (!(await confirmDialog('Remove company', `Stop recording ${ref.company(a.company_id)?.name} as paying this person? Its salary history and allowances are deleted too.`, 'Remove', true))) return;
    const { error } = await ctx.sb.from('eppd_assignments').delete().eq('id', a.id);
    if (!failed(error, 'Remove')) { toast('Company removed.'); reload(); }
  }
  async function generateId() {
    const { data, error } = await ctx.sb.rpc('eppd_generate_emp_id', { p_employee_id: id });
    if (failed(error, 'Generate ID')) return;
    toast(`Employee ID ${data} assigned.`); reload();
  }

  draw();
}
