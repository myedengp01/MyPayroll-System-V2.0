// Payment types: every earning/deduction carries its own EPF / SOCSO / EIS / PCB treatment
import { h, clear, pageHead, toast, failed, switchToggle } from '../ui.js';
import { CATEGORIES, FLAGS, TREATMENTS, treatmentLabel, editPayType, deletePayType } from '../paytype-form.js';

export async function render(el, ctx) {
  const canWrite = ctx.can(['admin']);
  const holder = h('div', {});
  el.append(
    pageHead('Payment types', 'Switch on the contributions each item counts towards. For earnings, “on” adds the amount to that contribution’s wage. For deductions (e.g. unpaid leave), “on” reduces it. Deductions with everything off come out of net pay only.',
      canWrite ? h('button', { class: 'btn primary', type: 'button', onclick: () => edit(null) }, 'New item type') : null),
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
          h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Category'), h('th', {}, 'Statutory treatment'),
            FLAGS.map(([, l]) => h('th', {}, l)), h('th', {}, 'Recurring'), h('th', {}, 'Active'), canWrite ? h('th', {}) : null)),
          h('tbody', {}, list.map((r) => h('tr', { class: r.is_active ? '' : 'inactive' },
            h('td', {}, h('div', {}, r.name), h('div', { class: 'small muted' }, r.code), r.notes ? h('div', { class: 'small muted', style: 'max-width:42ch' }, r.notes) : null),
            h('td', {}, CATEGORIES.find((c) => c[0] === r.category)?.[1] || r.category),
            h('td', { title: TREATMENTS[r.treatment]?.remark || '' }, treatmentLabel(r.treatment), presetDiff(r)),
            FLAGS.map(([k, l]) => h('td', {}, toggle(r, k, `${l} for ${r.name}`))),
            h('td', {}, toggle(r, 'is_recurring', `Recurring for ${r.name}`)),
            h('td', {}, toggle(r, 'is_active', `Active for ${r.name}`)),
            canWrite ? h('td', { class: 'actions' },
              h('button', { class: 'btn sm', type: 'button', onclick: () => edit(r) }, 'Edit'),
              !r.is_system ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => deletePayType(ctx, r, load) }, 'Delete') : h('span', { class: 'small muted', title: 'System items can be renamed, not deleted' }, 'system')) : null)))))));
    }
  }

  function toggle(r, key, label) {
    return switchToggle(r[key], async (checked, input) => {
      const t = TREATMENTS[r.treatment]; const i = FLAGS.findIndex(([k]) => k === key);
      if (t?.flags && i >= 0 && !!t.flags[i] !== checked) { input.checked = !checked; toast('This tick would differ from the preset: use Edit and give the reason.', 'error', 6000); return; }
      const { error } = await ctx.sb.from('eppd_payment_types').update({ [key]: checked }).eq('id', r.id);
      if (failed(error)) { input.checked = !checked; return; }
      r[key] = checked;
      toast(`${r.name}: ${label.split(' for ')[0]} ${checked ? 'on' : 'off'}.`);
    }, { disabled: !canWrite, label });
  }

  function edit(r) { editPayType(ctx, r, rows, () => load()); }
  function presetDiff(r) {
    const t = TREATMENTS[r.treatment]; if (!t?.flags) return null;
    const off = FLAGS.filter(([k], i) => !!r[k] !== !!t.flags[i]).map(([, l]) => l);
    return off.length ? h('div', { class: 'small', style: 'color:var(--marigold)' }, `differs: ${off.join(', ')}`) : null;
  }

  await load();
}
