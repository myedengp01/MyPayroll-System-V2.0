// Pick-lists (eppd_lookups) with one tab per category
import { h, clear, pageHead } from '../ui.js';
import { crudPanel } from '../crud.js';

const CATS = [
  ['gender', 'Gender'], ['nationality', 'Nationality'], ['race', 'Race'], ['marital_status', 'Marital status'],
  ['bank', 'Banks'], ['job_status', 'Job status'], ['confirmation_status', 'Employment status'], ['leave_type', 'Leave types'],
];
const EXTRA = {
  nationality: [{ key: 'meta.stat_class', label: 'Statutory class', type: 'select', required: true,
    options: [['MY', 'Malaysian (MY)'], ['PR', 'Permanent resident (PR)'], ['FR', 'Foreign (FR)']],
    hint: 'Decides which EPF table applies. Foreign staff use the 2% rule.' }],
  confirmation_status: [{ key: 'meta.is_active_employment', label: 'Still employed', type: 'switch', default: true,
    render: (r) => (r.meta?.is_active_employment ? 'Yes' : 'No'),
    hint: 'Off for Resigned, Terminated and Dismissed. Used to filter payroll lists.' }],
};

export async function render(el, ctx) {
  el.append(pageHead('Pick-lists', 'The choices offered in drop-downs across the app. Switch an item off instead of deleting it once it is in use.'));
  let current = location.hash.split('?cat=')[1] || 'gender';
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const holder = h('div', {});
  const wrap = h('section', { class: 'panel' }, tabs, h('div', { class: 'panel-body', style: 'padding:0' }, holder));
  el.append(wrap);

  async function show(cat) {
    current = cat;
    clear(tabs).append(...CATS.map(([k, label]) => h('button', {
      role: 'tab', 'aria-selected': String(k === cat), type: 'button', onclick: () => show(k) }, label)));
    clear(holder);
    const label = CATS.find((c) => c[0] === cat)[1];
    await crudPanel(holder, ctx, {
      table: 'eppd_lookups', title: label, itemName: 'item', addLabel: 'Add item',
      writeRoles: ['admin', 'hr'], filter: { category: cat }, order: [['sort_order', true], ['label', true]],
      columns: [
        { key: 'code', label: 'Code', required: true },
        { key: 'label', label: 'Label', required: true },
        ...(EXTRA[cat] || []),
        { key: 'sort_order', label: 'Order', type: 'number', default: 0 },
        { key: 'is_active', label: 'Active', type: 'switch', default: true },
      ],
      beforeSave: (rec) => { rec.code = rec.code?.toUpperCase().replace(/\s+/g, '_'); },
    });
    holder.querySelector('.panel').style.cssText = 'border:0;box-shadow:none;border-radius:0';
  }
  await show(current);
}
