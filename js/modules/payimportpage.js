// One-time import of past payroll months (PayrollSMRY2026) as finalised months, with an engine comparison (admin)
import { h, clear, pageHead, toast, failed, confirmDialog, money } from '../ui.js';
import { fetchAll, loadRef, loadStatTables } from '../data.js';
import { loadPayPeople, loadPayTypes, loadPayInputs } from '../pay-data.js';
import { buildPayHistory, historyPayload, compareMonth, PAYROLL_SHEET } from '../engines/payimport.js';
import { runTotals, monthLabel } from '../engines/payroll.js';

const SHEETJS = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
function loadSheetJS() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = SHEETJS; s.async = true;
    s.onload = () => resolve(window.XLSX); s.onerror = () => reject(new Error('Could not load the spreadsheet reader. Check your internet connection.'));
    document.head.append(s);
  });
}

export async function render(el, ctx) {
  const ref = await loadRef(ctx.sb);
  const [people, types, tables, runs] = await Promise.all([loadPayPeople(ctx.sb, ref), loadPayTypes(ctx.sb), loadStatTables(ctx.sb),
    fetchAll(() => ctx.sb.from('eppd_pay_runs').select('period,status,source').order('period'))]);
  el.append(pageHead('Import past payroll months', `Brings January–September 2026 in from ${PAYROLL_SHEET} as finalised months, exactly as the workbook calculated them, so year-to-date totals are complete. Each month is also run through the new engine so you can see where the new rules differ.`));
  if (!people.length) { el.append(h('div', { class: 'empty-state' }, 'Import employees first (People › Import from workbook).')); return; }
  const imported = runs.filter((r) => r.source === 'import'); const appRuns = runs.filter((r) => r.source === 'app');
  if (imported.length) el.append(h('p', { class: 'setup-warning', style: 'margin-bottom:1rem' }, `${imported.length} month(s) were imported before. Importing again replaces them.`));
  if (appRuns.length) el.append(h('p', { class: 'setup-warning', style: 'margin-bottom:1rem' }, `Months already made in the app (${appRuns.map((r) => monthLabel(r.period)).join(', ')}) are never replaced; if the workbook has the same month, the import stops.`));
  const fileIn = h('input', { type: 'file', accept: '.xlsm,.xlsx', class: 'hidden' });
  const pick = h('button', { class: 'btn primary', type: 'button', onclick: () => fileIn.click() }, 'Choose workbook file');
  const status = h('p', { class: 'small muted', role: 'status' });
  const out = h('div', {});
  el.append(h('section', { class: 'panel' }, h('div', { class: 'panel-body drop' }, h('p', {}, 'Choose the MEG-EPPD workbook (.xlsm). Nothing is saved until you press Import.'), pick, fileIn, status)), out);

  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0]; if (!f) return;
    pick.disabled = true; status.textContent = `Reading ${f.name}…`;
    try {
      const XLSX = await loadSheetJS();
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', sheets: [PAYROLL_SHEET] });
      const res = buildPayHistory(wb.Sheets, people, types.byCode);
      if (!res.months.length) throw new Error('No payroll months from January 2026 were found in this file.');
      status.textContent = `${f.name} read. Comparing with the new engine…`;
      const inputs = await loadPayInputs(ctx.sb, res.months[0].period, res.months[res.months.length - 1].period);
      const D = { people, types: types.byCode, typesById: types.byId, tables, policies: ref.policies, confMeta: ref.confMeta, ...inputs };
      const cmp = new Map(res.months.map((m) => [m.period, compareMonth(m, D)]));
      status.textContent = `${f.name} read.`;
      preview(res, cmp, f.name);
    } catch (e) { status.textContent = ''; toast(e.message || String(e), 'error', 7000); }
    finally { pick.disabled = false; fileIn.value = ''; }
  });

  function preview(res, cmp, fileName) {
    const s = res.summary;
    const facts = h('div', { class: 'facts' });
    const drawFacts = () => clear(facts).append(...[[s.months, 'months'], [s.lines, 'pay lines'], [res.months.flatMap((m) => m.lines).filter((l) => l.excluded).length, 'lines held back'],
      [s.unmatched, 'unmatched names'], [s.mismatched, 'lines that do not add up']]
      .map(([n, l]) => h('div', { class: `fact ${(l.startsWith('unmatched') || l.startsWith('lines that')) && n ? 'bad' : ''}` }, h('b', {}, n), h('span', {}, l))));
    drawFacts();
    const monthsBody = h('tbody', {});
    const drawMonths = () => clear(monthsBody).append(...res.months.map((m) => {
      const T = runTotals(m.lines).all; const c = cmp.get(m.period) || [];
      const same = c.filter((x) => !x.diffs.length).length;
      return h('tr', {}, h('td', {}, monthLabel(m.period)), h('td', { class: 'num' }, T.lines), h('td', { class: 'num' }, money(T.gross)),
        h('td', { class: 'num' }, money(T.epf_ee + T.epf_er)), h('td', { class: 'num' }, money(T.socso_ee + T.socso_er)), h('td', { class: 'num' }, money(T.eis_ee + T.eis_er)),
        h('td', { class: 'num' }, money(T.pcb)), h('td', { class: 'num strong' }, money(T.net_paid)), h('td', { class: 'num' }, `${same} of ${c.length}`));
    }));
    drawMonths();

    // held-back lines (suspicious): choose to include
    const held = res.months.flatMap((m) => m.lines).filter((l) => l.warnings.some((w) => w.suspicious));
    const heldPanel = held.length ? h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, 'Held back'),
      h('p', { class: 'small muted' }, 'These rows look wrong, so they are imported as "left out" (not counted in totals). Tick a row to count it as it stands. You can fix it later by reopening the month.'))),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ['Count it', 'Month', 'Employee', 'Gross', 'Why'].map((x, i) => h('th', { class: i === 3 ? 'num' : '' }, x)))),
        h('tbody', {}, held.map((l) => {
          const cb = h('input', { type: 'checkbox', 'aria-label': `Count ${l.emp_name} ${monthLabel(l.period)}` });
          cb.addEventListener('change', () => { l.excluded = !cb.checked; drawFacts(); drawMonths(); });
          return h('tr', { class: 'flag' }, h('td', {}, cb), h('td', {}, monthLabel(l.period)), h('td', {}, l.emp_name), h('td', { class: 'num' }, money(l.gross)),
            h('td', { class: 'small' }, l.warnings.filter((w) => w.suspicious).map((w) => w.text).join(' ')));
        }))))) : null;

    // engine comparison detail
    const diffs = res.months.flatMap((m) => (cmp.get(m.period) || []).filter((x) => x.diffs.length).map((x) => ({ ...x, period: m.period })));
    // one main cause per line, in order of what drives the rest
    const causeOf = (d) => {
      const f = new Set(d.diffs.map((x) => x.field));
      if (f.has('missing')) return 'missing';
      if (f.has('overtime')) return 'overtime';
      if (f.has('basic') || f.has('unpaid')) return 'basic';
      if (f.has('other')) return 'other';
      return 'statutory';
    };
    const CAUSES = {
      overtime: ['Overtime rule', 'The app pays overtime at the Employment Act rate (basic ÷ 26 ÷ normal hours). The workbook mixed ÷ working days ÷ 9 hours (normal OT) and ÷ 26 ÷ 8 (public holiday). Gross, EPF, SOCSO and EIS follow from it.'],
      basic: ['Basic pay or unpaid leave', 'The salary history or the part-month / unpaid-leave days in the app give a different basic for that month.'],
      other: ['Recurring allowances', 'An allowance recorded in the app (with its start and end dates) differs from what the workbook paid that month.'],
      statutory: ['Statutory only (same gross)', 'Same pay, different EPF / SOCSO / EIS: a payment type switch (ang bao: the workbook charged EPF and EIS on it in January), the SOCSO opt-out (the app applies today\'s setting; the workbook switched it on from July for some staff), or the age-60 rule (the workbook used age as at today, not the pay month).'],
      missing: ['Not employed that month in the app', 'Paid in a month outside the employment dates recorded in the app (e.g. after the last working day).'],
    };
    const byCause = {}; for (const d of diffs) { const c = causeOf(d); byCause[c] = (byCause[c] || 0) + 1; }
    const cmpPanel = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, 'New engine vs workbook'),
      h('p', { class: 'small muted' }, `${s.lines - diffs.length} of ${s.lines} lines come out identical. One-off items (bonus, commission, MVC, A1–A3, ang bao, buy-back) are taken from the workbook for this check, so only the calculation rules are compared. Nothing here changes what is imported.`))),
      h('div', { class: 'panel-body' }, h('ul', {}, Object.entries(byCause).sort((a, b) => b[1] - a[1]).map(([c, k]) => h('li', { style: 'margin-bottom:.5rem' }, h('b', {}, `${CAUSES[c][0]}: ${k} line(s). `), h('span', { class: 'small' }, CAUSES[c][1]))))),
      diffs.length ? h('details', { style: 'padding:0 1.2rem 1rem' }, h('summary', { class: 'linkish' }, `Show all ${diffs.length} lines that differ`),
        h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, ['Month', 'Employee', 'Cause', 'What differs (workbook → app)'].map((x) => h('th', {}, x)))),
          h('tbody', {}, diffs.map((d) => h('tr', {}, h('td', { class: 'nowrap' }, monthLabel(d.period)), h('td', {}, d.line.emp_name), h('td', { class: 'small' }, CAUSES[causeOf(d)][0]),
            h('td', { class: 'small' }, d.diffs.map((x) => `${x.label} ${money(x.wb)} → ${money(x.app)}`).join(' · ')))))))) : null);

    const go = h('button', { class: 'btn primary', type: 'button' }, 'Import past months');
    go.addEventListener('click', async () => {
      const keep = res.months.flatMap((m) => m.lines).filter((l) => l.excluded).length;
      if (!(await confirmDialog('Import past months', `Import ${s.months} months (${s.lines} lines${keep ? `, ${keep} left out` : ''}) from ${fileName} as finalised months? Months imported before are replaced.`, 'Import'))) return;
      go.disabled = true;
      const { data, error } = await ctx.sb.rpc('eppd_import_pay_history', { p: historyPayload(res.months) });
      go.disabled = false;
      if (failed(error, 'Import')) return;
      clear(out).append(h('section', { class: 'panel' }, h('div', { class: 'panel-body' }, h('h2', {}, 'Import complete'),
        h('p', { style: 'margin:.5rem 0 1rem' }, `${data.months} months and ${data.lines} pay lines imported and finalised.`),
        h('div', { class: 'side-actions' }, h('a', { class: 'btn primary', href: '#/payroll' }, 'Open monthly payroll')))));
      toast('Payroll history imported.');
    });

    clear(out).append(facts,
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Months found')),
        h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, ['Month', 'Lines', 'Gross', 'EPF', 'SOCSO', 'EIS', 'PCB', 'Net paid', 'Engine identical'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))), monthsBody))),
      heldPanel, cmpPanel,
      res.issues.length ? h('section', { class: 'panel' }, h('div', { class: 'panel-body' }, h('h2', {}, 'Not imported'), h('ul', {}, res.issues.map((i) => h('li', {}, i.message))))) : null,
      h('div', { class: 'import-bar' }, h('p', { class: 'small muted' }, 'Nothing has been saved yet.'), go));
  }
}
