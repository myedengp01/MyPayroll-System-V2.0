// MyPayroll-System-V2.0 · engines/notice.js — notice period from the company policy.
// policy = { probation_weeks, bands:[{from_years, to_years|null, weeks}] }

const parse = (d) => { const [y, m, dd] = String(d).slice(0, 10).split('-').map(Number); return { y, m, d: dd }; };
const toUTC = (p) => Date.UTC(p.y, p.m - 1, p.d);
const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Completed years between two dates (same as Excel DATEDIF(a,b,"y")). */
export function completedYears(from, to) {
  const a = parse(from), b = parse(to);
  let y = b.y - a.y;
  if (b.m < a.m || (b.m === a.m && b.d < a.d)) y -= 1;
  return Math.max(0, y);
}

/**
 * joinDate, letterDate: 'YYYY-MM-DD'. onProbation: boolean.
 * Returns { years, weeks, days, noticeEnd, basis }.
 * noticeEnd = letter date + notice days (workbook convention).
 */
export function computeNotice({ joinDate, letterDate, onProbation = false }, policy) {
  if (!joinDate || !letterDate) return null;
  const years = completedYears(joinDate, letterDate);
  let weeks, basis;
  if (onProbation) { weeks = Number(policy.probation_weeks); basis = 'probation'; }
  else {
    const band = (policy.bands || []).find((b) =>
      years >= Number(b.from_years) && (b.to_years === null || b.to_years === undefined || years < Number(b.to_years)));
    weeks = band ? Number(band.weeks) : 0;
    basis = band ? `${band.from_years}–${band.to_years ?? '∞'} yrs` : 'no band';
  }
  const days = weeks * 7;
  return { years, weeks, days, basis, noticeEnd: fmt(toUTC(parse(letterDate)) + days * 86400000) };
}
