// Public holidays by year (used for PH overtime and leave counting)
import { h, clear, pageHead, openModal, field, toast, failed, fmtDate, confirmDialog } from '../ui.js';

export async function render(el, ctx) {
  const canWrite = ctx.can(['admin', 'hr']);
  let year = new Date().getFullYear();
  const yearSel = h('select', { 'aria-label': 'Year', style: 'width:auto' },
    [year - 1, year, year + 1].map((y) => h('option', { value: y, selected: y === year }, y)));
  yearSel.addEventListener('change', () => { year = Number(yearSel.value); load(); });
  const body = h('div', { class: 'table-wrap' });
  el.append(
    pageHead('Public holidays', 'Holidays observed by the group. Overtime on these dates is paid at public-holiday rates.',
      yearSel,
      canWrite ? h('button', { class: 'btn', type: 'button', onclick: bulk }, 'Paste a list') : null,
      canWrite ? h('button', { class: 'btn primary', type: 'button', onclick: () => edit(null) }, 'Add holiday') : null),
    h('section', { class: 'panel' }, body));

  let rows = [];
  async function load() {
    const { data, error } = await ctx.sb.from('eppd_holidays').select('*')
      .gte('holiday_date', `${year}-01-01`).lte('holiday_date', `${year}-12-31`).order('holiday_date');
    if (failed(error, 'Load')) return;
    rows = data || []; draw();
  }
  function draw() {
    clear(body);
    if (!rows.length) {
      body.append(h('div', { class: 'empty-state' }, h('p', {}, `No holidays entered for ${year} yet.`),
        canWrite ? h('button', { class: 'btn primary', type: 'button', onclick: bulk }, 'Paste the year’s list') : null));
      return;
    }
    body.append(h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Day'), h('th', {}, 'Holiday'), h('th', {}, 'Applies to'), canWrite ? h('th', {}) : null)),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', {}, fmtDate(r.holiday_date)),
        h('td', {}, new Date(r.holiday_date + 'T00:00:00').toLocaleDateString('en-MY', { weekday: 'short' })),
        h('td', {}, r.name), h('td', {}, r.scope),
        canWrite ? h('td', { class: 'actions' },
          h('button', { class: 'btn sm', type: 'button', onclick: () => edit(r) }, 'Edit'),
          h('button', { class: 'btn sm ghost', type: 'button', onclick: () => del(r) }, 'Delete')) : null)))));
  }
  function edit(r) {
    const F = { holiday_date: field('Date', { type: 'date', value: r?.holiday_date, required: true }),
      name: field('Holiday', { value: r?.name, required: true }),
      scope: field('Applies to', { value: r?.scope || 'Johor', hint: 'Johor, or National' }) };
    openModal({ title: r ? 'Edit holiday' : 'Add holiday', body: h('div', { class: 'form-grid' }, Object.values(F)),
      actions: [{ label: r ? 'Save changes' : 'Add holiday', primary: true, onClick: async (close) => {
        const rec = Object.fromEntries(Object.entries(F).map(([k, f]) => [k, f.getValue()]));
        if (!rec.holiday_date || !rec.name) { toast('Date and holiday name are required.', 'error'); return false; }
        rec.scope = rec.scope || 'Johor';
        const { error } = r ? await ctx.sb.from('eppd_holidays').update(rec).eq('id', r.id) : await ctx.sb.from('eppd_holidays').insert(rec);
        if (failed(error)) return false;
        toast('Holiday saved.'); close(); load(); return true;
      } }] });
  }
  async function del(r) {
    if (!(await confirmDialog('Delete holiday', `Delete ${r.name} (${fmtDate(r.holiday_date)})?`, 'Delete', true))) return;
    const { error } = await ctx.sb.from('eppd_holidays').delete().eq('id', r.id);
    if (!failed(error, 'Delete')) { toast('Deleted.'); load(); }
  }
  function bulk() {
    const ta = h('textarea', { rows: 12, placeholder: '2026-01-01, New Year’s Day\n2026-02-17, Chinese New Year\n…' });
    openModal({ title: 'Paste a holiday list', wide: true,
      body: h('div', { style: 'display:grid;gap:.6rem' },
        h('p', { class: 'small muted' }, 'One holiday per line: date (YYYY-MM-DD), a comma, then the name. Optional third value: Johor or National. Existing dates are updated.'),
        ta),
      actions: [{ label: 'Import holidays', primary: true, onClick: async (close) => {
        const recs = []; const bad = [];
        ta.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((line, i) => {
          const [d, name, scope] = line.split(/\s*[,\t]\s*/);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '') || !name) bad.push(i + 1);
          else recs.push({ holiday_date: d, name, scope: scope || 'Johor' });
        });
        if (bad.length) { toast(`Check line(s) ${bad.join(', ')}: use YYYY-MM-DD, Name`, 'error', 6000); return false; }
        if (!recs.length) { toast('Nothing to import.', 'error'); return false; }
        const { error } = await ctx.sb.from('eppd_holidays').upsert(recs, { onConflict: 'holiday_date,scope' });
        if (failed(error, 'Import')) return false;
        toast(`${recs.length} holidays imported.`); close(); load(); return true;
      } }] });
  }
  await load();
}
