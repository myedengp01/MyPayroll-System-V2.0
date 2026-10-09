// MEG-FORMS claims (SCF, MTCF) paid with the salary — pull approved claims, match names, assign to a payroll month
import { h, clear, pageHead, toast, failed, confirmDialog, openModal, field, money, fmtDate } from '../ui.js';
import { fetchAll } from '../data.js';
import { mf, megformsConfigured, fetchApprovedClaims } from '../megforms.js';
import { normaliseName } from '../engines/ot.js';
import { monthLabel, periodOf } from '../engines/payroll.js';
import { todayIso, addDays } from '../engines/employee.js';

const FORM_LABEL = { scf: 'SCF · staff claim', mtcf: 'MTCF · mileage' };

export async function render(el, ctx, params, query) {
  const mods = ctx.modules?.claims || {};
  const forms = ['scf', 'mtcf'].filter((f) => mods[f] !== false);
  const month = /^\d{4}-\d{2}$/.test(query.month || '') ? `${query.month}-01` : periodOf(todayIso());
  const [claims, run, people] = await Promise.all([
    fetchAll(() => ctx.sb.from('eppd_claims').select('*').eq('pay_period', month).order('id')),
    ctx.sb.from('eppd_pay_runs').select('status').eq('period', month).maybeSingle(),
    fetchAll(() => ctx.sb.from('eppd_employee_list').select('id,emp_id,full_name,confirmation_status,resigned_date').order('full_name')),
  ]);
  const locked = run.data?.status === 'finalised';
  const byId = new Map(people.map((p) => [p.id, p]));
  const pick = h('input', { type: 'month', value: month.slice(0, 7), 'aria-label': 'Payroll month', style: 'width:auto' });
  pick.addEventListener('change', () => { if (pick.value) location.hash = `#/claims?month=${pick.value}`; });
  el.append(pageHead('MEG-FORMS claims', `Approved ${forms.map((f) => f.toUpperCase()).join(' and ')} claims paid with the salary. They are added on top of net pay: not taxed, no EPF / SOCSO / EIS, not on the EA form.`,
    pick, h('button', { class: 'btn primary', type: 'button', disabled: !megformsConfigured || locked, onclick: pull }, 'Pull approved claims')));
  if (locked) el.append(h('p', { class: 'setup-warning', style: 'margin-bottom:1rem' }, `${monthLabel(month)} is finalised: these claims were paid in it and cannot be changed.`));
  const active = claims.filter((c) => c.status === 'active');
  el.append(h('div', { class: 'facts' }, [[active.length, `claims in ${monthLabel(month)}`], [money(active.reduce((s, c) => s + Number(c.amount), 0)), 'to pay (RM)'],
    [claims.length - active.length, 'cancelled']].map(([n, l]) => h('div', { class: 'fact' }, h('b', {}, n), h('span', {}, l)))));
  el.append(h('section', { class: 'panel' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Employee', 'Form', 'Serial no.', 'Claim date', 'Name in MEG-FORMS', 'Amount (RM)', 'Status', ''].map((t, i) => h('th', { class: i === 5 ? 'num' : '' }, t)))),
    h('tbody', {}, claims.length ? claims.map((c) => h('tr', { class: c.status === 'cancelled' ? 'inactive' : '' },
      h('td', {}, h('a', { href: `#/employees/${c.employee_id}?tab=pay` }, byId.get(c.employee_id)?.full_name || `#${c.employee_id}`)),
      h('td', { class: 'small' }, FORM_LABEL[c.form_code] || c.form_code), h('td', {}, c.serial_no || ''), h('td', { class: 'nowrap' }, fmtDate(c.claim_date)),
      h('td', { class: 'small muted' }, c.claimant_name || ''), h('td', { class: 'num' }, money(c.amount)),
      h('td', {}, c.status === 'active' ? h('span', { class: `tag ${locked ? 'ok' : 'info'}` }, locked ? 'Paid' : 'To pay') : h('span', { class: 'tag' }, 'Cancelled')),
      h('td', {}, locked ? null : h('button', { class: 'btn sm', type: 'button', onclick: () => toggle(c) }, c.status === 'active' ? 'Cancel' : 'Restore'))))
      : h('tr', {}, h('td', { colspan: 8, class: 'muted' }, 'No claims for this month yet. Pull approved claims from MEG-FORMS.')))))),
    h('p', { class: 'small muted', style: 'margin-top:.8rem' }, 'After pulling, open the payroll month and press Recalculate so the claims appear on the lines. Remember to mark the claims as paid in MEG-FORMS too.'));

  async function toggle(c) {
    const next = c.status === 'active' ? 'cancelled' : 'active';
    if (next === 'cancelled' && !(await confirmDialog('Cancel claim', `Take ${c.serial_no || 'this claim'} (RM${money(c.amount)}) out of ${monthLabel(month)}? It can be restored later.`, 'Cancel claim', true))) return;
    const { error } = await ctx.sb.from('eppd_claims').update({ status: next }).eq('id', c.id);
    if (!failed(error)) { toast(next === 'cancelled' ? 'Claim cancelled.' : 'Claim restored.'); window.dispatchEvent(new HashChangeEvent('hashchange')); }
  }

  async function pull() {
    const { data: s } = await mf.auth.getSession();
    if (!s.session) return signIn();
    const holder = h('div', { class: 'loading' }, 'Reading approved claims from MEG-FORMS…');
    const close = openModal({ title: `Pull claims · ${monthLabel(month)}`, wide: true, body: holder, actions: [] });
    try {
      const [subs, pulled, links] = await Promise.all([fetchApprovedClaims(forms),
        fetchAll(() => ctx.sb.from('eppd_claims').select('form_code,submission_id,pay_period')), ctx.sb.from('eppd_otcf_links').select('otcf_name,employee_id')]);
      close(); review(subs, pulled, links.data || [], s.session.user.email);
    } catch (err) { close(); toast(`Could not read MEG-FORMS: ${err.message || err}. Your MEG-FORMS account needs admin access to the claim forms.`, 'error', 9000); }
  }
  function signIn() {
    const email = field('MEG-FORMS email', { type: 'email', required: true, value: ctx.me.email });
    const pw = field('MEG-FORMS password', { type: 'password', required: true });
    openModal({ title: 'Sign in to MEG-FORMS', body: h('div', { style: 'display:grid;gap:.8rem' },
      h('p', { class: 'small muted' }, 'Claims live in the MEG-FORMS project. Sign in with your MEG-FORMS admin account. This is remembered on this computer and never changes your payroll login.'), email, pw),
      actions: [{ label: 'Sign in and continue', primary: true, onClick: async (c) => {
        const { error } = await mf.auth.signInWithPassword({ email: email.getValue(), password: pw.input.value });
        if (error) { toast(error.message === 'Invalid login credentials' ? 'Email or password is incorrect.' : error.message, 'error'); return false; }
        c(); pull(); return true;
      } }] });
  }

  function review(subs, pulled, links, mfEmail) {
    const done = new Set(pulled.map((p) => `${p.form_code}|${p.submission_id}`));
    const fresh = subs.filter((c) => !done.has(`${c.form_code}|${c.submission_id}`)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const linkMap = new Map(links.map((l) => [l.otcf_name, l.employee_id]));
    const nameMap = new Map(); for (const p of people) { const k = normaliseName(p.full_name); if (!nameMap.has(k)) nameMap.set(k, p.id); }
    const pick = new Map(); const take = new Map();
    for (const c of fresh) {
      const k = normaliseName(c.claimant); const id = linkMap.get(k) ?? nameMap.get(k) ?? null;
      pick.set(c, id); take.set(c, !c.paid);
    }
    const current = people.filter((p) => !p.resigned_date || p.resigned_date >= addDays(month, -62));
    const box = h('div', {});
    const draw = () => {
      const chosen = fresh.filter((c) => take.get(c) && pick.get(c));
      clear(box).append(
        h('p', {}, `Signed in to MEG-FORMS as ${mfEmail}. ${subs.length} approved claim(s); ${subs.length - fresh.length} already pulled into a payroll month.`),
        fresh.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, ['Pay', 'Form', 'Serial', 'Date', 'Name in MEG-FORMS', 'Employee', 'Amount'].map((t, i) => h('th', { class: i === 6 ? 'num' : '' }, t)))),
          h('tbody', {}, fresh.map((c) => {
            const cb = h('input', { type: 'checkbox', 'aria-label': `Pay ${c.serial_no || c.submission_id}` }); cb.checked = take.get(c);
            cb.addEventListener('change', () => { take.set(c, cb.checked); draw(); });
            const sel = h('select', { 'aria-label': `Employee for ${c.claimant}` }, h('option', { value: '' }, '— choose —'),
              current.map((p) => h('option', { value: p.id, selected: p.id === pick.get(c) }, p.full_name)));
            sel.addEventListener('change', () => { pick.set(c, sel.value ? Number(sel.value) : null); draw(); });
            return h('tr', { class: !pick.get(c) ? 'flag' : '' }, h('td', {}, cb), h('td', { class: 'small' }, c.form_code.toUpperCase()), h('td', {}, c.serial_no || ''),
              h('td', { class: 'nowrap' }, fmtDate(c.date)), h('td', {}, c.claimant || '', c.paid ? h('div', { class: 'small tag warn' }, 'Marked paid in MEG-FORMS') : null), h('td', {}, sel),
              h('td', { class: 'num' }, money(c.amount)));
          })))) : h('p', { class: 'empty-state' }, 'Nothing new to pull.'),
        h('p', { class: 'small muted', style: 'margin-top:.6rem' }, `${chosen.length} claim(s), RM${money(chosen.reduce((s, c) => s + c.amount, 0))}, will be paid in ${monthLabel(month)}. Names you match are remembered.`));
      box.chosen = chosen;
    };
    draw();
    openModal({ title: `Pull claims · ${monthLabel(month)}`, wide: true, body: box,
      actions: [{ label: 'Add to this month', primary: true, onClick: async (close) => {
        const chosen = box.chosen || [];
        if (!chosen.length) { toast('Tick at least one claim with an employee chosen.', 'error'); return false; }
        const rows = chosen.map((c) => ({ employee_id: pick.get(c), form_code: c.form_code, submission_id: c.submission_id, serial_no: c.serial_no, claimant_name: c.claimant,
          claim_date: c.date, amount: c.amount, pay_period: month }));
        const { error } = await ctx.sb.from('eppd_claims').upsert(rows, { onConflict: 'form_code,submission_id', ignoreDuplicates: true });
        if (failed(error, 'Save')) return false;
        const newLinks = [...new Map(chosen.filter((c) => c.claimant && linkMap.get(normaliseName(c.claimant)) !== pick.get(c))
          .map((c) => [normaliseName(c.claimant), { otcf_name: normaliseName(c.claimant), employee_id: pick.get(c) }])).values()];
        if (newLinks.length) await ctx.sb.from('eppd_otcf_links').upsert(newLinks, { onConflict: 'otcf_name' });
        close(); toast(`${rows.length} claim(s) added to ${monthLabel(month)}. Recalculate the payroll month.`); window.dispatchEvent(new HashChangeEvent('hashchange')); return true;
      } }] });
  }
}
