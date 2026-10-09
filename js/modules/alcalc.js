// AL calculator: period-by-period breakdown (replaces the AL CALCULATOR sheet)
import { h, clear, pageHead, field, fmtDate } from '../ui.js';
import { loadRef } from '../data.js';
import { loadPeople } from '../leave-data.js';
import { alPeriods, proRate } from '../engines/leave.js';
import { todayIso } from '../engines/employee.js';

export async function render(el, ctx, params, query) {
  const ref = await loadRef(ctx.sb);
  const people = await loadPeople(ctx.sb, ref);
  const bands = ref.policies.al_entitlement?.bands || [{ until_months: 24, days: 8 }, { until_months: 60, days: 12 }, { until_months: null, days: 16 }];
  const thisYear = Number(todayIso().slice(0, 4));
  const F = {
    emp: field('Employee (or leave blank and type dates)', { type: 'select', value: query.emp || '',
      options: [['', '— Enter dates by hand —'], ...people.filter((p) => p.employment?.join_date).map((p) => [p.id, `${p.full_name}${p.emp_id ? ` (${p.emp_id})` : ''}${p.status.key === 'former' ? ' · left' : ''}`])], span2: true }),
    join: field('Date joined', { type: 'date' }),
    resign: field('Last working day (if leaving)', { type: 'date' }),
    year: field('Leave year', { type: 'number', value: query.year || thisYear }),
    hours: field('Part-time weekly hours (blank = full-time)', { type: 'number', step: '0.5' }),
  };
  const out = h('div', {});
  el.append(pageHead('AL calculator', 'Annual leave entitlement for joiners, current staff and leavers, using your rule: 8 / 12 / 16 days by service band, split by calendar year and band, a month counts if service starts by the 15th or ends on or after the 15th, each period rounded half up.'),
    h('section', { class: 'panel' }, h('div', { class: 'panel-body' }, h('div', { class: 'form-grid' }, Object.values(F)))), out);

  const fill = () => {
    const p = people.find((x) => String(x.id) === String(F.emp.getValue()));
    if (p) { F.join.input.value = p.employment.join_date || ''; F.resign.input.value = p.employment.resigned_date || ''; F.hours.input.value = p.employment.job_status === 'PT' ? (p.employment.weekly_hours ?? '') : ''; }
  };
  F.emp.input.addEventListener('change', () => { fill(); calc(); });
  Object.values(F).slice(1).forEach((f) => f.input.addEventListener('input', calc));

  function calc() {
    const join = F.join.getValue(), resign = F.resign.getValue(), year = F.year.getValue();
    clear(out);
    if (!join || !year) { out.append(h('div', { class: 'empty-state' }, 'Choose an employee or enter the date joined.')); return; }
    const periods = alPeriods({ joinDate: join, resignDate: resign, bands, toYear: year });
    const inYear = periods.filter((p) => Number(p.end.slice(0, 4)) === year);
    const total = inYear.reduce((s, p) => s + p.entitled, 0);
    const pt = F.hours.getValue();
    const pro = pt ? proRate(total, pt, ref.policies.part_time) : null;
    const bandName = (d) => (d === bands[0].days ? 'First 2 years' : d === bands[1]?.days ? '2nd to 5th year' : '5 years and above');
    out.append(
      h('div', { class: 'facts' }, h('div', { class: 'fact big' }, h('b', {}, pro ?? total), h('span', {}, `days annual leave for ${year}`)),
        pro !== null ? h('div', { class: 'fact' }, h('b', {}, total), h('span', {}, `full-time days × ${pt} ÷ ${ref.policies.part_time?.full_time_weekly_hours || 45} hours`)) : null),
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'How it is worked out')),
        h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, ['Service band', 'From', 'To', 'Months counted', 'Days a year', 'Exact', 'Rounded', ''].map((t, i) => h('th', { class: i >= 3 && i <= 6 ? 'num' : '' }, t)))),
          h('tbody', {}, periods.map((p) => {
            const counts = Number(p.end.slice(0, 4)) === year;
            return h('tr', { class: counts ? 'hit' : 'inactive' }, h('td', {}, bandName(p.days)), h('td', {}, fmtDate(p.start)), h('td', {}, fmtDate(p.end)),
              h('td', { class: 'num' }, p.months), h('td', { class: 'num' }, p.days), h('td', { class: 'num' }, p.raw.toFixed(2)), h('td', { class: 'num strong' }, p.entitled),
              h('td', { class: 'small muted' }, counts ? `counts for ${year}` : ''));
          })))),
        h('p', { class: 'small muted', style: 'padding:.8rem 1.2rem' }, 'A period that starts and ends in the same month counts as 1 month only if it starts on or before the 15th and ends on or after the 15th (AL CALCULATOR v.042026).')));
  }
  if (query.emp) fill();
  calc();
}
