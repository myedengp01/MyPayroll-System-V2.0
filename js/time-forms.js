// MyPayroll-System-V2.0 · time-forms.js — overtime / hours entry form and the OTCF pull, shared by
// Time & leave › Overtime & hours, Part-time hours and the payroll line window.
import { h, clear, openModal, field, toast, failed, fmtDate } from './ui.js';
import { OT_CATEGORIES, normalHours, normaliseName, otcfToEntries, hoursBetween } from './engines/ot.js';
export { hoursBetween };
import { todayIso } from './engines/employee.js';
import { mf, megformsConfigured, fetchApprovedOtcf } from './megforms.js';

export const CATS = Object.keys(OT_CATEGORIES);
/** Add or edit one overtime / hours entry. Hours are worked out from From–To (less the break) unless typed. */
export function editTimeEntry(ctx, { people, month, entry: e = null, employeeId = null, category = null, onSaved } = {}) {
  const start = `${month}-01`;
  const current = people.filter((p) => p.status?.key !== 'former' || (e && p.id === e.employee_id) || p.id === employeeId);
  const F = {
    employee_id: field('Employee', { type: 'select', required: true, value: e?.employee_id ?? employeeId ?? '', span2: true,
      options: [['', 'Choose…'], ...current.map((p) => [p.id, `${p.full_name}${p.emp_id ? ` (${p.emp_id})` : ''}`])] }),
    work_date: field('Date', { type: 'date', required: true, value: e?.work_date || (todayIso().startsWith(month) ? todayIso() : start) }),
    category: field('Category', { type: 'select', value: e?.category || category || 'OT_NORMAL', options: CATS.map((c) => [c, OT_CATEGORIES[c].label]) }),
    from_time: field('From', { type: 'time', value: e?.from_time ? String(e.from_time).slice(0, 5) : '' }),
    to_time: field('To', { type: 'time', value: e?.to_time ? String(e.to_time).slice(0, 5) : '' }),
    break_h: field('Break (hours)', { type: 'number', step: '0.25', min: 0, value: 0, hint: 'Taken off the From–To time.' }),
    hours: field('Hours', { type: 'number', step: '0.25', required: true, value: e?.hours ?? '' }),
    note: field('Note', { type: 'textarea', span2: true, value: e?.note }),
  };
  if (employeeId) F.employee_id.input.disabled = true;
  const calc = h('p', { class: 'small muted span-2' });
  let typed = !!e;
  const recalc = () => {
    const hrs = hoursBetween(F.from_time.getValue(), F.to_time.getValue(), F.break_h.getValue());
    if (hrs !== null && !typed) F.hours.input.value = hrs;
    calc.textContent = hrs === null ? 'Fill in From and To to work out the hours, or type the hours.' : `From–To less the break: ${hrs} h${typed && Number(F.hours.getValue()) !== hrs ? ' (you typed your own hours)' : ''}.`;
  };
  ['from_time', 'to_time', 'break_h'].forEach((k) => F[k].input.addEventListener('input', () => { typed = false; recalc(); }));
  F.hours.input.addEventListener('input', () => { typed = true; recalc(); });
  recalc();
  openModal({ title: e ? 'Edit entry' : 'Add overtime or hours', body: h('div', { class: 'form-grid' }, F.employee_id, F.work_date, F.category, F.from_time, F.to_time, F.break_h, F.hours, calc, F.note),
    actions: [{ label: e ? 'Save changes' : 'Add entry', primary: true, onClick: async (close) => {
      const v = { employee_id: Number(employeeId || F.employee_id.getValue()), work_date: F.work_date.getValue(), category: F.category.getValue(),
        from_time: F.from_time.getValue() || null, to_time: F.to_time.getValue() || null, hours: F.hours.getValue(), note: F.note.getValue() || null };
      if (!v.employee_id || !v.work_date || v.hours === null || v.hours === '') { toast('Employee, date and hours are required.', 'error'); return false; }
      const q = e ? ctx.sb.from('eppd_time_entries').update(v).eq('id', e.id) : ctx.sb.from('eppd_time_entries').insert({ ...v, source: 'manual' });
      const { error } = await q; if (failed(error)) return false;
      toast('Saved.'); close(); onSaved?.(); return true;
    } }] });
}

/** Pull approved OTCF claims for a month (optionally for one person only). */
export async function pullOtcf(ctx, { month, people, entries, onlyEmployeeId = null, onSaved }) {
  if (!megformsConfigured) { toast('OTCF is not connected.', 'error'); return; }
  const { data: s } = await mf.auth.getSession();
  if (!s.session) return signIn();
  const byId = new Map(people.map((p) => [p.id, p]));
  const holder = h('div', { class: 'loading' }, 'Reading approved claims from OTCF…');
  const close = openModal({ title: `Pull OTCF claims · ${month}`, wide: true, body: holder, actions: [] });
  try {
    const [subs, linksRes] = await Promise.all([fetchApprovedOtcf(Number(month.slice(0, 4)), Number(month.slice(5, 7))),
      ctx.sb.from('eppd_otcf_links').select('otcf_name,employee_id')]);
    close(); review(subs, linksRes.data || [], s.session.user.email);
  } catch (err) { close(); toast(`Could not read OTCF: ${err.message || err}. Your account needs OTCF admin or approver access.`, 'error', 8000); }

  function signIn() {
    const email = field('Email', { type: 'email', required: true, value: ctx.me.email });
    const pw = field('Password', { type: 'password', required: true });
    openModal({ title: 'Sign in to MEG-FORMS', body: h('div', { style: 'display:grid;gap:.8rem' },
      h('p', { class: 'small muted' }, 'OTCF claims live in MEG-FORMS. Sign in with the account you use to approve OTCF claims.'), email, pw),
      actions: [{ label: 'Sign in and continue', primary: true, onClick: async (cl) => {
        const { error } = await mf.auth.signInWithPassword({ email: email.getValue(), password: pw.input.value });
        if (error) { toast(error.message === 'Invalid login credentials' ? 'Email or password is incorrect.' : error.message, 'error'); return false; }
        cl(); pullOtcf(ctx, { month, people, entries, onlyEmployeeId, onSaved }); return true;
      } }] });
  }
  function review(subs, links, mfEmail) {
    const linkMap = new Map(links.map((l) => [l.otcf_name, l.employee_id]));
    const nameMap = new Map(); for (const p of people) { const k = normaliseName(p.full_name); if (!nameMap.has(k)) nameMap.set(k, p); else nameMap.set(k, null); }
    const picks = new Map();
    const resolve = (name) => { const k = normaliseName(name); const id = picks.get(k) ?? linkMap.get(k); if (id) return byId.get(Number(id)) || null; return nameMap.get(k) || null; };
    const pulled = new Set(entries.filter((e) => e.otcf_submission_id).map((e) => e.otcf_submission_id));
    const fresh = subs.filter((x) => !pulled.has(String(x.id)));
    const box = h('div', {});
    const drawReview = () => {
      const res = otcfToEntries(fresh, resolve, (p) => normalHours(p.employment, 8));
      if (onlyEmployeeId) { res.entries = res.entries.filter((e) => e.employee_id === onlyEmployeeId); }
      const only = onlyEmployeeId ? byId.get(onlyEmployeeId) : null;
      clear(box).append(
        h('p', {}, `Signed in as ${mfEmail}. ${subs.length} approved claim${subs.length === 1 ? '' : 's'} for ${month}; ${subs.length - fresh.length} already pulled.${only ? ` Showing ${only.full_name} only.` : ''}`),
        res.unmatched.length ? h('div', { class: 'block', style: 'margin:.8rem 0' }, h('h3', {}, 'Match these names to employees'),
          h('p', { class: 'small muted', style: 'margin:.3rem 0 .6rem' }, 'OTCF stores the name as typed. Your choice is remembered for next time.'),
          res.unmatched.map((u) => {
            const sel = h('select', { 'aria-label': `Employee for ${u.name}` }, h('option', { value: '' }, 'Skip these claims'),
              people.filter((p) => p.status?.key !== 'former').map((p) => h('option', { value: p.id }, p.full_name)));
            sel.addEventListener('change', () => { if (sel.value) picks.set(u.key, Number(sel.value)); else picks.delete(u.key); drawReview(); });
            return h('label', { class: 'check-row', style: 'margin-bottom:.4rem' }, h('b', { style: 'min-width:14rem' }, `“${u.name}”`), sel, h('span', { class: 'small muted' }, `${u.submissions.length} claim(s)`));
          })) : null,
        res.entries.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, ['Employee', 'Date', 'Category', 'Hours', 'Claim'].map((t) => h('th', {}, t)))),
          h('tbody', {}, res.entries.map((e) => h('tr', {}, h('td', {}, byId.get(e.employee_id)?.full_name), h('td', {}, fmtDate(e.work_date)),
            h('td', {}, OT_CATEGORIES[e.category].label), h('td', { class: 'num' }, e.hours), h('td', { class: 'small muted' }, e.otcf_serial || e.otcf_submission_id))))))
          : h('p', { class: 'empty-state' }, fresh.length ? (only ? `No new approved OTCF claims for ${only.full_name} this month.` : 'Match the names above to see the lines.') : 'Nothing new to pull for this month.'),
        res.skipped ? h('p', { class: 'small muted' }, `${res.skipped} line(s) had hours but no usable claim type or date and were left out.`) : null);
      box.result = res;
    };
    drawReview();
    openModal({ title: `Pull OTCF claims · ${month}`, wide: true, body: box,
      actions: [{ label: 'Add these entries', primary: true, onClick: async (cl) => {
        const res = box.result;
        if (!res.entries.length) { toast('Nothing to add.', 'error'); return false; }
        const newLinks = [...picks.entries()].map(([otcf_name, employee_id]) => ({ otcf_name, employee_id }));
        const { data, error } = await ctx.sb.rpc('eppd_save_otcf_pull', { p: { month, links: newLinks, entries: res.entries } });
        if (failed(error, 'Save')) return false;
        toast(`${data.entries_added} entries added from OTCF.`); cl(); onSaved?.(); return true;
      } }] });
  }
}
