// MyPayroll-System-V2.0 · employee-forms.js — add / edit dialogs used by the Employees pages
import { h, clear, openModal, field, toast, failed, confirmDialog } from './ui.js';
import { formatEmpId, isEmpIdFormat } from './engines/eid.js';
import { normaliseNric, dobFromNric, todayIso } from './engines/employee.js';
import { computeNotice } from './engines/notice.js';

const blank = (label = '—') => [['', label]];
const lookupOpts = (ref, cat, cur) => [...blank(), ...ref.options(cat, cur)];
const deptOpts = (ref, cur) => [...blank(), ...ref.departments.filter((d) => d.is_active || d.id === cur)
  .map((d) => [d.id, d.code === d.name ? d.code : `${d.code} · ${d.name}`])];
const titleOpts = (ref, cur) => [...blank(), ...ref.jobTitles.filter((t) => t.is_active || t.id === cur).map((t) => [t.id, t.name])];
const companyOpts = (ref, cur) => ref.companies.filter((c) => c.is_active || c.id === cur).map((c) => [c.id, c.name]);
const time5 = (t) => (t ? String(t).slice(0, 5) : '');
const values = (F) => Object.fromEntries(Object.entries(F).map(([k, f]) => [k, f.getValue()]));
const section = (title, ...kids) => h('fieldset', { class: 'form-section' }, h('legend', {}, title), h('div', { class: 'form-grid' }, kids));

// ---------------------------------------------------------------- add employee
export async function openAddEmployee(ctx, ref, onDone) {
  const { data: nextSerial, error } = await ctx.sb.rpc('eppd_next_emp_serial');
  if (failed(error, 'Load')) return;
  const defaultCompany = ref.companies.find((c) => c.is_primary && c.is_active) || ref.companies[0];
  const F = {
    full_name: field('Full name (as on NRIC)', { required: true, span2: true }),
    chinese_name: field('Chinese name'),
    gender: field('Gender', { type: 'select', options: lookupOpts(ref, 'gender'), required: true }),
    nric: field('NRIC', { placeholder: '000000-00-0000', hint: 'Date of birth fills in automatically.' }),
    dob: field('Date of birth', { type: 'date' }),
    nationality: field('Nationality', { type: 'select', options: lookupOpts(ref, 'nationality'), value: 'MALAYSIAN' }),
    phone: field('Contact no.', { placeholder: '+6012-3456789' }),
    company_id: field('Paid by', { type: 'select', options: companyOpts(ref), value: defaultCompany?.id, required: true }),
    join_date: field('Date joined', { type: 'date', required: true, value: todayIso() }),
    department_id: field('Department', { type: 'select', options: deptOpts(ref) }),
    job_title_id: field('Job title', { type: 'select', options: titleOpts(ref) }),
    job_status: field('Job status', { type: 'select', options: lookupOpts(ref, 'job_status'), value: 'FT' }),
    confirmation_status: field('Employment status', { type: 'select', options: lookupOpts(ref, 'confirmation_status'), value: 'UP' }),
    amount: field('Starting basic salary (RM)', { type: 'number', step: '0.01' }),
    pay_basis: field('Paid', { type: 'select', options: [['monthly', 'Monthly'], ['hourly', 'Per hour']], value: 'monthly' }),
  };
  F.nric.input.addEventListener('change', () => {
    const n = normaliseNric(F.nric.input.value);
    if (n) { F.nric.input.value = n; if (!F.dob.input.value) F.dob.input.value = dobFromNric(n) || ''; }
  });
  // Employee ID: generated (preview) or an existing one typed in
  const auto = h('input', { type: 'radio', name: 'idmode', value: 'auto', checked: true });
  const manual = h('input', { type: 'radio', name: 'idmode', value: 'manual' });
  const manualIn = h('input', { type: 'text', placeholder: 'e.g. MEG0325F0118', disabled: true, 'aria-label': 'Existing Employee ID' });
  const preview = h('strong', { class: 'id-preview' });
  const drawPreview = () => {
    const c = ref.company(Number(F.company_id.getValue()));
    const id = formatEmpId({ prefix: c?.eid_prefix, joinDate: F.join_date.getValue(), gender: F.gender.getValue(), serial: nextSerial });
    preview.textContent = id || 'Choose gender and join date';
  };
  [F.company_id, F.join_date, F.gender].forEach((f) => f.input.addEventListener('change', drawPreview));
  [auto, manual].forEach((r) => r.addEventListener('change', () => { manualIn.disabled = !manual.checked; if (manual.checked) manualIn.focus(); }));
  drawPreview();
  const idBox = h('div', { class: 'id-box span-2' },
    h('label', { class: 'check-row' }, auto, 'Generate the next Employee ID: ', preview),
    h('label', { class: 'check-row' }, manual, 'Use an existing ID', manualIn),
    h('p', { class: 'small muted' }, `Next running number: ${nextSerial}. The final number is assigned when you save, so two people added at once never get the same ID.`));

  openModal({
    title: 'Add employee', wide: true,
    body: h('div', {},
      section('Person', F.full_name, F.chinese_name, F.gender, F.nric, F.dob, F.nationality, F.phone),
      section('Job', F.company_id, F.join_date, F.department_id, F.job_title_id, F.job_status, F.confirmation_status),
      section('Pay', F.amount, F.pay_basis),
      section('Employee ID', idBox)),
    actions: [{ label: 'Add employee', primary: true, onClick: async (close) => {
      const v = values(F);
      if (!v.full_name || !v.gender || !v.join_date || !v.company_id) { toast('Name, gender, date joined and company are required.', 'error'); return false; }
      if (manual.checked && !isEmpIdFormat(manualIn.value)) { toast('That Employee ID is not in the usual format (e.g. MEG0325F0118).', 'error'); return false; }
      // duplicate checks
      const { data: same } = await ctx.sb.from('eppd_employees').select('id,emp_id').ilike('full_name', v.full_name.trim());
      const nric = normaliseNric(v.nric) || v.nric;
      const { data: sameNric } = nric ? await ctx.sb.from('eppd_employee_private').select('employee_id').eq('nric', nric) : { data: [] };
      if ((same || []).length || (sameNric || []).length) {
        const ok = await confirmDialog('Possible duplicate', `${(sameNric || []).length ? 'This NRIC' : 'This name'} already exists${same?.[0]?.emp_id ? ` (${same[0].emp_id})` : ''}. For a rehire, open their record and add a new employment period instead. Add a new person anyway?`, 'Add anyway');
        if (!ok) return false;
      }
      const payload = {
        full_name: v.full_name, chinese_name: v.chinese_name, gender: v.gender, nationality: v.nationality, phone: v.phone,
        emp_id: manual.checked ? manualIn.value.trim().toUpperCase() : null, auto_id: auto.checked,
        private: { nric, dob: v.dob },
        employment: { join_date: v.join_date, confirmation_status: v.confirmation_status, job_status: v.job_status, department_id: v.department_id, job_title_id: v.job_title_id },
        company_id: v.company_id,
        salary: v.amount !== null ? { amount: v.amount, pay_basis: v.pay_basis, effective_from: v.join_date } : null,
      };
      const { data, error: e } = await ctx.sb.rpc('eppd_create_employee', { p: payload });
      if (failed(e)) return false;
      toast(`${v.full_name.toUpperCase()} added${data.emp_id ? ` as ${data.emp_id}` : ''}.`);
      close(); onDone?.(data.id);
      return true;
    } }],
  });
}

// ---------------------------------------------------------------- person (everyone can see; HR edits)
export function editPerson(ctx, ref, emp, onDone) {
  const F = {
    full_name: field('Full name (as on NRIC)', { value: emp.full_name, required: true, span2: true }),
    chinese_name: field('Chinese name', { value: emp.chinese_name }),
    gender: field('Gender', { type: 'select', options: lookupOpts(ref, 'gender', emp.gender), value: emp.gender }),
    nationality: field('Nationality', { type: 'select', options: lookupOpts(ref, 'nationality', emp.nationality), value: emp.nationality }),
    race: field('Race', { type: 'select', options: lookupOpts(ref, 'race', emp.race), value: emp.race }),
    marital_status: field('Marital status', { type: 'select', options: lookupOpts(ref, 'marital_status', emp.marital_status), value: emp.marital_status }),
    phone: field('Contact no.', { value: emp.phone }),
    email: field('Email', { type: 'email', value: emp.email }),
    remarks: field('Remarks', { type: 'textarea', value: emp.remarks, span2: true }),
  };
  openModal({ title: 'Edit personal details', wide: true, body: h('div', { class: 'form-grid' }, Object.values(F)),
    actions: [{ label: 'Save changes', primary: true, onClick: async (close) => {
      const v = values(F); if (!v.full_name) { toast('Name is required.', 'error'); return false; }
      v.full_name = v.full_name.toUpperCase();
      const { error } = await ctx.sb.from('eppd_employees').update(v).eq('id', emp.id);
      if (failed(error)) return false;
      toast('Personal details saved.'); close(); onDone?.(); return true;
    } }] });
}

// ---------------------------------------------------------------- identity, bank, statutory numbers (HR only)
export function editPrivate(ctx, ref, emp, priv, onDone) {
  const p = priv || {};
  const F = {
    nric: field('NRIC', { value: p.nric, placeholder: '000000-00-0000' }),
    passport_no: field('Passport no. (non-Malaysians)', { value: p.passport_no }),
    dob: field('Date of birth', { type: 'date', value: p.dob }),
    spouse_name: field('Spouse name', { value: p.spouse_name }),
    home_address: field('Home address', { type: 'textarea', value: p.home_address, span2: true }),
    bank_code: field('Bank', { type: 'select', options: lookupOpts(ref, 'bank', p.bank_code), value: p.bank_code }),
    bank_account_no: field('Account no.', { value: p.bank_account_no, hint: 'Digits only.' }),
    epf_no: field('EPF no.', { value: p.epf_no }),
    socso_no: field('SOCSO no.', { value: p.socso_no, hint: 'Leave blank to use the NRIC digits (usual).' }),
    tax_no: field('Income tax no.', { value: p.tax_no }),
    emergency_name: field('Emergency contact', { value: p.emergency_name }),
    emergency_relation: field('Relationship', { value: p.emergency_relation }),
    emergency_phone: field('Emergency phone', { value: p.emergency_phone }),
  };
  F.nric.input.addEventListener('change', () => {
    const n = normaliseNric(F.nric.input.value);
    if (n) { F.nric.input.value = n; if (!F.dob.input.value) F.dob.input.value = dobFromNric(n) || ''; }
  });
  openModal({ title: 'Edit identity & bank details', wide: true, body: h('div', { class: 'form-grid' }, Object.values(F)),
    actions: [{ label: 'Save changes', primary: true, onClick: async (close) => {
      const v = values(F);
      if (v.bank_account_no) v.bank_account_no = v.bank_account_no.replace(/[\s-]/g, '');
      const { error } = await ctx.sb.from('eppd_employee_private').upsert({ employee_id: emp.id, ...v });
      if (failed(error)) return false;
      toast('Identity & bank details saved.'); close(); onDone?.(); return true;
    } }] });
}

// ---------------------------------------------------------------- employment period
export function editEmployment(ctx, ref, employeeId, em, onDone, { companyForNew } = {}) {
  const e = em || {};
  const F = {
    join_date: field('Date joined', { type: 'date', value: e.join_date, required: true }),
    confirmation_status: field('Employment status', { type: 'select', options: lookupOpts(ref, 'confirmation_status', e.confirmation_status), value: e.confirmation_status || 'UP' }),
    confirmed_date: field('Confirmed on', { type: 'date', value: e.confirmed_date, hint: 'Blank while on probation.' }),
    job_status: field('Job status', { type: 'select', options: lookupOpts(ref, 'job_status', e.job_status), value: e.job_status }),
    department_id: field('Department', { type: 'select', options: deptOpts(ref, e.department_id), value: e.department_id }),
    job_title_id: field('Job title', { type: 'select', options: titleOpts(ref, e.job_title_id), value: e.job_title_id }),
    work_from: field('Working hours from', { type: 'time', value: time5(e.work_from) }),
    work_to: field('Working hours to', { type: 'time', value: time5(e.work_to) }),
    meal_hours: field('Meal break (hours)', { type: 'number', step: '0.25', value: e.meal_hours ?? ref.policies.ot_defaults?.meal_break_hours ?? 1 }),
    ot_days: field('Working days per month (OT)', { type: 'number', step: '0.5', value: e.ot_days ?? ref.policies.ot_defaults?.working_days_per_month ?? 26 }),
    weekly_hours: field('Weekly hours (part-timers)', { type: 'number', step: '0.5', value: e.weekly_hours, hint: 'Used to pro-rate annual and sick leave for part-time staff.' }),
    ot_multiplier: field('Normal-day OT rate (×)', { type: 'number', step: '0.1', value: e.ot_multiplier ?? ref.policies.ot_defaults?.normal_ot_multiplier ?? 1.5 }),
    notes: field('Notes', { type: 'textarea', value: e.notes, span2: true }),
  };
  const companyF = !em ? field('Paid by', { type: 'select', options: companyOpts(ref), value: companyForNew }) : null;
  openModal({ title: em ? 'Edit employment period' : 'Add employment period (rehire)', wide: true,
    body: h('div', { class: 'form-grid' }, companyF, Object.values(F)),
    actions: [{ label: em ? 'Save changes' : 'Add period', primary: true, onClick: async (close) => {
      const v = values(F); if (!v.join_date) { toast('Date joined is required.', 'error'); return false; }
      if (em) {
        const { error } = await ctx.sb.from('eppd_employments').update(v).eq('id', em.id);
        if (failed(error)) return false;
      } else {
        const { data, error } = await ctx.sb.from('eppd_employments').insert({ ...v, employee_id: employeeId }).select('id').single();
        if (failed(error)) return false;
        const { error: e2 } = await ctx.sb.from('eppd_assignments').insert({ employment_id: data.id, company_id: Number(companyF.getValue()), is_primary: true, start_date: v.join_date });
        if (failed(e2)) return false;
      }
      toast(em ? 'Employment saved.' : 'Employment period added.'); close(); onDone?.(); return true;
    } }] });
}

// ---------------------------------------------------------------- resignation (with notice period from policy)
export function recordResignation(ctx, ref, em, onDone) {
  const policy = ref.policies.notice_period;
  const F = {
    letter: field('Resignation letter date', { type: 'date', value: em.resignation_letter_date || todayIso(), required: true }),
    last: field('Last working day', { type: 'date', value: em.resigned_date, hint: 'Defaults to the end of the notice period.' }),
    status: field('Set status to', { type: 'select', options: lookupOpts(ref, 'confirmation_status', em.confirmation_status), value: em.confirmation_status,
      hint: 'Keep the current status while serving notice; change to Resigned after the last day if you prefer.' }),
  };
  const out = h('p', { class: 'notice-calc' });
  const calc = () => {
    const r = policy ? computeNotice({ joinDate: em.join_date, letterDate: F.letter.getValue(), onProbation: em.confirmation_status === 'UP' }, policy) : null;
    if (!r) { out.textContent = em.join_date ? 'Enter the letter date.' : 'Add a join date to work out the notice period.'; return null; }
    out.textContent = `${r.years} completed year(s) of service${r.basis === 'probation' ? ', on probation' : ''} → ${r.weeks} weeks' notice (${r.days} days). Notice ends ${r.noticeEnd}.`;
    if (!F.last.input.dataset.touched) F.last.input.value = r.noticeEnd;
    return r;
  };
  F.last.input.addEventListener('input', () => { F.last.input.dataset.touched = '1'; });
  F.letter.input.addEventListener('change', calc);
  openModal({ title: 'Record resignation', body: h('div', { style: 'display:grid;gap:.9rem' }, F.letter, out, F.last, F.status),
    actions: [{ label: 'Save resignation', primary: true, onClick: async (close) => {
      const r = calc();
      const patch = { resignation_letter_date: F.letter.getValue(), resigned_date: F.last.getValue() || r?.noticeEnd || null, confirmation_status: F.status.getValue() || em.confirmation_status };
      if (!patch.resignation_letter_date) { toast('Letter date is required.', 'error'); return false; }
      const { error } = await ctx.sb.from('eppd_employments').update(patch).eq('id', em.id);
      if (failed(error)) return false;
      await ctx.sb.from('eppd_assignments').update({ end_date: patch.resigned_date }).eq('employment_id', em.id).is('end_date', null);
      toast('Resignation recorded.'); close(); onDone?.(); return true;
    } }] });
  setTimeout(calc, 0);
}

// ---------------------------------------------------------------- company assignment
export function editAssignment(ctx, ref, employmentId, asg, onDone, { joinDate } = {}) {
  const a = asg || {};
  const F = {
    company_id: field('Paid by', { type: 'select', options: companyOpts(ref, a.company_id), value: a.company_id, required: true }),
    is_primary: field('Main company (shown first on reports)', { type: 'switch', value: asg ? a.is_primary : false, span2: true }),
    start_date: field('From', { type: 'date', value: a.start_date || joinDate }),
    end_date: field('Until', { type: 'date', value: a.end_date, hint: 'Blank = ongoing.' }),
  };
  openModal({ title: asg ? 'Edit company' : 'Add a company that pays this person', body: h('div', { class: 'form-grid' }, Object.values(F)),
    actions: [{ label: asg ? 'Save changes' : 'Add company', primary: true, onClick: async (close) => {
      const v = values(F); v.company_id = Number(v.company_id);
      if (v.is_primary) {
        const { error: e0 } = await ctx.sb.from('eppd_assignments').update({ is_primary: false }).eq('employment_id', employmentId).neq('id', a.id || 0);
        if (failed(e0)) return false;
      }
      const q = asg ? ctx.sb.from('eppd_assignments').update(v).eq('id', asg.id)
                    : ctx.sb.from('eppd_assignments').insert({ ...v, employment_id: employmentId });
      const { error } = await q; if (failed(error)) return false;
      toast('Company saved.'); close(); onDone?.(); return true;
    } }] });
}

// ---------------------------------------------------------------- salary history entry
export function editSalary(ctx, assignmentId, row, onDone) {
  const r = row || {};
  const F = {
    effective_from: field('Effective from', { type: 'date', value: r.effective_from || todayIso(), required: true,
      hint: 'Applies to any month whose last day is on or after this date.' }),
    amount: field('Basic salary (RM)', { type: 'number', step: '0.01', value: r.amount, required: true }),
    pay_basis: field('Paid', { type: 'select', options: [['monthly', 'Monthly'], ['hourly', 'Per hour']], value: r.pay_basis || 'monthly' }),
    reason: field('Reason', { value: r.reason, placeholder: 'e.g. Annual increment, confirmation' }),
    note: field('Note', { type: 'textarea', value: r.note, span2: true }),
  };
  openModal({ title: row ? 'Edit salary record' : 'Add salary change', body: h('div', { class: 'form-grid' }, Object.values(F)),
    actions: [{ label: row ? 'Save changes' : 'Add salary change', primary: true, onClick: async (close) => {
      const v = values(F); if (!v.effective_from || v.amount === null) { toast('Date and amount are required.', 'error'); return false; }
      const q = row ? ctx.sb.from('eppd_salary_history').update(v).eq('id', row.id)
                    : ctx.sb.from('eppd_salary_history').insert({ ...v, assignment_id: assignmentId });
      const { error } = await q;
      if (error && /duplicate key/i.test(error.message)) { toast('There is already a salary record on that date. Edit that one instead.', 'error', 6000); return false; }
      if (failed(error)) return false;
      toast('Salary saved.'); close(); onDone?.(); return true;
    } }] });
}

// ---------------------------------------------------------------- recurring allowance
export function editAllowance(ctx, ref, assignmentId, row, onDone, { joinDate } = {}) {
  const r = row || {};
  const types = ref.paymentTypes.filter((t) => t.kind === 'earning' && (t.is_active || t.id === r.payment_type_id) && t.category !== 'basic' && t.category !== 'overtime');
  const F = {
    payment_type_id: field('Allowance', { type: 'select', options: types.map((t) => [t.id, t.name]), value: r.payment_type_id, required: true }),
    amount: field('Amount per month (RM)', { type: 'number', step: '0.01', value: r.amount, required: true }),
    start_date: field('From', { type: 'date', value: r.start_date || joinDate || todayIso() }),
    end_date: field('Until', { type: 'date', value: r.end_date, hint: 'Paid for every month up to and including this date. Blank = ongoing.' }),
    note: field('Note', { type: 'textarea', value: r.note, span2: true }),
  };
  openModal({ title: row ? 'Edit allowance' : 'Add allowance', body: h('div', { class: 'form-grid' }, Object.values(F)),
    actions: [{ label: row ? 'Save changes' : 'Add allowance', primary: true, onClick: async (close) => {
      const v = values(F); v.payment_type_id = Number(v.payment_type_id);
      if (!v.payment_type_id || v.amount === null) { toast('Allowance and amount are required.', 'error'); return false; }
      if (v.start_date && v.end_date && v.end_date < v.start_date) { toast('“Until” must be on or after “From”.', 'error'); return false; }
      const q = row ? ctx.sb.from('eppd_allowances').update(v).eq('id', row.id)
                    : ctx.sb.from('eppd_allowances').insert({ ...v, assignment_id: assignmentId });
      const { error } = await q; if (failed(error)) return false;
      toast('Allowance saved.'); close(); onDone?.(); return true;
    } }] });
}

export async function deleteRow(ctx, table, id, what, onDone) {
  if (!(await confirmDialog(`Delete ${what}`, `Delete this ${what}? This cannot be undone (the audit log keeps a copy).`, 'Delete', true))) return;
  const { error } = await ctx.sb.from(table).delete().eq('id', id);
  if (failed(error, 'Delete')) return;
  toast('Deleted.'); onDone?.();
}

export { clear };
