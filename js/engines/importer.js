// MyPayroll-System-V2.0 · engines/importer.js
// Turns the MEG-EPPD workbook (StaffPersonalData + PayrollSMRY2026) into an import payload.
// Pure: takes SheetJS sheet objects (plain { 'B6': {v, t} } maps) + reference data; no DOM, no network.

import { excelSerialToIso, excelFractionToTime, normaliseNric, addDays, lastDayOfMonth, salaryForMonth } from './employee.js';
import { parseEmpId, serialOf, formatEmpId, nextSerial } from './eid.js';

export const STAFF_SHEET = 'StaffPersonalData';
export const PAYROLL_SHEET = 'PayrollSMRY2026';

export const ISSUE_TITLES = {
  no_company: 'Current staff with no company', rehire: 'Rehires merged into one person', no_id: 'No Employee ID in the workbook',
  id_generated: 'Employee ID generated', bad_id: 'ID cell holds text such as N/A', assumed_hourly: 'Small amounts treated as hourly rates',
  salary_before_join: 'Starting salary re-dated', undated_salary: 'Undated salary dated from the first month paid',
  undated_salary_skipped: 'Undated salary not imported', no_join: 'No join date', no_join_salary: 'Starting salary with no date',
  multi_dept: 'More than one department', unknown_dept: 'Department not in the list', unknown_company: 'Company name not recognised',
  no_gender: 'No gender recorded', gender: 'Gender not recognised', same_date_salary: 'Two salaries on the same date',
  payroll_mismatch: 'Months where the workbook paid a different salary', resigned_before_join: 'Resigned before the join date',
  id_month: 'ID month differs from the join date', id_gender: 'ID gender letter differs from the record',
  same_nric_two_ids: 'Same NRIC under two IDs', paid_after_last_day: 'Paid after their last working day', no_salary: 'Current staff with no salary', unmapped_allowance: 'Allowance with no matching payment type',
};

const STAFF_COLS = ['B', 'G', 'L', 'Q', 'R', 'Y', 'AE', 'AK', 'AU', 'AZ', 'BE', 'BJ', 'BK', 'BT', 'BU', 'CD', 'CI', 'CN',
  'CP', 'CS', 'CX', 'DC', 'DD', 'DF', 'DG', 'DH', 'DQ', 'DR', 'DW', 'EB', 'ED', 'EE', 'EF', 'EG', 'EH', 'EI', 'EJ', 'EK',
  'EL', 'EM', 'EN', 'EO', 'EP', 'EQ', 'FK', 'FU', 'QR', 'QS', 'QT', 'QU', 'QV', 'QW', 'QX', 'QY', 'QZ', 'RA', 'RB', 'RC', 'TO'];
const PAY_COLS = ['O', 'U', 'KZ', 'LF', 'LR', 'RV', 'SH', 'ST', 'TF', 'TR', 'UD', 'TM'];
const INCREMENTS = [['ED', 'EE'], ['EF', 'EG'], ['EH', 'EI'], ['EJ', 'EK'], ['EL', 'EM'], ['EN', 'EO'], ['EP', 'EQ']];
const ALLOWANCE_COLS = [['QR', 'QS', 'LEADER'], ['QT', 'QU', 'FIRST_AID'], ['QV', 'QW', 'SKM1'], ['QX', 'QY', 'SKM2'], ['QZ', 'RA', 'TRANSPORT'], ['RB', 'RC', null]];
const BLANKS = new Set(['', 'N/A', 'NA', '-', '0', 'NIL', 'NONE']);

const val = (sheet, addr) => { const c = sheet[addr]; return c && c.t !== 'e' && c.v !== undefined && c.v !== null ? c.v : null; };
const txt = (v) => { if (v === null || v === undefined) return null; const s = String(v).trim().replace(/\s+/g, ' '); return BLANKS.has(s.toUpperCase()) ? null : s; };
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : null));
const date = (v) => (typeof v === 'number' ? excelSerialToIso(v) : null);
const digits = (v) => { if (v === null || v === undefined) return null; if (typeof v === 'number') return String(Math.round(v)); const s = txt(v); return s ? s.replace(/\s/g, '') : null; };
const codeOf = (s) => String(s).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
const normCompany = (s) => String(s || '').toLowerCase().replace(/sdn\.?\s*bhd\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const cleanName = (s) => String(s || '').toUpperCase().replace(/\s*\((OLD|1ST EMPLOYED|[^)]*EMPLOYED[^)]*)\)\s*$/i, '').replace(/\s+/g, ' ').trim();

/** Read the two sheets into row objects keyed by column letter. */
export function readSheets(sheets) {
  const staffSheet = sheets[STAFF_SHEET];
  if (!staffSheet) throw new Error(`Sheet “${STAFF_SHEET}” was not found in this file.`);
  const staff = [];
  for (let r = 6; r <= 2000; r++) {
    const name = txt(val(staffSheet, `B${r}`));
    if (!name) { if (r > 400) break; continue; }
    const row = { _row: r };
    for (const c of STAFF_COLS) row[c] = val(staffSheet, `${c}${r}`);
    staff.push(row);
  }
  const pay = [];
  const paySheet = sheets[PAYROLL_SHEET];
  if (paySheet) {
    for (let r = 10; r <= 5000; r++) {
      const name = txt(val(paySheet, `U${r}`)); const month = date(val(paySheet, `O${r}`));
      if (!name || !month) { if (r > 1200) break; continue; }
      const row = { _row: r, month: month.slice(0, 7) + '-01', name: name.toUpperCase() };
      for (const c of PAY_COLS) row[c] = val(paySheet, `${c}${r}`);
      pay.push(row);
    }
  }
  return { staff, pay, hasPayroll: !!paySheet };
}

// ---- reference-data matching ------------------------------------------------
const ALIASES = {
  job_status: { 'FULL TIME': 'FT', 'FULLTIME': 'FT', 'PARTIME': 'PT', 'PART TIME': 'PT', 'PART-TIME': 'PT', 'TEMPORARY': 'TEMP', 'INTERNSHIP': 'INTERN', 'INTERN': 'INTERN' },
  bank: { 'AMBANK': 'AMBANK', 'AFFIN': 'AFFIN', 'AFFIN BANK': 'AFFIN', 'TNG': 'TNG', 'TOUCH N GO': 'TNG', 'MAYBANK': 'MBB', 'PUBLIC BANK': 'PBB', 'HONG LEONG': 'HLB', 'RYT': 'RYT' },
};
function makeLookupMatcher(lookups) {
  const byCat = {};
  for (const l of lookups) {
    const m = (byCat[l.category] ||= { code: new Map(), label: new Map() });
    m.code.set(String(l.code).toUpperCase(), l.code); m.label.set(String(l.label).toUpperCase(), l.code);
  }
  const created = new Map(); // `${cat}|${code}` -> lookup row
  return {
    created,
    match(category, raw, metaForNew) {
      const s = txt(raw); if (!s) return null;
      const up = s.toUpperCase(); const m = byCat[category] || { code: new Map(), label: new Map() };
      if (m.code.has(up)) return m.code.get(up);
      if (m.label.has(up)) return m.label.get(up);
      const alias = ALIASES[category]?.[up];
      if (alias && m.code.has(alias)) return m.code.get(alias);
      const code = alias || codeOf(s);
      if (m.code.has(code)) return m.code.get(code);
      const key = `${category}|${code}`;
      if (!created.has(key)) created.set(key, { category, code, label: s, meta: metaForNew ? metaForNew(s) : {} });
      return code;
    },
  };
}

/**
 * Build the import.
 * ref = { companies:[{code,name,short_name,eid_prefix}], departments:[{code}], jobTitles:[{name}],
 *         lookups:[{category,code,label,meta}], paymentTypes:[{code}] }
 * options = { defaultCompanyCode, keepIdFor: { [empId]: personKey }, generateMissingIds:false, today }
 */
export function buildImport(sheets, ref, options = {}) {
  const { staff, pay, hasPayroll } = readSheets(sheets);
  const issues = [];
  const issue = (level, code, message, person = null, extra = {}) => issues.push({ level, code, message, person, ...extra });
  const lk = makeLookupMatcher(ref.lookups || []);

  // companies
  const companyByNorm = new Map();
  for (const c of ref.companies || []) for (const k of [c.name, c.short_name, c.code]) if (k) companyByNorm.set(normCompany(k), c);
  const defaultCompany = (ref.companies || []).find((c) => c.code === options.defaultCompanyCode) || (ref.companies || [])[0];
  const deptCodes = new Map((ref.departments || []).map((d) => [String(d.code).toUpperCase(), d.code]));
  const titleByUpper = new Map((ref.jobTitles || []).map((t) => [t.name.toUpperCase(), t.name]));
  const newTitles = new Map();
  const ptCodes = new Set((ref.paymentTypes || []).map((p) => p.code));

  // ---- 1. rows -> stints ----
  const stints = staff.map((r) => {
    const rawId = txt(r.G); const id = rawId && parseEmpId(rawId) ? rawId.toUpperCase() : null;
    if (rawId && !id) issue('info', 'bad_id', `Employee ID “${rawId}” is not a valid ID; imported without an ID.`, r.B);
    return { r, rowName: txt(r.B).toUpperCase(), name: cleanName(txt(r.B)), empId: id, nric: normaliseNric(txt(r.Q)),
             join: date(r.CD), resigned: date(r.CS) };
  });

  // ---- 2. group stints into people (same NRIC + same/compatible ID = rehire) ----
  const parent = stints.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byNric = new Map();
  stints.forEach((s, i) => { if (s.nric) { if (!byNric.has(s.nric)) byNric.set(s.nric, []); byNric.get(s.nric).push(i); } });
  for (const [nric, idx] of byNric) {
    for (let a = 1; a < idx.length; a++) {
      const A = stints[idx[0]], B = stints[idx[a]];
      if (!A.empId || !B.empId || A.empId === B.empId) parent[find(idx[a])] = find(idx[0]);
      else issue('check', 'same_nric_two_ids', `${A.name}: NRIC ${nric} appears with two IDs (${A.empId}, ${B.empId}); imported as two people.`, A.name);
    }
  }
  const groups = new Map();
  stints.forEach((s, i) => { const g = find(i); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); });
  const people = [...groups.values()].map((list) => {
    list.sort((a, b) => (a.join || '0000').localeCompare(b.join || '0000') || a.r._row - b.r._row);
    const latest = list[list.length - 1];
    const ids = [...new Set(list.map((s) => s.empId).filter(Boolean))];
    const key = `row${latest.r._row}`;
    if (list.length > 1) issue('info', 'rehire', `${latest.name}: ${list.length} employment periods merged into one person (rehire).`, latest.name);
    return { key, stints: list, latest, name: latest.name, empId: ids[0] || null };
  });

  // ---- 3. ID conflicts between different people ----
  const isCurrent = (p) => { const s = p.latest; const code = String(s.r.CI || '').toUpperCase(); return !['R', 'TR', 'DM'].includes(code) && !(s.resigned && s.resigned < (options.today || '9999')); };
  const byId = new Map();
  for (const p of people) if (p.empId) { if (!byId.has(p.empId)) byId.set(p.empId, []); byId.get(p.empId).push(p); }
  const conflicts = [];
  let serialCursor = nextSerial(people.map((p) => serialOf(p.empId)).filter((s) => s !== null));
  const prefixFor = (p) => {
    const c = companyByNorm.get(normCompany(txt(p.latest.r.DQ))) || defaultCompany;
    return c?.eid_prefix || 'MEG';
  };
  for (const [empId, list] of byId) {
    if (list.length < 2) continue;
    const ranked = list.slice().sort((a, b) => (isCurrent(b) - isCurrent(a)) || (b.latest.join || '').localeCompare(a.latest.join || ''));
    const keeperKey = options.keepIdFor?.[empId] && list.some((p) => p.key === options.keepIdFor[empId]) ? options.keepIdFor[empId] : ranked[0].key;
    const conflict = { empId, keeperKey, options: list.map((p) => ({ key: p.key, name: p.name, join: p.latest.join, current: isCurrent(p) })), changes: [] };
    for (const p of list) {
      if (p.key === keeperKey) continue;
      const serial = serialCursor++;
      const newId = formatEmpId({ prefix: prefixFor(p), joinDate: p.latest.join || '2000-01-01', gender: txt(p.latest.r.AK) || 'F', serial });
      conflict.changes.push({ key: p.key, name: p.name, from: empId, to: newId });
      p.empId = newId;
    }
    conflicts.push(conflict);
  }
  for (const p of people) if (!p.empId) {
    if (options.generateMissingIds && p.latest.join && txt(p.latest.r.AK)) {
      p.empId = formatEmpId({ prefix: prefixFor(p), joinDate: p.latest.join, gender: txt(p.latest.r.AK), serial: serialCursor++ });
      issue('info', 'id_generated', `${p.name}: no ID in the workbook; generated ${p.empId}.`, p.name);
    } else issue('info', 'no_id', `${p.name}: no Employee ID in the workbook (you can generate one later).`, p.name);
  }

  // ---- 4. payroll rows by name ----
  const payByName = new Map();
  for (const row of pay) { if (!payByName.has(row.name)) payByName.set(row.name, []); payByName.get(row.name).push(row); }
  const stintForPay = (p, month) => {
    let best = null;
    for (const s of p.stints) if (!s.join || s.join <= lastDayOfMonth(month)) best = s;
    return best || p.stints[p.stints.length - 1];
  };

  // ---- 5. build payload ----
  const payload = { source: 'MEG-EPPD workbook', lookups: [], job_titles: [], people: [] };
  const counts = { people: 0, employments: 0, assignments: 0, salary: 0, allowances: 0, current: 0, defaultCompany: 0, defaultCompanyCurrent: 0 };
  const payrollChecks = [];

  for (const p of people) {
    const rows = p.stints.map((s) => s.r);
    const pick = (col, f = txt) => { let v = null; for (const r of rows) { const x = f(r[col]); if (x !== null && x !== undefined) v = x; } return v; };
    const remarks = pick('TO', (v) => (typeof v === 'string' ? txt(v) : null));
    const person = {
      key: p.key, emp_id: p.empId, emp_serial: serialOf(p.empId), full_name: p.name,
      chinese_name: pick('L'), gender: (pick('AK') || '').toUpperCase().slice(0, 1) || null,
      nationality: lk.match('nationality', pick('Y'), (s) => ({ stat_class: /PR/i.test(s) ? 'PR' : /malaysia/i.test(s) ? 'MY' : 'FR' })),
      race: lk.match('race', pick('AE')), marital_status: lk.match('marital_status', pick('BT')),
      email: pick('BE'), phone: pick('AZ', (v) => (v === null ? null : txt(String(v)))), remarks,
      private: {
        nric: normaliseNric(pick('Q')) || pick('Q'), dob: pick('R', date), home_address: pick('AU'), spouse_name: pick('BU'),
        bank_code: lk.match('bank', pick('BJ')), bank_account_no: pick('BK', digits), epf_no: pick('FK', digits), tax_no: pick('FU'),
      },
      employments: [],
    };
    if (person.gender && !['F', 'M'].includes(person.gender)) { issue('check', 'gender', `${p.name}: gender “${person.gender}” not recognised; left blank.`, p.name); person.gender = null; }
    if (!person.gender) issue('check', 'no_gender', `${p.name}: no gender recorded.`, p.name);

    const personPay = [...new Set([p.name, ...p.stints.map((s) => s.rowName)])].flatMap((n) => payByName.get(n) || []);
    for (const s of p.stints) {
      const r = s.r;
      const confCode = (txt(r.CI) || 'UP').toUpperCase();
      // department
      let deptRaw = txt(r.DW); let dept = null;
      if (deptRaw) {
        const first = deptRaw.split(/[,/]/)[0].trim().toUpperCase();
        if (deptRaw.includes(',') || deptRaw.includes('/')) issue('check', 'multi_dept', `${p.name}: department “${deptRaw}”; imported as ${first}.`, p.name);
        dept = deptCodes.get(first) || null;
        if (!dept) issue('check', 'unknown_dept', `${p.name}: department “${deptRaw}” is not in the list; left blank.`, p.name);
      }
      // job title
      let title = txt(r.DR);
      if (title) { const known = titleByUpper.get(title.toUpperCase()); if (known) title = known; else { newTitles.set(title.toUpperCase(), title); titleByUpper.set(title.toUpperCase(), title); } }
      // company
      const compRaw = txt(r.DQ);
      let company = compRaw ? companyByNorm.get(normCompany(compRaw)) : null;
      const current = !['R', 'TR', 'DM'].includes(confCode);
      if (!company) {
        company = defaultCompany; counts.defaultCompany++; if (current) counts.defaultCompanyCurrent++;
        if (compRaw) issue('check', 'unknown_company', `${p.name}: company “${compRaw}” not recognised; set to ${company.short_name || company.name}.`, p.name);
        else if (current) issue('decision', 'no_company', `${p.name}: no company recorded; set to ${company.short_name || company.name}.`, p.name);
      }

      // statutory flags from the latest payroll row for this stint
      const stintPay = personPay.filter((row) => stintForPay(p, row.month) === s).sort((a, b) => a.month.localeCompare(b.month));
      const lastPay = stintPay[stintPay.length - 1];
      const yn = (v, dflt = true) => (v === 'Y' ? true : v === 'N' ? false : dflt);
      const flags = lastPay ? {
        epf_ee: yn(lastPay.RV), epf_er: yn(lastPay.SH), socso_ee: yn(lastPay.ST), socso_er: yn(lastPay.TF),
        eis_ee: yn(lastPay.TR), eis_er: yn(lastPay.UD), socso_nei_opt_out: lastPay.TM === 'Y',
      } : {};

      // salary history
      const paidRows = (amount) => stintPay.filter((row) => Math.abs((num(row.LF) ?? -1) - amount) < 0.005);
      const firstPaid = (amount) => paidRows(amount)[0]?.month || null;
      const basisFor = (amount) => {
        // the most recent payroll month that paid this amount decides (the workbook's "HRP ?" column)
        const rowsPaid = paidRows(amount); const latest = rowsPaid[rowsPaid.length - 1];
        if (latest) return latest.LR === 'Y' ? 'hourly' : 'monthly';
        if (amount < 100) { issue('check', 'assumed_hourly', `${p.name}: salary RM${amount} looks like an hourly rate; imported as hourly.`, p.name); return 'hourly'; }
        return 'monthly';
      };
      const entries = [];
      const incs = INCREMENTS.map(([a, d], i) => ({ amount: num(r[a]), date: date(r[d]), slot: i + 2 })).filter((x) => x.amount !== null && x.amount > 0);
      for (const inc of incs) {
        let eff = inc.date; let note = null;
        if (!eff) {
          eff = firstPaid(inc.amount);
          if (eff) { note = 'Date taken from the first payroll month that paid it'; issue('check', 'undated_salary', `${p.name}: salary RM${inc.amount} had no date; dated ${eff} (first month paid).`, p.name); }
          else { issue('check', 'undated_salary_skipped', `${p.name}: salary RM${inc.amount} has no date and was never paid in the workbook; not imported.`, p.name); continue; }
        }
        entries.push({ effective_from: eff, amount: inc.amount, pay_basis: basisFor(inc.amount), reason: `Salary ${inc.slot} (workbook)`, note, slot: inc.slot });
      }
      const base = num(r.EB);
      if (base !== null && base > 0) {
        let eff = s.join; let note = null;
        const earliestInc = entries.reduce((m, e) => (!m || e.effective_from < m ? e.effective_from : m), null);
        if (earliestInc && (!eff || earliestInc <= eff)) {
          eff = addDays(earliestInc, -1); note = 'Dated just before the first increment (increment is dated on/before the join date)';
          issue('check', 'salary_before_join', s.join
            ? `${p.name}: an increment is dated ${earliestInc}, on or before the join date ${s.join}; starting salary dated ${eff}.`
            : `${p.name}: no join date; starting salary dated ${eff}, the day before the first increment.`, p.name);
        }
        if (!eff) { eff = firstPaid(base); if (eff) note = 'Date taken from the first payroll month that paid it'; }
        if (eff) entries.push({ effective_from: eff, amount: base, pay_basis: basisFor(base), reason: 'Starting salary (workbook)', note, slot: 1 });
        else issue('check', 'no_join_salary', `${p.name}: starting salary RM${base} has no join date to date it; not imported.`, p.name);
      } else if (current) issue('check', 'no_salary', `${p.name}: no basic salary recorded.`, p.name);
      // one record per date: later slot wins
      const byDate = new Map();
      for (const e of entries.sort((a, b) => a.slot - b.slot)) {
        if (byDate.has(e.effective_from)) issue('check', 'same_date_salary', `${p.name}: two salaries dated ${e.effective_from}; kept RM${e.amount}.`, p.name);
        byDate.set(e.effective_from, e);
      }
      const salary = [...byDate.values()].sort((a, b) => a.effective_from.localeCompare(b.effective_from)).map(({ slot, ...e }) => e);

      // allowances
      const allowances = [];
      for (const [a, d, code] of ALLOWANCE_COLS) {
        const amount = num(r[a]); if (!amount) continue;
        if (!code || !ptCodes.has(code)) { issue('check', 'unmapped_allowance', `${p.name}: allowance RM${amount} in column ${a} has no matching payment type; not imported.`, p.name); continue; }
        allowances.push({ payment_type_code: code, amount, start_date: s.join, end_date: date(r[d]), note: 'Imported from workbook' });
      }

      // compare with what the workbook actually paid
      for (const row of stintPay) {
        const lf = num(row.LF); if (lf === null) continue;
        const got = salaryForMonth(salary, row.month);
        const basis = row.LR === 'Y' ? 'hourly' : 'monthly';
        const ok = got && Math.abs(got.amount - lf) < 0.005 && got.pay_basis === basis;
        payrollChecks.push({ name: p.name, month: row.month, paid: lf, paidBasis: basis, history: got?.amount ?? null, historyBasis: got?.pay_basis ?? null, ok: !!ok });
      }

      if (s.resigned) {
        const after = stintPay.filter((row) => row.month > s.resigned).map((row) => row.month.slice(0, 7));
        if (after.length) issue('check', 'paid_after_last_day', `${p.name}: last working day ${s.resigned}, but the workbook paid them in ${after.join(', ')}. If they stayed on in a new role, add a new employment period.`, p.name);
      }
      let asgEnd = s.resigned;
      if (s.join && s.resigned && s.resigned < s.join) {
        asgEnd = null;
        issue('check', 'resigned_before_join', `${p.name}: resigned date ${s.resigned} is before the join date ${s.join} (row ${r._row}); please correct.`, p.name);
      }
      for (const a of allowances) if (a.start_date && a.end_date && a.end_date < a.start_date) a.start_date = null;

      const notes = [`Imported from ${STAFF_SHEET} row ${r._row}`];
      if (s.rowName !== p.name) notes.push(`Workbook name: ${s.rowName}`);
      person.employments.push({
        join_date: s.join, confirmation_status: confCode, confirmed_date: date(r.CN),
        job_status: lk.match('job_status', r.CX), department_code: dept, job_title: title,
        work_from: excelFractionToTime(num(r.DC)), work_to: excelFractionToTime(num(r.DD)),
        meal_hours: num(r.DF), ot_days: num(r.DG), ot_multiplier: num(r.DH),
        resignation_letter_date: date(r.CP), resigned_date: s.resigned, notes: notes.join('. '),
        assignments: [{ company_code: company.code, is_primary: true, start_date: s.join, end_date: asgEnd, ...flags, salary, allowances }],
      });
      if (!s.join) issue('check', 'no_join', `${p.name}: no join date (row ${r._row}).`, p.name);
      counts.employments++; counts.assignments++; counts.salary += salary.length; counts.allowances += allowances.length;
    }
    const lastStint = p.stints[p.stints.length - 1];
    if (!['R', 'TR', 'DM'].includes(String(lastStint.r.CI || '').toUpperCase())) counts.current++;
    counts.people++;
    payload.people.push(person);
  }

  // info: IDs whose month or gender letter differs from the record
  for (const pr of payload.people) {
    const parsed = parseEmpId(pr.emp_id); const j = pr.employments[pr.employments.length - 1]?.join_date;
    if (parsed?.hasRealMonth && j && (parsed.mm !== j.slice(5, 7) || parsed.yy !== j.slice(2, 4)) && pr.employments.length === 1)
      issue('info', 'id_month', `${pr.full_name}: ID ${pr.emp_id} does not match join month ${j.slice(0, 7)} (kept as is).`, pr.full_name);
    if (parsed && pr.gender && parsed.gender !== pr.gender)
      issue('info', 'id_gender', `${pr.full_name}: ID ${pr.emp_id} has gender letter ${parsed.gender} but the record says ${pr.gender} (kept as is).`, pr.full_name);
  }

  payload.lookups = [...lk.created.values()];
  payload.job_titles = [...newTitles.values()];
  const mismatches = payrollChecks.filter((c) => !c.ok);
  for (const m of mismatches) issue('check', 'payroll_mismatch',
    `${m.name}, ${m.month.slice(0, 7)}: workbook paid RM${m.paid}${m.paidBasis === 'hourly' ? '/hr' : ''}; salary history gives ${m.history === null ? 'nothing' : 'RM' + m.history + (m.historyBasis === 'hourly' ? '/hr' : '')}.`, m.name);

  return {
    payload, issues, conflicts,
    summary: { ...counts, staffRows: staff.length, payrollRows: pay.length, hasPayroll,
               newLookups: payload.lookups.length, newJobTitles: payload.job_titles.length,
               payrollMonthsChecked: payrollChecks.length, payrollMatched: payrollChecks.length - mismatches.length,
               defaultCompanyCode: defaultCompany?.code },
  };
}
