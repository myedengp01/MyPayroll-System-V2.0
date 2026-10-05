// Statutory tables: browse versions, test the calculator, add a new rate version
import { h, clear, pageHead, openModal, field, toast, failed, money, fmtDate, switchToggle } from '../ui.js';
import { loadStatTables, loadPolicy } from '../data.js';
import { computeEPF, computeSOCSO, computeEIS, lookupBracket } from '../engines/statutory.js';

const VARIANT_LABEL = {
  'EPF:STD': 'Below 60', 'EPF:AGE60': 'Age 60 and above', 'EPF:FOREIGN': 'Foreign workers',
  'SOCSO:CAT1': 'First category (below 60)', 'SOCSO:CAT2': 'Second category (60 and above)', 'EIS:STD': 'Standard',
};

export async function render(el, ctx) {
  const isAdmin = ctx.can(['admin']);
  let tables = await loadStatTables(ctx.sb);
  const rules = (await loadPolicy(ctx.sb, 'statutory_rules')) || {};
  let selected = (tables.versions.find((v) => v.scheme === 'EPF' && v.variant === 'STD') || tables.versions[0])?.id;

  // ---- calculator
  const today = new Date().toISOString().slice(0, 10);
  const C = {
    wage: field('Wage for contributions (RM)', { type: 'number', value: 3000, step: '0.01' }),
    age: field('Age', { type: 'number', value: 30 }),
    cls: field('Statutory class', { type: 'select', value: 'MY', options: [['MY', 'Malaysian'], ['PR', 'Permanent resident'], ['FR', 'Foreign']] }),
    date: field('Payroll month', { type: 'date', value: today.slice(0, 8) + '01' }),
    nei: field('SOCSO NEI opt-out (employee pays invalidity only)', { type: 'switch', value: false, span2: true }),
  };
  const out = h('div', { class: 'calc-out' });
  const card = (title, rowsArr, src) => h('div', { class: 'calc-card' }, h('h3', {}, title),
    h('dl', {}, rowsArr.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])), src ? h('div', { class: 'src' }, src) : null);
  function calc() {
    const p = { wage: C.wage.getValue() || 0, age: C.age.getValue() || 0, statClass: C.cls.getValue(), periodDate: C.date.getValue() || today };
    const epf = computeEPF(tables, p);
    const soc = computeSOCSO(tables, { ...p, neiOptOut: C.nei.getValue() });
    const eis = computeEIS(tables, p, rules);
    clear(out).append(
      card('EPF', [['Employee', money(epf.ee)], ['Employer', money(epf.er)]],
        epf.missing ? 'No table for this date' : `${epf.label}${epf.aboveMax ? ' · % rule above table' : ''}`),
      card('SOCSO', [['Employee', money(soc.ee)],
        ...(soc.ee_inv !== null ? [['  of which invalidity', money(C.nei.getValue() ? soc.ee : soc.ee_inv)],
                                   ['  of which NEI', money(C.nei.getValue() ? 0 : soc.ee_nei)]] : []),
        ['Employer', money(soc.er)]], soc.missing ? 'No table for this date' : soc.label),
      card('EIS', [['Employee', money(eis.ee)], ['Employer', money(eis.er)]],
        eis.exempt ? 'Exempt under your statutory rules' : (eis.missing ? 'No table for this date' : eis.label)));
  }
  Object.values(C).forEach((f) => f.input.addEventListener('input', calc));
  Object.values(C).forEach((f) => f.input.addEventListener('change', calc));

  // ---- version browser
  const listEl = h('div', { class: 'version-list' });
  const detailEl = h('div', {});
  const findWage = h('input', { type: 'number', step: '0.01', placeholder: 'Find wage, e.g. 2450', 'aria-label': 'Find wage in table', style: 'max-width:200px' });
  findWage.addEventListener('input', () => drawDetail());

  function drawList() {
    clear(listEl);
    for (const scheme of ['EPF', 'SOCSO', 'EIS']) {
      listEl.append(h('div', { class: 'menu-group', style: 'padding-left:1.2rem' }, scheme));
      for (const v of tables.versions.filter((x) => x.scheme === scheme)) {
        listEl.append(h('button', { class: 'version-item', type: 'button', 'aria-current': String(v.id === selected),
          onclick: () => { selected = v.id; drawList(); drawDetail(); } },
          h('span', {}, h('div', {}, VARIANT_LABEL[`${v.scheme}:${v.variant}`] || v.variant),
            h('div', { class: 'small muted' }, `From ${fmtDate(v.effective_from)}`)),
          v.is_active ? h('span', { class: 'tag' }, v.rule ? '% rule' : `${v.brackets.length} rows`) : h('span', { class: 'tag bad' }, 'Off')));
      }
    }
  }

  function drawDetail() {
    const v = tables.versions.find((x) => x.id === selected);
    clear(detailEl);
    if (!v) { detailEl.append(h('div', { class: 'empty-state' }, 'No statutory tables loaded. Run sql/003_seed_statutory.sql.')); return; }
    const head = h('div', { class: 'panel-head' },
      h('div', {}, h('h2', {}, v.label), h('p', { class: 'small muted' }, `Effective ${fmtDate(v.effective_from)}`, v.source ? ` · Source: ${v.source}` : '')),
      h('div', { class: 'side-actions', style: 'align-items:center' },
        v.rule ? null : findWage,
        isAdmin ? h('label', { class: 'check-row' }, switchToggle(v.is_active, async (checked, input) => {
          const { error } = await ctx.sb.from('eppd_stat_versions').update({ is_active: checked }).eq('id', v.id);
          if (failed(error)) { input.checked = !checked; return; }
          v.is_active = checked; drawList(); calc(); toast(checked ? 'Version switched on.' : 'Version switched off.');
        }, { label: 'Version active' }), 'In use') : null));
    detailEl.append(head);
    if (v.rule) {
      detailEl.append(h('div', { class: 'panel-body' }, h('p', {},
        `Employer ${v.rule.er_pct}% · Employee ${v.rule.ee_pct}% of wages · rounding: ${v.rule.round}`)));
      return;
    }
    const hasSplit = v.brackets.some((b) => b.ee_nei !== null && b.ee_nei !== undefined);
    const hit = findWage.value !== '' ? lookupBracket(v.brackets, Number(findWage.value)) : null;
    const table = h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', { class: 'num' }, 'Wage from'), h('th', { class: 'num' }, 'Wage to'),
        h('th', { class: 'num' }, 'Employer'), h('th', { class: 'num' }, 'Employee'),
        hasSplit ? [h('th', { class: 'num' }, 'Invalidity'), h('th', { class: 'num' }, 'NEI')] : null)),
      h('tbody', {}, v.brackets.map((b) => h('tr', { class: b === hit ? 'hit' : '', id: b === hit ? 'stat-hit' : null },
        h('td', { class: 'num' }, money(b.wage_min)), h('td', { class: 'num' }, b.wage_max === null ? 'and above' : money(b.wage_max)),
        h('td', { class: 'num' }, money(b.er)), h('td', { class: 'num' }, money(b.ee)),
        hasSplit ? [h('td', { class: 'num' }, money(b.ee_inv)), h('td', { class: 'num' }, money(b.ee_nei))] : null))));
    const wrap = h('div', { class: 'table-wrap', style: 'max-height:520px;overflow:auto' }, table);
    detailEl.append(wrap);
    if (v.above_max) detailEl.append(h('p', { class: 'small muted', style: 'padding:.8rem 1.2rem' },
      `Above the last row: employer ${v.above_max.er_pct}% · employee ${v.above_max.ee_pct}% (rounded ${v.above_max.round.replace('_', ' to ')}).`));
    if (hit) requestAnimationFrame(() => document.getElementById('stat-hit')?.scrollIntoView({ block: 'center' }));
  }

  // ---- add version (admin)
  function addVersion() {
    const F = {
      scheme: field('Scheme', { type: 'select', options: ['EPF', 'SOCSO', 'EIS'], value: 'SOCSO' }),
      variant: field('Variant', { type: 'select', value: 'CAT1',
        options: [['STD', 'EPF/EIS standard'], ['AGE60', 'EPF age 60+'], ['FOREIGN', 'EPF foreign'], ['CAT1', 'SOCSO first category'], ['CAT2', 'SOCSO second category']] }),
      effective_from: field('Effective from', { type: 'date', required: true }),
      label: field('Label', { required: true, placeholder: 'e.g. SOCSO First Category (from Jan 2027)' }),
      source: field('Source', { placeholder: 'e.g. PERKESO circular no. …' }),
      csv: field('Rows (paste from Excel)', { type: 'textarea', span2: true,
        hint: 'One row per line: wage from, wage to, employer, employee [, invalidity, NEI]. Leave “wage to” empty on the last row for the ceiling. Tabs or commas both work.' }),
    };
    F.csv.input.rows = 10;
    openModal({ title: 'Add a new rate version', wide: true,
      body: h('div', {}, h('p', { class: 'small muted', style: 'margin-bottom:1rem' },
        'Old versions stay for past months. The payroll picks whichever version is in force for the month being processed.'),
        h('div', { class: 'form-grid' }, Object.values(F))),
      actions: [{ label: 'Add version', primary: true, onClick: async (close) => {
        const rec = Object.fromEntries(Object.entries(F).filter(([k]) => k !== 'csv').map(([k, f]) => [k, f.getValue()]));
        if (!rec.effective_from || !rec.label) { toast('Effective date and label are required.', 'error'); return false; }
        const rowsIn = []; const bad = [];
        (F.csv.input.value || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((line, i) => {
          const p = line.split(/\t|,/).map((x) => x.trim().replace(/^RM/i, ''));
          const n = (x) => (x === '' || x === undefined ? null : Number(x));
          const r = { wage_min: n(p[0]), wage_max: n(p[1]), er: n(p[2]) ?? 0, ee: n(p[3]) ?? 0, ee_inv: n(p[4]), ee_nei: n(p[5]) };
          if ([r.wage_min, r.er, r.ee].some((x) => x === null || Number.isNaN(x))) bad.push(i + 1); else rowsIn.push(r);
        });
        if (bad.length) { toast(`Check line(s) ${bad.slice(0, 8).join(', ')}.`, 'error', 6000); return false; }
        if (!rowsIn.length) { toast('Paste at least one row.', 'error'); return false; }
        const { data: v, error } = await ctx.sb.from('eppd_stat_versions').insert(rec).select().single();
        if (failed(error)) return false;
        const { error: e2 } = await ctx.sb.from('eppd_stat_brackets').insert(rowsIn.map((r) => ({ ...r, version_id: v.id })));
        if (e2) { await ctx.sb.from('eppd_stat_versions').delete().eq('id', v.id); failed(e2); return false; }
        toast(`Version added with ${rowsIn.length} rows.`); close();
        tables = await loadStatTables(ctx.sb); selected = v.id; drawList(); drawDetail(); calc();
        return true;
      } }] });
  }

  el.append(
    pageHead('Statutory tables', 'EPF, SOCSO and EIS contribution tables, kept by effective date so past payrolls stay correct when rates change.',
      isAdmin ? h('button', { class: 'btn primary', type: 'button', onclick: addVersion }, 'Add rate version') : null),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, 'Check a contribution'),
        h('p', { class: 'small muted' }, 'Uses the same engine as the payroll.'))),
      h('div', { class: 'panel-body' }, h('div', { class: 'form-grid calc-form' },
        C.wage, C.age, C.cls, C.date), h('div', { style: 'margin-top:.8rem' }, C.nei), out)),
    h('section', { class: 'panel stat-split' }, h('div', {}, listEl), h('div', { style: 'min-width:0' }, detailEl)));
  drawList(); drawDetail(); calc();
}
