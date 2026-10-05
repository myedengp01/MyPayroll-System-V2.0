// Departments & job titles
import { h, pageHead } from '../ui.js';
import { crudPanel } from '../crud.js';

export async function render(el, ctx) {
  const { data: comps } = await ctx.sb.from('eppd_companies').select('id,name').eq('is_active', true).order('sort_order');
  const companyOpts = [['', '— Any company —'], ...(comps || []).map((c) => [c.id, c.name])];
  el.append(pageHead('Departments & job titles', 'Used on employee records, payslips and cost reports.'));
  const grid = h('div', {}); el.append(grid);
  await crudPanel(grid, ctx, {
    table: 'eppd_departments', title: 'Departments', itemName: 'department', addLabel: 'Add department',
    writeRoles: ['admin', 'hr'],
    columns: [
      { key: 'code', label: 'Code', required: true },
      { key: 'name', label: 'Name', required: true },
      { key: 'company_id', label: 'Company', type: 'select', options: companyOpts,
        render: (r) => (comps || []).find((c) => c.id === r.company_id)?.name || 'Any' },
      { key: 'sort_order', label: 'Order', type: 'number', default: 0 },
      { key: 'is_active', label: 'Active', type: 'switch', default: true },
    ],
    beforeSave: (rec) => { rec.company_id = rec.company_id ? Number(rec.company_id) : null; rec.code = rec.code?.toUpperCase(); },
  });
  await crudPanel(grid, ctx, {
    table: 'eppd_job_titles', title: 'Job titles', itemName: 'job title', addLabel: 'Add job title',
    writeRoles: ['admin', 'hr'], order: [['sort_order', true], ['name', true]],
    columns: [
      { key: 'name', label: 'Job title', required: true, span2: true },
      { key: 'sort_order', label: 'Order', type: 'number', default: 0 },
      { key: 'is_active', label: 'Active', type: 'switch', default: true },
    ],
  });
}
