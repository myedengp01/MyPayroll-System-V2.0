// One-time import of 2026 leave / OT / part-time hours from the MEG-EPPD workbook (admin)
import { h, clear, pageHead, toast, failed, confirmDialog } from '../ui.js';
import { loadRef } from '../data.js';
import { loadPeople } from '../leave-data.js';
import { buildLeaveImport, ALMC_SHEET, STAFF_SHEET, PAYROLL_SHEET } from '../engines/leaveimport.js';
import { todayIso } from '../engines/employee.js';

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
  const year = Number(todayIso().slice(0, 4));
  const ref = await loadRef(ctx.sb);
  const [people, prior] = await Promise.all([loadPeople(ctx.sb, ref),
    ctx.sb.from('eppd_leave_records').select('id', { count: 'exact', head: true }).eq('source', 'import')]);
  el.append(pageHead('Import leave from workbook', `Reads ${year} leave, replacement leave, AL buy-back, overtime and part-time hours from ${ALMC_SHEET}, the ${year - 1} brought-forward balance from ${STAFF_SHEET}, and checks the result against ${PAYROLL_SHEET}.`));
  if (!people.length) { el.append(h('div', { class: 'empty-state' }, 'Import employees first (People › Import from workbook).')); return; }
  if (prior.count) el.append(h('p', { class: 'setup-warning', style: 'margin-bottom:1rem' }, `${prior.count} leave records were imported before. Importing again replaces everything that came from the workbook; leave and hours entered in the app are kept.`));
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
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', sheets: [ALMC_SHEET, STAFF_SHEET, PAYROLL_SHEET] });
      const res = buildLeaveImport(wb.Sheets, people.map((p) => ({ id: p.id, full_name: p.full_name, gender: p.gender, employment: p.employment })), ref.policies, { year });
      status.textContent = `${f.name} read.`;
      preview(res, f.name);
    } catch (e) { status.textContent = ''; toast(e.message || String(e), 'error', 7000); }
    finally { pick.disabled = false; fileIn.value = ''; }
  });

  function preview(res, fileName) {
    const s = res.summary;
    clear(out).append(
      h('div', { class: 'facts' }, [[s.people, 'people with data'], [s.records, 'monthly leave totals'], [s.adjustments, 'balances & buy-backs'], [s.time, 'OT / part-time entries'], [s.unmatched, 'unmatched names']]
        .map(([n, l]) => h('div', { class: `fact ${l === 'unmatched names' && n ? 'bad' : ''}` }, h('b', {}, n), h('span', {}, l)))),
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, `Check against ${PAYROLL_SHEET} (${s.reconMonth?.slice(0, 7)})`),
        h('p', { class: 'small muted' }, `Annual leave taken matches the workbook for ${s.takenMatches} of ${s.reconRows} people. Rows with differences are highlighted with the reason.`))),
        h('div', { class: 'table-wrap' }, h('table', { class: 'data recon' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Employee'), ['Entitled', 'Brought fwd', 'Replacement', 'Taken', 'Balance', 'Sick leave'].map((t) => h('th', { class: 'num' }, t)), h('th', {}, 'Difference'))),
          h('tbody', {}, res.recon.map((r) => {
            const cell = (a, b) => h('td', { class: `num ${Math.abs((a ?? 0) - (b ?? 0)) > 0.01 ? 'diff' : ''}` }, h('span', { class: 'muted' }, a ?? 0), ' → ', h('b', {}, b ?? 0));
            return h('tr', { class: r.reasons.length ? 'flag' : '' }, h('td', {}, r.name),
              cell(r.wb.entitled, r.app.entitled), cell(r.wb.bf, r.app.bf), cell(r.wb.rl, r.app.rl), cell(r.wb.taken, r.app.taken), cell(r.wb.balance, r.app.balance), cell(r.wb.slTotal, r.app.slTotal),
              h('td', { class: 'small' }, r.reasons.join('; '), r.app.needsHours ? h('div', { class: 'muted' }, 'Part-timer: add weekly hours to pro-rate') : null));
          })))),
        h('p', { class: 'small muted', style: 'padding:.8rem 1.2rem' }, 'Each cell shows workbook → app. The app calculates entitlements; the workbook used typed figures, which were left at 0 for many newer staff. Balance includes replacement leave, as the workbook did.')),
      res.issues.length ? h('section', { class: 'panel' }, h('div', { class: 'panel-body' }, h('h2', {}, 'Not imported'), h('ul', {}, res.issues.map((i) => h('li', {}, i.message))))) : null);
    const go = h('button', { class: 'btn primary', type: 'button' }, 'Import leave and hours');
    go.addEventListener('click', async () => {
      if (!(await confirmDialog('Import leave and hours', `Import ${s.records} leave totals, ${s.adjustments} balances/buy-backs and ${s.time} overtime/part-time entries from ${fileName}? Anything imported earlier from the workbook is replaced; nothing entered in the app is touched.`, 'Import'))) return;
      go.disabled = true;
      const { data, error } = await ctx.sb.rpc('eppd_import_leave', { p: res.payload });
      go.disabled = false;
      if (failed(error, 'Import')) return;
      clear(out).append(h('section', { class: 'panel' }, h('div', { class: 'panel-body' }, h('h2', {}, 'Import complete'),
        h('p', { style: 'margin:.5rem 0 1rem' }, `${data.leave_records} leave totals, ${data.adjustments} balances and buy-backs, ${data.time_entries} overtime/part-time entries.`),
        h('div', { class: 'side-actions' }, h('a', { class: 'btn primary', href: '#/leave/balances' }, 'View leave balances'), h('a', { class: 'btn', href: `#/time?month=${todayIso().slice(0, 7)}` }, 'Overtime & hours')))));
      toast('Leave imported.');
    });
    out.append(h('div', { class: 'import-bar' }, h('p', { class: 'small muted' }, 'Nothing has been saved yet.'), go));
  }
}
