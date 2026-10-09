// HR policies: notice period, AL entitlement bands, OT defaults, statutory rules
import { h, clear, pageHead, toast, failed, fmtDate, field } from '../ui.js';
import { computeNotice } from '../engines/notice.js';
import { gradeOrder } from '../engines/leave.js';

export async function render(el, ctx) {
  const isAdmin = ctx.can(['admin']);
  const { data, error } = await ctx.sb.from('eppd_policies').select('*');
  if (failed(error, 'Load')) return;
  const P = Object.fromEntries((data || []).map((r) => [r.key, r]));
  el.append(pageHead('HR policies', 'Company rules the app applies automatically. Changes take effect for calculations made after saving.'));
  if (!isAdmin) el.append(h('p', { class: 'setup-warning', style: 'margin-bottom:1rem' }, 'Only admins can change policies.'));

  async function save(key, value, label) {
    const { error: e } = await ctx.sb.from('eppd_policies').upsert({ key, value, description: P[key]?.description || null });
    if (failed(e)) return false;
    P[key] = { ...(P[key] || {}), key, value };
    toast(`${label} saved.`); return true;
  }
  const num = (v, w = '6rem') => { const i = h('input', { type: 'number', min: 0, step: 'any', style: `width:${w}`, disabled: !isAdmin }); i.value = v ?? ''; return i; };

  // ---------------- notice period
  const notice = structuredClone(P.notice_period?.value || { basis: 'contract', probation_weeks: 4, bands: [] });
  const nBody = h('div', {});
  const preview = h('p', { class: 'small', style: 'margin-top:.8rem' });
  const pv = { join: field('Date joined', { type: 'date', value: '2023-01-02' }), letter: field('Resignation letter date', { type: 'date', value: new Date().toISOString().slice(0, 10) }),
    prob: field('Still on probation', { type: 'switch' }) };
  function runPreview() {
    const r = computeNotice({ joinDate: pv.join.getValue(), letterDate: pv.letter.getValue(), onProbation: pv.prob.getValue() }, notice);
    preview.textContent = r ? `${r.years} completed year(s) → ${r.weeks} weeks (${r.days} days) · last day ${fmtDate(r.noticeEnd)}` : 'Enter both dates.';
  }
  Object.values(pv).forEach((f) => { f.input.addEventListener('input', runPreview); f.input.addEventListener('change', runPreview); });
  function drawNotice() {
    const probIn = num(notice.probation_weeks);
    probIn.addEventListener('input', () => { notice.probation_weeks = Number(probIn.value); runPreview(); });
    clear(nBody).append(
      h('label', { class: 'check-row', style: 'margin-bottom:1rem' }, 'Employees on probation:', probIn, 'weeks'),
      h('table', { class: 'data', style: 'max-width:560px' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Service from (years)'), h('th', {}, 'to under (years)'), h('th', {}, 'Notice (weeks)'), isAdmin ? h('th', {}) : null)),
        h('tbody', {}, notice.bands.map((b, i) => {
          const f = num(b.from_years), t = num(b.to_years), w = num(b.weeks);
          t.placeholder = 'no limit';
          f.addEventListener('input', () => { b.from_years = Number(f.value); runPreview(); });
          t.addEventListener('input', () => { b.to_years = t.value === '' ? null : Number(t.value); runPreview(); });
          w.addEventListener('input', () => { b.weeks = Number(w.value); runPreview(); });
          return h('tr', {}, h('td', {}, f), h('td', {}, t), h('td', {}, w),
            isAdmin ? h('td', {}, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { notice.bands.splice(i, 1); drawNotice(); runPreview(); } }, 'Remove')) : null);
        }))),
      isAdmin ? h('div', { class: 'side-actions', style: 'margin-top:.8rem' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => { const last = notice.bands[notice.bands.length - 1]; notice.bands.push({ from_years: last?.to_years ?? 0, to_years: null, weeks: 4 }); drawNotice(); } }, 'Add band'),
        h('button', { class: 'btn sm primary', type: 'button', onclick: () => {
          notice.bands.sort((a, b) => a.from_years - b.from_years);
          save('notice_period', notice, 'Notice period');
        } }, 'Save notice period')) : null);
  }
  drawNotice();
  el.append(h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, 'Notice period'),
      h('p', { class: 'small muted' }, 'By completed years of service on the resignation letter date (company contract terms).'))),
    h('div', { class: 'panel-body grid-2' }, nBody,
      h('div', {}, h('h3', { style: 'margin-bottom:.6rem' }, 'Try it'), h('div', { style: 'display:grid;gap:.7rem' }, pv.join, pv.letter, pv.prob), preview))));
  runPreview();

  // ---------------- AL entitlement
  const al = structuredClone(P.al_entitlement?.value || { bands: [] });
  const alBody = h('div', {});
  function drawAL() {
    clear(alBody).append(
      h('table', { class: 'data', style: 'max-width:480px' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Service up to (months)'), h('th', {}, 'Days per year'))),
        h('tbody', {}, al.bands.map((b) => {
          const m = num(b.until_months), d = num(b.days); m.placeholder = 'and above';
          m.addEventListener('input', () => { b.until_months = m.value === '' ? null : Number(m.value); });
          d.addEventListener('input', () => { b.days = Number(d.value); });
          return h('tr', {}, h('td', {}, m), h('td', {}, d));
        }))),
      h('p', { class: 'small muted', style: 'margin-top:.8rem;max-width:70ch' },
        `A month counts when service starts on or before day ${al.start_day_counts_if_lte ?? 15}, or ends on or after day ${al.end_day_counts_if_gte ?? 15}. ` +
        'Entitlement = days × counted months ÷ 12, rounded half up. Same rule as the workbook AL calculator.'),
      isAdmin ? h('button', { class: 'btn sm primary', type: 'button', style: 'margin-top:.8rem', onclick: () => save('al_entitlement', al, 'Annual leave bands') }, 'Save annual leave bands') : null);
  }
  drawAL();
  el.append(h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Annual leave entitlement')), h('div', { class: 'panel-body' }, alBody)));

  // ---------------- OT defaults + statutory rules
  const ot = structuredClone(P.ot_defaults?.value || {});
  const sr = structuredClone(P.statutory_rules?.value || {});
  const otF = {
    working_days_per_month: field('Working days per month (daily rate divisor)', { type: 'number', value: ot.working_days_per_month }),
    normal_ot_multiplier: field('Normal-day OT multiplier', { type: 'number', value: ot.normal_ot_multiplier, step: '0.1' }),
    meal_break_hours: field('Meal break (hours)', { type: 'number', value: ot.meal_break_hours, step: '0.25' }),
  };
  const srF = {
    eis_exempt_age_60_plus: field('Stop EIS for employees aged 60 and above', { type: 'switch', value: sr.eis_exempt_age_60_plus }),
    eis_exempt_foreign: field('Stop EIS for foreign employees', { type: 'switch', value: sr.eis_exempt_foreign }),
  };
  [...Object.values(otF), ...Object.values(srF)].forEach((f) => { f.input.disabled = !isAdmin; });
  el.append(h('div', { class: 'grid-2', style: 'margin-top:1.25rem' },
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, 'Overtime defaults'),
      h('p', { class: 'small muted' }, 'Starting values for new employees; each person can differ.'))),
      h('div', { class: 'panel-body', style: 'display:grid;gap:.8rem' }, Object.values(otF),
        isAdmin ? h('button', { class: 'btn sm primary', type: 'button', style: 'justify-self:start', onclick: () =>
          save('ot_defaults', Object.fromEntries(Object.entries(otF).map(([k, f]) => [k, f.getValue()])), 'Overtime defaults') }, 'Save overtime defaults') : null)),
    h('section', { class: 'panel', style: 'margin-top:0' }, h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, 'Statutory rules'),
      h('p', { class: 'small muted' }, 'Both off = same as the old workbook.'))),
      h('div', { class: 'panel-body', style: 'display:grid;gap:.8rem' }, Object.values(srF),
        isAdmin ? h('button', { class: 'btn sm primary', type: 'button', style: 'justify-self:start', onclick: () =>
          save('statutory_rules', Object.fromEntries(Object.entries(srF).map(([k, f]) => [k, f.getValue()])), 'Statutory rules') }, 'Save statutory rules') : null))));

  // ---------------- Phase 3: leave rules
  const panel = (title, desc, ...kids) => h('section', { class: 'panel', style: 'margin-top:1.25rem' },
    h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, title), desc ? h('p', { class: 'small muted' }, desc) : null)), h('div', { class: 'panel-body' }, kids));
  const saveBtn = (label, fn) => (isAdmin ? h('button', { class: 'btn sm primary', type: 'button', style: 'margin-top:.9rem', onclick: fn }, label) : null);
  const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // working week
  const ww = structuredClone(P.working_week?.value || { rest_days: [0], off_days: [6] });
  const dayRow = DOW.map((d, i) => {
    const sel = h('select', { disabled: !isAdmin, 'aria-label': d, style: 'width:auto' },
      [['work', 'Working day'], ['off', 'Off day'], ['rest', 'Rest day']].map(([v, l]) => h('option', { value: v, selected: (ww.rest_days.includes(i) ? 'rest' : ww.off_days.includes(i) ? 'off' : 'work') === v }, l)));
    sel.addEventListener('change', () => {
      ww.rest_days = ww.rest_days.filter((x) => x !== i); ww.off_days = ww.off_days.filter((x) => x !== i);
      if (sel.value === 'rest') ww.rest_days.push(i); if (sel.value === 'off') ww.off_days.push(i);
    });
    return h('label', { class: 'field' }, d, sel);
  });
  el.append(panel('Working week', 'Off days and rest days are not counted as leave days. Work on them is overtime: off day at 1.5×, rest day under the Employment Act rest-day rule.',
    h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(auto-fill,minmax(150px,1fr))' }, dayRow),
    saveBtn('Save working week', () => save('working_week', ww, 'Working week'))));

  // leave entitlements
  const lr = structuredClone(P.leave_rules?.value || {});
  const n = (v, onset, w = '5rem') => { const i = num(v, w); i.addEventListener('input', () => onset(i.value === '' ? null : Number(i.value))); return i; };
  const slBands = lr.SL?.bands || [];
  el.append(panel('Leave entitlements', 'Employment Act minimums by default. Annual leave bands are set above.',
    h('table', { class: 'data', style: 'max-width:640px' }, h('tbody', {},
      h('tr', {}, h('td', {}, 'Sick leave, under 2 years'), h('td', {}, n(slBands[0]?.days, (v) => { slBands[0].days = v; }), ' days')),
      h('tr', {}, h('td', {}, 'Sick leave, 2 to under 5 years'), h('td', {}, n(slBands[1]?.days, (v) => { slBands[1].days = v; }), ' days')),
      h('tr', {}, h('td', {}, 'Sick leave, 5 years and above'), h('td', {}, n(slBands[2]?.days, (v) => { slBands[2].days = v; }), ' days')),
      h('tr', {}, h('td', {}, 'Hospitalisation pool (includes sick leave)'), h('td', {}, n(lr.HPL?.days, (v) => { lr.HPL = { ...(lr.HPL || {}), days: v }; }), ' days a year')),
      h('tr', {}, h('td', {}, 'Maternity (consecutive)'), h('td', {}, n(lr.MTL?.days, (v) => { lr.MTL = { ...(lr.MTL || {}), days: v }; }), ' days')),
      h('tr', {}, h('td', {}, 'Paternity (consecutive)'), h('td', {}, n(lr.PTL?.days, (v) => { lr.PTL = { ...(lr.PTL || {}), days: v }; }), ' days, after ',
        n(lr.PTL?.min_service_months, (v) => { lr.PTL = { ...(lr.PTL || {}), min_service_months: v }; }, '4rem'), ' months')),
      h('tr', {}, h('td', {}, 'Compassionate leave'), h('td', {}, n(lr.CPL?.per_occasion, (v) => { lr.CPL = { ...(lr.CPL || {}), per_occasion: v }; }, '4rem'), ' days per occasion, up to ',
        n(lr.CPL?.per_year, (v) => { lr.CPL = { ...(lr.CPL || {}), per_year: v }; }, '4rem'), ' a year')))),
    saveBtn('Save leave entitlements', () => save('leave_rules', lr, 'Leave entitlements'))));

  // carry forward
  const cf = structuredClone(P.carry_forward?.value || { confirmed_only: true, grades: {}, buyback_grades: [], buyback_options: [], expiry: null });
  const labels = cf.grade_labels || {};
  const expiryIn = h('input', { type: 'text', placeholder: 'e.g. 06-30', value: cf.expiry || '', disabled: !isAdmin, style: 'width:7rem', 'aria-label': 'Expiry MM-DD' });
  const optsIn = h('input', { type: 'text', value: (cf.buyback_options || []).join(', '), disabled: !isAdmin, style: 'width:12rem', 'aria-label': 'Buy-back options' });
  el.append(panel('Annual leave carry forward', 'Applied at Year-end close. Only confirmed staff carry leave; unused days above the cap are bought back (if the grade allows and you choose a rate) or forfeited.',
    h('table', { class: 'data', style: 'max-width:640px' },
      h('thead', {}, h('tr', {}, h('th', {}, 'KPI grade'), h('th', {}, 'Carry up to'), h('th', {}, 'Buy-back allowed'))),
      h('tbody', {}, gradeOrder(cf.grades).map((g) => {
        const chk = h('input', { type: 'checkbox', disabled: !isAdmin, 'aria-label': `Buy-back for ${g}` }); chk.checked = (cf.buyback_grades || []).includes(g);
        chk.addEventListener('change', () => { cf.buyback_grades = chk.checked ? [...new Set([...(cf.buyback_grades || []), g])] : (cf.buyback_grades || []).filter((x) => x !== g); });
        return h('tr', {}, h('td', {}, `${g} · ${labels[g] || ''}`), h('td', {}, n(cf.grades[g], (v) => { cf.grades[g] = v ?? 0; }, '4rem'), ' days'), h('td', {}, chk));
      }))),
    h('div', { class: 'form-grid', style: 'margin-top:1rem;max-width:640px' },
      h('label', { class: 'field' }, 'Buy-back rates offered (% of daily rate)', optsIn, h('span', { class: 'small muted' }, 'Comma separated. A custom rate can also be typed at year end.')),
      h('label', { class: 'field' }, 'Carried leave expires on (MM-DD of the next year)', expiryIn, h('span', { class: 'small muted' }, 'Leave blank for no expiry.'))),
    saveBtn('Save carry-forward rules', () => {
      const ex = expiryIn.value.trim();
      if (ex && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(ex)) { toast('Expiry must look like 06-30.', 'error'); return; }
      cf.expiry = ex || null;
      cf.buyback_options = optsIn.value.split(',').map((x) => Number(x.trim())).filter((x) => x > 0 && x <= 100);
      save('carry_forward', cf, 'Carry-forward rules');
    })));

  // part-time
  const pt = structuredClone(P.part_time?.value || { full_time_weekly_hours: 45, prorate: ['AL', 'SL'] });
  el.append(panel('Part-time staff', 'Annual and sick leave for part-timers = full-time days × their weekly hours ÷ full-time weekly hours, rounded half up. Set each part-timer’s weekly hours in their Employment tab.',
    h('label', { class: 'check-row' }, 'Full-time weekly hours', n(pt.full_time_weekly_hours, (v) => { pt.full_time_weekly_hours = v; })),
    saveBtn('Save part-time rule', () => save('part_time', pt, 'Part-time rule'))));
}
