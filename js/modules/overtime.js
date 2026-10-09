// Overtime & part-time hours: monthly view, manual entries, pull approved OTCF claims
import { h, clear, pageHead, fmtDate, openModal, field, toast, failed, confirmDialog } from '../ui.js';
import { loadRef, fetchAll } from '../data.js';
import { loadPeople } from '../leave-data.js';
import { OT_CATEGORIES, normalHours, normaliseName, otcfToEntries } from '../engines/ot.js';
import { todayIso, lastDayOfMonth } from '../engines/employee.js';
import { mf, megformsConfigured, fetchApprovedOtcf } from '../megforms.js';

const CATS = Object.keys(OT_CATEGORIES);
const SHORT = { OT_NORMAL: 'Normal', OT_OFFDAY: 'Off day', RD_HALF: 'RD ≤½', RD_FULL: 'RD >½', RD_EXCESS: 'RD extra', PH_NORMAL: 'PH', PH_EXCESS: 'PH extra', PT_HOURS: 'Part-time' };

export async function render(el, ctx, params, query) {
  const month = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month : todayIso().slice(0, 7);
  const start = `${month}-01`, end = lastDayOfMonth(start);
  const ref = await loadRef(ctx.sb);
  const [people, entries] = await Promise.all([loadPeople(ctx.sb, ref),
    fetchAll(() => ctx.sb.from('eppd_time_entries').select('*').gte('work_date', start).lte('work_date', end).order('work_date'))]);
  const byId = new Map(people.map((p) => [p.id, p]));
  const open = new Set();

  const monthIn = h('input', { type: 'month', value: month, 'aria-label': 'Month', style: 'width:auto' });
  monthIn.addEventListener('change', () => { if (monthIn.value) location.hash = `#/time?month=${monthIn.value}`; });
  const body = h('div', { class: 'table-wrap' });
  el.append(pageHead('Overtime & hours', 'Hours by Employment Act category for the month. Rest days and public holidays are counted per day worked; the payroll applies the rates in Phase 4.',
    monthIn, h('button', { class: 'btn', type: 'button', onclick: () => edit(null) }, 'Add entry'),
    h('button', { class: 'btn primary', type: 'button', onclick: pull, disabled: !megformsConfigured }, 'Pull approved OTCF claims')),
  h('section', { class: 'panel' }, body),
  h('details', { class: 'panel legend-box' }, h('summary', {}, 'What each category pays (Employment Act)'),
    h('ul', {}, CATS.map((c) => h('li', {}, h('b', {}, OT_CATEGORIES[c].label), ` — ${OT_CATEGORIES[c].pay}`)))));

  function draw() {
    clear(body);
    if (!entries.length) {
      body.append(h('div', { class: 'empty-state' }, h('p', {}, `No overtime or part-time hours for ${new Date(start + 'T00:00:00').toLocaleDateString('en-MY', { month: 'long', year: 'numeric' })} yet.`),
        h('div', { class: 'side-actions', style: 'justify-content:center' },
          megformsConfigured ? h('button', { class: 'btn primary', type: 'button', onclick: pull }, 'Pull approved OTCF claims') : null,
          h('button', { class: 'btn', type: 'button', onclick: () => edit(null) }, 'Add entry'))));
      return;
    }
    const groups = new Map();
    for (const e of entries) { if (!groups.has(e.employee_id)) groups.set(e.employee_id, []); groups.get(e.employee_id).push(e); }
    const used = CATS.filter((c) => entries.some((e) => e.category === c));
    const sum = (list, c) => Math.round(list.filter((e) => e.category === c).reduce((s, e) => s + Number(e.hours), 0) * 100) / 100;
    const days = (list, c) => list.filter((e) => e.category === c).length;
    const tbody = h('tbody', {});
    for (const [empId, list] of [...groups.entries()].sort((a, b) => (byId.get(a[0])?.full_name || '').localeCompare(byId.get(b[0])?.full_name || ''))) {
      const p = byId.get(empId);
      const toggle = h('button', { class: 'btn sm ghost', type: 'button', 'aria-expanded': String(open.has(empId)) }, open.has(empId) ? 'Hide' : `${list.length} entr${list.length === 1 ? 'y' : 'ies'}`);
      toggle.addEventListener('click', () => { if (open.has(empId)) open.delete(empId); else open.add(empId); draw(); });
      tbody.append(h('tr', { class: 'grp-row' },
        h('td', {}, h('a', { href: `#/employees/${empId}`, class: 'row-link' }, p?.full_name || '?'), h('div', { class: 'small muted' }, p?.emp_id || '')),
        used.map((c) => { const hrs = sum(list, c); const n = days(list, c);
          return h('td', { class: 'num' }, hrs ? `${hrs} h` : '', hrs && ['RD_HALF', 'RD_FULL', 'PH_NORMAL'].includes(c) ? h('div', { class: 'small muted' }, `${n} day${n === 1 ? '' : 's'}`) : null); }),
        h('td', { class: 'actions' }, toggle)));
      if (open.has(empId)) for (const e of list) tbody.append(h('tr', { class: 'sub-row' },
        h('td', { colspan: used.length + 1 }, h('div', { class: 'entry-line' },
          h('span', {}, fmtDate(e.work_date)), h('b', {}, `${Number(e.hours)} h`), h('span', {}, OT_CATEGORIES[e.category].label),
          e.from_time ? h('span', { class: 'muted' }, `${String(e.from_time).slice(0, 5)}–${String(e.to_time || '').slice(0, 5)}`) : null,
          h('span', { class: `tag ${e.source === 'otcf' ? 'info' : ''}` }, e.source === 'otcf' ? 'OTCF' : e.source === 'import' ? 'Workbook' : 'Manual'),
          e.note ? h('span', { class: 'small muted' }, e.note) : null)),
        h('td', { class: 'actions' }, h('button', { class: 'btn sm', type: 'button', onclick: () => edit(e) }, 'Edit'),
          h('button', { class: 'btn sm ghost', type: 'button', onclick: () => remove(e) }, 'Delete'))));
    }
    body.append(h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Employee'), used.map((c) => h('th', { class: 'num', title: OT_CATEGORIES[c].label }, SHORT[c])), h('th', {}))), tbody));
  }
  draw();

  const reload = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  async function remove(e) {
    if (!(await confirmDialog('Delete entry', `Delete ${e.hours} h of ${OT_CATEGORIES[e.category].label} on ${fmtDate(e.work_date)}?${e.source === 'otcf' ? ' Pulling OTCF again will bring it back.' : ''}`, 'Delete', true))) return;
    const { error } = await ctx.sb.from('eppd_time_entries').delete().eq('id', e.id);
    if (!failed(error, 'Delete')) { toast('Deleted.'); reload(); }
  }
  function edit(e) {
    const current = people.filter((p) => p.status.key !== 'former' || (e && p.id === e.employee_id));
    const F = {
      employee_id: field('Employee', { type: 'select', required: true, value: e?.employee_id ?? '', span2: true,
        options: [['', 'Choose…'], ...current.map((p) => [p.id, `${p.full_name}${p.emp_id ? ` (${p.emp_id})` : ''}`])] }),
      work_date: field('Date', { type: 'date', required: true, value: e?.work_date || (todayIso().startsWith(month) ? todayIso() : start) }),
      category: field('Category', { type: 'select', value: e?.category || 'OT_NORMAL', options: CATS.map((c) => [c, OT_CATEGORIES[c].label]) }),
      hours: field('Hours', { type: 'number', step: '0.25', required: true, value: e?.hours ?? '' }),
      from_time: field('From (optional)', { type: 'time', value: e?.from_time ? String(e.from_time).slice(0, 5) : '' }),
      to_time: field('To (optional)', { type: 'time', value: e?.to_time ? String(e.to_time).slice(0, 5) : '' }),
      note: field('Note', { type: 'textarea', span2: true, value: e?.note }),
    };
    openModal({ title: e ? 'Edit entry' : 'Add overtime or hours', body: h('div', { class: 'form-grid' }, Object.values(F)),
      actions: [{ label: e ? 'Save changes' : 'Add entry', primary: true, onClick: async (close) => {
        const v = Object.fromEntries(Object.entries(F).map(([k, f]) => [k, f.getValue()]));
        if (!v.employee_id || !v.work_date || v.hours === null) { toast('Employee, date and hours are required.', 'error'); return false; }
        v.employee_id = Number(v.employee_id);
        const q = e ? ctx.sb.from('eppd_time_entries').update(v).eq('id', e.id) : ctx.sb.from('eppd_time_entries').insert({ ...v, source: 'manual' });
        const { error } = await q; if (failed(error)) return false;
        toast('Saved.'); close(); reload(); return true;
      } }] });
  }

  // ---------------------------------------------------------------- OTCF pull
  async function pull() {
    const { data: s } = await mf.auth.getSession();
    if (!s.session) return signIn();
    const holder = h('div', { class: 'loading' }, 'Reading approved claims from OTCF…');
    let close;
    close = openModal({ title: `Pull OTCF claims · ${month}`, wide: true, body: holder, actions: [] });
    try {
      const [subs, linksRes] = await Promise.all([fetchApprovedOtcf(Number(month.slice(0, 4)), Number(month.slice(5))),
        ctx.sb.from('eppd_otcf_links').select('otcf_name,employee_id')]);
      close(); review(subs, linksRes.data || [], s.session.user.email);
    } catch (err) { close(); toast(`Could not read OTCF: ${err.message || err}. Your OTCF account needs admin or approver access.`, 'error', 8000); }
  }
  function signIn() {
    const email = field('OTCF email', { type: 'email', required: true, value: ctx.me.email });
    const pw = field('OTCF password', { type: 'password', required: true });
    openModal({ title: 'Sign in to MEG-FORMS', body: h('div', { style: 'display:grid;gap:.8rem' },
      h('p', { class: 'small muted' }, 'OTCF claims live in the MEG-FORMS project. Sign in with the account you use to approve OTCF claims. This is remembered on this computer and never changes your payroll login.'), email, pw),
      actions: [{ label: 'Sign in and continue', primary: true, onClick: async (close) => {
        const { error } = await mf.auth.signInWithPassword({ email: email.getValue(), password: pw.input.value });
        if (error) { toast(error.message === 'Invalid login credentials' ? 'Email or password is incorrect.' : error.message, 'error'); return false; }
        close(); pull(); return true;
      } }] });
  }
  function review(subs, links, mfEmail) {
    const linkMap = new Map(links.map((l) => [l.otcf_name, l.employee_id]));
    const nameMap = new Map(); for (const p of people) { const k = normaliseName(p.full_name); if (!nameMap.has(k)) nameMap.set(k, p); else nameMap.set(k, null); }
    const picks = new Map();
    const resolve = (name) => { const k = normaliseName(name); const id = picks.get(k) ?? linkMap.get(k); if (id) return byId.get(Number(id)) || null; return nameMap.get(k) || null; };
    const pulled = new Set(entries.filter((e) => e.otcf_submission_id).map((e) => e.otcf_submission_id));
    const fresh = subs.filter((s) => !pulled.has(String(s.id)));
    const box = h('div', {});
    const drawReview = () => {
      const res = otcfToEntries(fresh, resolve, (p) => normalHours(p.employment, 8));
      clear(box).append(
        h('p', {}, `Signed in to MEG-FORMS as ${mfEmail}. ${subs.length} approved claim${subs.length === 1 ? '' : 's'} for ${month}; ${subs.length - fresh.length} already pulled.`),
        res.unmatched.length ? h('div', { class: 'block', style: 'margin:.8rem 0' }, h('h3', {}, 'Match these names to employees'),
          h('p', { class: 'small muted', style: 'margin:.3rem 0 .6rem' }, 'OTCF stores the name as typed. Your choice is remembered for next time.'),
          res.unmatched.map((u) => {
            const sel = h('select', { 'aria-label': `Employee for ${u.name}` }, h('option', { value: '' }, 'Skip these claims'),
              people.filter((p) => p.status.key !== 'former').map((p) => h('option', { value: p.id }, p.full_name)));
            sel.addEventListener('change', () => { if (sel.value) picks.set(u.key, Number(sel.value)); else picks.delete(u.key); drawReview(); });
            return h('label', { class: 'check-row', style: 'margin-bottom:.4rem' }, h('b', { style: 'min-width:14rem' }, `“${u.name}”`), sel, h('span', { class: 'small muted' }, `${u.submissions.length} claim(s)`));
          })) : null,
        res.entries.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, ['Employee', 'Date', 'Category', 'Hours', 'Claim'].map((t) => h('th', {}, t)))),
          h('tbody', {}, res.entries.map((e) => h('tr', {}, h('td', {}, byId.get(e.employee_id)?.full_name), h('td', {}, fmtDate(e.work_date)),
            h('td', {}, OT_CATEGORIES[e.category].label), h('td', { class: 'num' }, e.hours), h('td', { class: 'small muted' }, e.otcf_serial || e.otcf_submission_id))))))
          : h('p', { class: 'empty-state' }, fresh.length ? 'Match the names above to see the lines.' : 'Nothing new to pull for this month.'),
        res.skipped ? h('p', { class: 'small muted' }, `${res.skipped} line(s) had hours but no usable claim type or date and were left out.`) : null);
      box.result = res;
    };
    drawReview();
    openModal({ title: `Pull OTCF claims · ${month}`, wide: true, body: box,
      actions: [{ label: 'Add these entries', primary: true, onClick: async (close) => {
        const res = box.result;
        if (!res.entries.length) { toast('Nothing to add.', 'error'); return false; }
        const newLinks = [...picks.entries()].map(([otcf_name, employee_id]) => ({ otcf_name, employee_id }));
        const { data, error } = await ctx.sb.rpc('eppd_save_otcf_pull', { p: { month, links: newLinks, entries: res.entries } });
        if (failed(error, 'Save')) return false;
        toast(`${data.entries_added} entries added from OTCF.`); close(); reload(); return true;
      } }] });
  }
}
