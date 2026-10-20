// MyPayroll-System-V2.0 · paytype-form.js — add / edit / delete an item (payment) type, with statutory presets (PRI-003)
// Used by Settings › Payment types and by "New item type" in the payroll line window.
import { h, openModal, field, toast, failed, confirmDialog } from './ui.js';

export const CATEGORIES = [['basic', 'Basic pay'], ['allowance', 'Allowance'], ['incentive', 'Commission / incentive'], ['bonus', 'Bonus'],
  ['gift', 'Gift'], ['overtime', 'Overtime'], ['leave', 'Leave-related'], ['reimbursement', 'Claim / reimbursement'], ['claim', 'Claim'],
  ['compensation', 'Compensation'], ['personal', 'Personal deduction'], ['other', 'Other']];
export const FLAGS = [['subject_epf', 'EPF'], ['subject_socso', 'SOCSO'], ['subject_eis', 'EIS'], ['subject_pcb', 'PCB']];

/**
 * Statutory presets: the ticks follow how the group's existing items are set up (EPF / SOCSO / EIS / PCB).
 * The remarks are a general guide to the Malaysian rules; check KWSP, PERKESO and LHDN for a special case.
 */
export const TREATMENTS = {
  wages: { label: 'Wages (salary, fixed allowance)', kind: 'earning', category: 'allowance', flags: [1, 1, 1, 1],
    remark: 'Wages under the EPF Act 1991, the SOCSO Act 1969 and the EIS Act 2017: all three contributions apply, and it is taxable (PCB).' },
  travel: { label: 'Travel / exempt-type allowance', kind: 'earning', category: 'allowance', flags: [0, 0, 0, 1],
    remark: 'Travelling allowances are left out of EPF, SOCSO and EIS wages. Still income for tax (PCB); some travel / petrol amounts are tax-exempt up to the LHDN limit.' },
  incentive: { label: 'Commission / incentive', kind: 'earning', category: 'incentive', flags: [1, 1, 1, 1],
    remark: 'Commission and incentives count as wages: EPF, SOCSO and EIS apply, and PCB.' },
  bonus: { label: 'Bonus', kind: 'earning', category: 'bonus', flags: [1, 0, 0, 1],
    remark: 'Bonus is subject to EPF and PCB (additional remuneration), but not to SOCSO or EIS.' },
  gift: { label: 'Gift (cash ang bao, festive)', kind: 'earning', category: 'gift', flags: [0, 0, 0, 1],
    remark: 'Not wages for EPF, SOCSO or EIS. A cash gift is taxable income (PCB).' },
  leave_pay: { label: 'Leave pay (buy back, encashment)', kind: 'earning', category: 'leave', flags: [1, 1, 1, 1],
    remark: 'Set the same as the existing AL buy-back items (all contributions and PCB). Check with KWSP / PERKESO if a payment is only for unused leave on leaving.' },
  overtime: { label: 'Overtime', kind: 'earning', category: 'overtime', flags: [0, 1, 1, 1],
    remark: 'Overtime is left out of EPF wages, but SOCSO, EIS and PCB apply.' },
  compensation: { label: 'Compensation / pay in lieu of notice', kind: 'earning', category: 'compensation', flags: [0, 0, 0, 1],
    remark: 'Termination and in-lieu-of-notice payments are not EPF, SOCSO or EIS wages. Taxable (PCB); compensation for loss of employment has a tax exemption per year of service.' },
  reimbursement: { label: 'Claim / reimbursement', kind: 'earning', category: 'reimbursement', flags: [0, 0, 0, 0],
    remark: 'Repays money the employee spent for work: not wages and not income, so nothing applies.' },
  unpaid_leave: { label: 'Unpaid leave (deduction)', kind: 'deduction', category: 'leave', flags: [1, 1, 1, 1],
    remark: 'Reduces the wages for EPF, SOCSO and EIS, and taxable pay for PCB.' },
  personal: { label: 'Personal deduction (loan, zakat…)', kind: 'deduction', category: 'personal', flags: [0, 0, 0, 0],
    remark: 'Taken from net pay only; contributions and PCB are worked out before it. (Zakat paid through salary is handled as a PCB rebate, not here.)' },
  other: { label: 'Other (set the ticks yourself)', kind: null, category: 'other', flags: null, remark: 'No preset: tick what applies and say why in the note.' },
};
export const treatmentLabel = (t) => TREATMENTS[t]?.label || '—';

/** Add or edit an item type. rows = the current list (for the display order). onDone(savedRow). */
export function editPayType(ctx, r, rows, onDone, { kind: kindFor } = {}) {
  const F = {
    treatment: field('Statutory treatment', { type: 'select', value: r?.treatment || (kindFor === 'deduction' ? 'personal' : 'wages'),
      options: Object.entries(TREATMENTS).map(([k, t]) => [k, t.label]), hint: 'Sets the EPF / SOCSO / EIS / PCB ticks below. You can still change a tick.' }),
    code: field('Code', { value: r?.code, required: true, hint: r?.is_system ? 'Used by the payroll engine; cannot change.' : 'Short, unique, e.g. PHONE_ALLOW' }),
    name: field('Name on payslip', { value: r?.name, required: true, hint: r?.is_system ? 'System items can be renamed but not deleted.' : null }),
    kind: field('Type', { type: 'select', value: r?.kind || kindFor || 'earning', options: [['earning', 'Earning'], ['deduction', 'Deduction']] }),
    category: field('Category', { type: 'select', value: r?.category || 'allowance', options: CATEGORIES }),
    sort_order: field('Display order', { type: 'number', value: r?.sort_order ?? (rows?.length || 0) + 1 }),
    ...Object.fromEntries(FLAGS.map(([k, l]) => [k, field(`Counts towards ${l}`, { type: 'switch', value: r ? r[k] : true })])),
    is_recurring: field('Usually recurring every month', { type: 'switch', value: r?.is_recurring }),
    notes: field('Notes', { type: 'textarea', value: r?.notes, span2: true }),
  };
  const remark = h('p', { class: 'treat-remark span-2' });
  const why = field('Why the ticks differ from the preset', { type: 'textarea', span2: true, hint: 'Required when a tick is changed from the preset. Kept in the notes.' });
  const flagsNow = () => FLAGS.map(([k]) => (F[k].getValue() ? 1 : 0));
  const differs = () => { const t = TREATMENTS[F.treatment.getValue()]; return !t?.flags || t.flags.some((x, i) => x !== flagsNow()[i]); };
  const showWhy = () => {
    const t = TREATMENTS[F.treatment.getValue()];
    remark.textContent = t ? `${t.remark}` : '';
    // an existing item whose ticks already differ only needs a note when something is changed now
    why.hidden = !differs();
  };
  const applyPreset = () => {
    const t = TREATMENTS[F.treatment.getValue()]; if (!t) return;
    if (t.flags) FLAGS.forEach(([k], i) => { F[k].input.checked = !!t.flags[i]; });
    if (t.kind && !r?.is_system) F.kind.input.value = t.kind;
    if (t.category && !r) F.category.input.value = t.category;
    showWhy();
  };
  F.treatment.input.addEventListener('change', applyPreset);
  FLAGS.forEach(([k]) => F[k].input.addEventListener('change', showWhy));
  if (!r) applyPreset(); else showWhy();
  const start = r ? JSON.stringify([r.treatment, ...FLAGS.map(([k]) => !!r[k])]) : null;
  if (r?.is_system) { F.code.input.disabled = true; F.kind.input.disabled = true; }
  openModal({
    title: r ? `Edit ${r.name}` : 'New item type', wide: true,
    body: h('div', { class: 'form-grid' }, F.treatment, remark, F.code, F.name, F.kind, F.category, F.sort_order, F.is_recurring,
      ...FLAGS.map(([k]) => F[k]), why, F.notes),
    actions: [{ label: r ? 'Save changes' : 'Add item type', primary: true, onClick: async (close) => {
      const rec = Object.fromEntries(Object.entries(F).map(([k, f]) => [k, f.getValue()]));
      if (r?.is_system) { delete rec.code; delete rec.kind; }
      else rec.code = (rec.code || '').toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
      if (!rec.name || (!r?.is_system && !rec.code)) { toast('Code and name are required.', 'error'); return false; }
      const changedNow = !r || start !== JSON.stringify([rec.treatment, ...FLAGS.map(([k]) => !!rec[k])]);
      if (differs() && changedNow) {
        const w = why.getValue(); if (!w) { toast('Say why the ticks differ from the preset.', 'error'); return false; }
        rec.notes = [rec.notes, `Ticks differ from the "${treatmentLabel(rec.treatment)}" preset: ${w}`].filter(Boolean).join('\n');
      }
      const { data, error } = r ? await ctx.sb.from('eppd_payment_types').update(rec).eq('id', r.id).select().single()
                                : await ctx.sb.from('eppd_payment_types').insert(rec).select().single();
      if (failed(error)) return false;
      toast(r ? 'Item type saved.' : `Item type “${data.name}” added.`); close(); onDone?.(data); return true;
    } }],
  });
}

/** Delete an item type — not a system one, and not one used in a finalised month or a recurring item (switch it off instead). */
export async function deletePayType(ctx, r, onDone) {
  if (r.is_system) { toast('System items cannot be deleted. Rename it or switch it off.', 'error', 6000); return; }
  const [used, allow] = await Promise.all([
    ctx.sb.from('eppd_pay_lines').select('id, eppd_pay_runs!inner(status)', { count: 'exact', head: true }).eq('eppd_pay_runs.status', 'finalised').filter('items', 'cs', JSON.stringify([{ code: r.code }])),
    ctx.sb.from('eppd_allowances').select('id', { count: 'exact', head: true }).eq('payment_type_id', r.id),
  ]);
  if (used.error || allow.error) { failed(used.error || allow.error, 'Check'); return; }
  if (used.count || allow.count) {
    const why = [used.count ? `used in ${used.count} payslip line(s) of finalised months` : null, allow.count ? `set as a recurring item for ${allow.count} record(s)` : null].filter(Boolean).join(' and ');
    if (await confirmDialog('Cannot delete', `“${r.name}” is ${why}. Switch it off instead? It stays on old payslips but can no longer be added.`, 'Switch off')) {
      const { error } = await ctx.sb.from('eppd_payment_types').update({ is_active: false }).eq('id', r.id);
      if (!failed(error)) { toast(`${r.name} switched off.`); onDone?.(); }
    }
    return;
  }
  if (!(await confirmDialog('Delete item type', `Delete “${r.name}”? It has not been used in a finalised month.`, 'Delete', true))) return;
  const { error } = await ctx.sb.from('eppd_payment_types').delete().eq('id', r.id);
  if (!failed(error, 'Delete')) { toast('Deleted.'); onDone?.(); }
}
