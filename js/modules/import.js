// One-time import of StaffPersonalData (+ PayrollSMRY2026 for checks) from the MEG-EPPD workbook
import { h, clear, pageHead, toast, failed, confirmDialog } from '../ui.js';
import { loadRef } from '../data.js';
import { buildImport, STAFF_SHEET, PAYROLL_SHEET, ISSUE_TITLES } from '../engines/importer.js';
import { todayIso } from '../engines/employee.js';

const SHEETJS = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
let sheetjsPromise = null;
function loadSheetJS() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  sheetjsPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SHEETJS; s.async = true;
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { sheetjsPromise = null; reject(new Error('Could not load the spreadsheet reader. Check your internet connection and try again.')); };
    document.head.append(s);
  });
  return sheetjsPromise;
}

const GROUPS = {
  decision: ['Needs your decision', 'Defaults are filled in. Change them below before importing if needed.'],
  check: ['Check after importing', 'Imported as described; fix in the employee’s profile if it is wrong.'],
  info: ['For information', 'Nothing to do.'],
};

export async function render(el, ctx) {
  const { count } = await ctx.sb.from('eppd_employees').select('id', { count: 'exact', head: true });
  el.append(pageHead('Import from workbook', `Reads ${STAFF_SHEET} (and ${PAYROLL_SHEET} to check salaries) from your MEG-EPPD .xlsm file. The file is read in your browser; only the cleaned staff records are sent to the database.`));
  if (count > 0) {
    el.append(h('section', { class: 'panel' }, h('div', { class: 'panel-body' },
      h('h2', {}, `${count} employees already exist`),
      h('p', { class: 'muted', style: 'margin:.5rem 0 1rem;max-width:70ch' }, 'The import only runs once, on an empty employee list, so it can never create duplicates. To start again before going live, run sql/reset_employees.sql in Supabase, then come back here.'),
      h('a', { class: 'btn', href: '#/employees' }, 'Go to employees'))));
    return;
  }
  const ref = await loadRef(ctx.sb);
  const fileIn = h('input', { type: 'file', accept: '.xlsm,.xlsx', class: 'hidden' });
  const pick = h('button', { class: 'btn primary', type: 'button', onclick: () => fileIn.click() }, 'Choose workbook file');
  const status = h('p', { class: 'small muted', role: 'status' });
  const out = h('div', {});
  el.append(h('section', { class: 'panel' }, h('div', { class: 'panel-body drop' },
    h('p', {}, 'Choose the MEG-EPPD workbook (.xlsm). Nothing is saved until you press Import.'), pick, fileIn, status)), out);

  let sheets = null; let fileName = '';
  const opts = { defaultCompanyCode: (ref.companies.find((c) => c.is_primary) || ref.companies[0])?.code, keepIdFor: {}, today: todayIso() };

  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0]; if (!f) return;
    fileName = f.name; pick.disabled = true;
    status.textContent = `Reading ${f.name}…`;
    try {
      const XLSX = await loadSheetJS();
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', sheets: [STAFF_SHEET, PAYROLL_SHEET] });
      if (!wb.Sheets[STAFF_SHEET]) throw new Error(`This file has no “${STAFF_SHEET}” sheet. Choose the MEG-EPPD workbook.`);
      sheets = wb.Sheets;
      status.textContent = `${f.name} read.`;
      preview();
    } catch (e) {
      status.textContent = ''; toast(e.message || String(e), 'error', 7000);
    } finally { pick.disabled = false; fileIn.value = ''; }
  });

  function preview() {
    const res = buildImport(sheets, { ...ref, jobTitles: ref.jobTitles, paymentTypes: ref.paymentTypes }, opts);
    const s = res.summary;
    clear(out);
    // ---- summary
    out.append(h('div', { class: 'facts' }, [
      ['People', s.people], ['Current staff', s.current], ['Employment periods', s.employments], ['Salary records', s.salary],
      ['Allowances', s.allowances], ['New job titles', s.newJobTitles], ['New pick-list items', s.newLookups],
    ].map(([l, n]) => h('div', { class: 'fact' }, h('b', {}, n), h('span', {}, l)))));
    if (s.hasPayroll) {
      const pct = s.payrollMonthsChecked ? Math.round((s.payrollMatched / s.payrollMonthsChecked) * 1000) / 10 : 0;
      out.append(h('section', { class: 'panel' }, h('div', { class: 'panel-body' },
        h('h2', {}, 'Salary history check'),
        h('p', { style: 'margin:.4rem 0 .8rem' }, `The rebuilt salary history gives the same basic salary the workbook actually paid in `,
          h('b', {}, `${s.payrollMatched} of ${s.payrollMonthsChecked}`), ` payroll months (${pct}%). The rest are listed under “Check after importing”.`),
        h('div', { class: 'meter', role: 'img', 'aria-label': `${pct}% of payroll months match` }, h('span', { style: `width:${pct}%` })))));
    }

    // ---- decisions
    const dec = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, GROUPS.decision[0]), h('p', { class: 'small muted' }, GROUPS.decision[1]))));
    const decBody = h('div', { class: 'panel-body stack' }); dec.append(decBody);
    const compSel = h('select', { 'aria-label': 'Company for staff with none recorded', style: 'width:auto' },
      ref.companies.filter((c) => c.is_active).map((c) => h('option', { value: c.code, selected: c.code === opts.defaultCompanyCode }, c.name)));
    compSel.addEventListener('change', () => { opts.defaultCompanyCode = compSel.value; preview(); });
    const noCo = res.issues.filter((i) => i.code === 'no_company');
    decBody.append(h('div', {},
      h('h3', {}, `Company for staff with none recorded (${s.defaultCompany} people, ${s.defaultCompanyCurrent} still employed)`),
      h('p', { class: 'small muted', style: 'margin:.3rem 0 .6rem' }, `The workbook leaves the company blank for these people, so their payslips show no company. Current staff affected: ${noCo.map((i) => i.person).join(', ') || 'none'}.`),
      h('label', { class: 'check-row' }, 'Assign them to', compSel)));
    for (const c of res.conflicts) {
      const sel = h('select', { 'aria-label': `Who keeps ${c.empId}`, style: 'width:auto' },
        c.options.map((o) => h('option', { value: o.key, selected: o.key === c.keeperKey }, `${o.name}${o.current ? ' (still employed)' : ''}, joined ${o.join || '?'}`)));
      sel.addEventListener('change', () => { opts.keepIdFor[c.empId] = sel.value; preview(); });
      decBody.append(h('div', {},
        h('h3', {}, `${c.empId} is used by ${c.options.length} different people`),
        h('p', { class: 'small muted', style: 'margin:.3rem 0 .6rem' }, c.changes.map((x) => `${x.name} will get the new ID ${x.to}.`).join(' ')),
        h('label', { class: 'check-row' }, 'Keeps the existing ID:', sel)));
    }
    out.append(dec);

    // ---- issues
    for (const level of ['check', 'info']) {
      const items = res.issues.filter((i) => i.level === level);
      if (!items.length) continue;
      const byCode = new Map();
      for (const i of items) { if (!byCode.has(i.code)) byCode.set(i.code, []); byCode.get(i.code).push(i); }
      out.append(h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, `${GROUPS[level][0]} (${items.length})`), h('p', { class: 'small muted' }, GROUPS[level][1]))),
        h('div', { class: 'issue-groups' }, [...byCode.values()].map((list) => h('details', { class: 'issue-group' },
          h('summary', {}, `${ISSUE_TITLES[list[0].code] || list[0].code} `, h('span', { class: 'tag' }, list.length)),
          h('ul', {}, list.map((i) => h('li', {}, i.message))))))));
    }

    // ---- import
    const go = h('button', { class: 'btn primary', type: 'button' }, `Import ${s.people} people`);
    go.addEventListener('click', async () => {
      const ok = await confirmDialog('Import employees', `Import ${s.people} people (${s.current} current) with ${s.salary} salary records and ${s.allowances} allowances from ${fileName}? This runs once; if anything fails, nothing is saved.`, 'Import');
      if (!ok) return;
      go.disabled = true; go.textContent = 'Importing…';
      const { data, error } = await ctx.sb.rpc('eppd_import_employees', { p: res.payload });
      if (failed(error, 'Import')) { go.disabled = false; go.textContent = `Import ${s.people} people`; return; }
      clear(out).append(h('section', { class: 'panel' }, h('div', { class: 'panel-body' },
        h('h2', {}, 'Import complete'),
        h('p', { style: 'margin:.5rem 0 1rem' }, `${data.people} people, ${data.employments} employment periods, ${data.salary_records} salary records and ${data.allowances} allowances imported.`),
        h('div', { class: 'side-actions' }, h('a', { class: 'btn primary', href: '#/employees' }, 'View employees'), h('a', { class: 'btn', href: '#/employees/ids' }, 'Check Employee IDs')))));
      toast('Import complete.');
    });
    out.append(h('div', { class: 'import-bar' }, h('p', { class: 'small muted' }, 'Nothing has been saved yet.'), go));
  }
}
