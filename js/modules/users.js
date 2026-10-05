// Users & access (admin only)
import { h, clear, pageHead, toast, failed, fmtDateTime, confirmDialog } from '../ui.js';

const ROLES = [['admin', 'Admin – everything, including statutory tables and users'], ['hr', 'HR – staff records and master data'],
  ['approver', 'Approver – reviews and approves payroll'], ['viewer', 'Viewer – read only']];

export async function render(el, ctx) {
  const body = h('div', { class: 'table-wrap' });
  el.append(pageHead('Users & access', 'People sign up from the login page and wait here until you approve them. Access to this app is separate from MyPRSys.'),
    h('section', { class: 'panel' }, body),
    h('section', { class: 'panel' }, h('div', { class: 'panel-body' }, h('h3', { style: 'margin-bottom:.5rem' }, 'What each role can do'),
      h('ul', { class: 'small', style: 'margin:0;padding-left:1.2rem;display:grid;gap:.3rem' }, ROLES.map(([, d]) => h('li', {}, d))))));

  async function load() {
    const { data, error } = await ctx.sb.from('eppd_user_roles').select('*').order('status', { ascending: false }).order('created_at');
    if (failed(error, 'Load')) return;
    const order = { pending: 0, active: 1, disabled: 2 };
    const rows = (data || []).sort((a, b) => order[a.status] - order[b.status]);
    clear(body).append(h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Person'), h('th', {}, 'Role'), h('th', {}, 'Access'), h('th', {}, 'Joined'), h('th', {}))),
      h('tbody', {}, rows.map((r) => {
        const role = h('select', { 'aria-label': `Role for ${r.email}`, style: 'width:auto' },
          ROLES.map(([v]) => h('option', { value: v, selected: v === r.role }, v)));
        const status = h('select', { 'aria-label': `Access for ${r.email}`, style: 'width:auto' },
          [['active', 'Active'], ['pending', 'Pending'], ['disabled', 'Turned off']].map(([v, l]) => h('option', { value: v, selected: v === r.status }, l)));
        const saveBtn = h('button', { class: 'btn sm primary', type: 'button' }, r.status === 'pending' ? 'Approve' : 'Save');
        if (r.status === 'pending') status.value = 'active';
        saveBtn.addEventListener('click', async () => {
          if (r.user_id === ctx.me.user_id && (role.value !== 'admin' || status.value !== 'active')) {
            if (!(await confirmDialog('Change your own access', 'You are removing your own admin access. Continue?', 'Continue', true))) return;
          }
          const { error: e } = await ctx.sb.from('eppd_user_roles').update({ role: role.value, status: status.value }).eq('user_id', r.user_id);
          if (failed(e)) return;
          toast(`${r.email}: ${role.value}, ${status.value}.`); load();
        });
        return h('tr', { class: r.status === 'disabled' ? 'inactive' : '' },
          h('td', {}, h('div', {}, r.display_name || '—'), h('div', { class: 'small muted' }, r.email)),
          h('td', {}, role), h('td', {}, status, r.status === 'pending' ? h('span', { class: 'tag warn', style: 'margin-left:.4rem' }, 'Waiting') : null),
          h('td', { class: 'small muted' }, fmtDateTime(r.created_at)), h('td', { class: 'actions' }, saveBtn));
      }))));
  }
  await load();
}
