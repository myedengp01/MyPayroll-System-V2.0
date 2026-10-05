// Payment types: every earning/deduction carries its own EPF / SOCSO / EIS / PCB treatment
import { h, clear, pageHead, openModal, field, toast, failed, switchToggle, confirmDialog } from '../ui.js';

const CATEGORIES = [['basic', 'Basic pay'], ['allowance', 'Allowance'], ['incentive', 'Commission / incentive'], ['bonus', 'Bonus'],
  ['gift', 'Gift'], ['overtime', 'Overtime'], ['leave', 'Leave-related'], ['claim', 'Claim / reimbursement'],
  ['personal', 'Personal deduction'], ['other', 'Other']];
const FLAGS = [['subject_epf', 'EPF'], ['subject_socso', 'SOCSO'], ['subject_eis', 'EIS'], ['subject_pcb', 'PCB']];

export async function render(el, ctx) {
  const canWrite = ctx.can(['admin']);
  const holder = h('div', {});
  el.append(
    pageHead('Payment types', 'Switch on the contributions each item counts towards. For earnings, “on” adds the amount to that contribution’s wage. For deductions (e.g. unpaid leave), “on” reduces it. Deductions with everything off come out of net pay only.',
      canWrite ? h('button', { class: 'btn primary', type: 'button', onclick: () => edit(null) }, 'Add payment type') : null),
    holder);
  if (!canWrite) holder.append(h('p', { class: 'setup-warning', style: 'margin-bottom:1rem' }, 'Only admins can change statutory treatment.'));

  let rows = [];
  async function load() {
    const { data, error } = await ctx.sb.from('eppd_payment_types').select('*').order('kind', { ascending: false }).order('sort_order');
    if (failed(error, 'Load')) return;
    rows = data || []; draw();
  }

  function draw() {
    clear(holder);
    for (const kind of ['earning', 'deduction']) {
      const list = rows.filter((r) => r.kind === kind);
      holder.append(h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, kind === 'earning' ? 'Earnings' : 'Deductions')),
        h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Category'),
            FLAGS.map(([, l]) => h('th', {}, l)), h('th', {}, 'Recurring'), h('th', {}, 'Active'), canWrite ? h('th', {}) : null)),
          h('tbody', {}, list.map((r) => h('tr', { class: r.is_active ? '' : 'inactive' },
            h('td', {}, h('div', {}, r.name), h('div', { class: 'small muted' }, r.code), r.notes ? h('div', { class: 'small muted', style: 'max-width:42ch' }, r.notes) : null),
            h('td', {}, CATEGORIES.find((c) => c[0] === r.category)?.[1] || r.category),
            FLAGS.map(([k, l]) => h('td', {}, toggle(r, k, `${l} for ${r.name}`))),
            h('td', {}, toggle(r, 'is_recurring', `Recurring for ${r.name}`)),
            h('td', {}, toggle(r, 'is_active', `Active for ${r.name}`)),
            canWrite ? h('td', { class: 'actions' },
              h('button', { class: 'btn sm', type: 'button', onclick: () => edit(r) }, 'Edit'),
              !r.is_system ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => del(r) }, 'Delete') : null) : null)))))));
    }
  }

  function toggle(r, key, label) {
    return switchToggle(r[key], async (checked, input) => {
      const { error } = await ctx.sb.from('eppd_payment_types').update({ [key]: checked }).eq('id', r.id);
      if (failed(error)) { input.checked = !checked; return; }
      r[key] = checked;
      toast(`${r.name}: ${label.split(' for ')[0]} ${checked ? 'on' : 'off'}.`);
    }, { disabled: !canWrite, label });
  }

  function edit(r) {
    const F = {
      code: field('Code', { value: r?.code, required: true, hint: r?.is_system ? 'Used by the payroll engine; cannot change.' : 'Short, unique, e.g. PHONE_ALLOW' }),
      name: field('Name on payslip', { value: r?.name, required: true }),
      kind: field('Type', { type: 'select', value: r?.kind || 'earning', options: [['earning', 'Earning'], ['deduction', 'Deduction']] }),
      category: field('Category', { type: 'select', value: r?.category || 'allowance', options: CATEGORIES }),
      sort_order: field('Display order', { type: 'number', value: r?.sort_order ?? rows.length + 1 }),
      notes: field('Notes', { type: 'textarea', value: r?.notes, span2: true }),
      ...Object.fromEntries(FLAGS.map(([k, l]) => [k, field(`Counts towards ${l}`, { type: 'switch', value: r ? r[k] : true })])),
      is_recurring: field('Recurring every month', { type: 'switch', value: r?.is_recurring }),
    };
    if (r?.is_system) { F.code.input.disabled = true; F.kind.input.disabled = true; }
    openModal({
      title: r ? `Edit ${r.name}` : 'Add payment type', wide: true, body: h('div', { class: 'form-grid' }, Object.values(F)),
      actions: [{ label: r ? 'Save changes' : 'Add payment type', primary: true, onClick: async (close) => {
        const rec = Object.fromEntries(Object.entries(F).map(([k, f]) => [k, f.getValue()]));
        if (r?.is_system) { delete rec.code; delete rec.kind; }
        else rec.code = (rec.code || '').toUpperCase().replace(/\s+/g, '_');
        if (!rec.name || (!r?.is_system && !rec.code)) { toast('Code and name are required.', 'error'); return false; }
        const { error } = r ? await ctx.sb.from('eppd_payment_types').update(rec).eq('id', r.id)
                            : await ctx.sb.from('eppd_payment_types').insert(rec);
        if (failed(error)) return false;
        toast('Payment type saved.'); close(); load(); return true;
      } }],
    });
  }

  async function del(r) {
    if (!(await confirmDialog('Delete payment type', `Delete “${r.name}”? If it has been used in a payroll, switch it off instead.`, 'Delete', true))) return;
    const { error } = await ctx.sb.from('eppd_payment_types').delete().eq('id', r.id);
    if (!failed(error, 'Delete')) { toast('Deleted.'); load(); }
  }

  await load();
}
