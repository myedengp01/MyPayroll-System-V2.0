// MyPayroll-System-V2.0 · engines/statutory.js
// Pure functions only (no DOM, no Supabase) so they can be tested in Node.
//
// tables = { versions: [ { id, scheme, variant, effective_from:'YYYY-MM-DD',
//            is_active, rule, above_max, brackets:[{wage_min,wage_max,er,ee,ee_inv,ee_nei}] } ] }

const num = (x) => (x === null || x === undefined || x === '' ? null : Number(x));
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

/** Latest active version of scheme/variant whose effective_from <= periodDate. */
export function pickVersion(tables, scheme, variant, periodDate) {
  const d = String(periodDate).slice(0, 10);
  let best = null;
  for (const v of tables.versions || []) {
    if (v.scheme !== scheme || v.variant !== variant) continue;
    if (v.is_active === false) continue;
    const eff = String(v.effective_from).slice(0, 10);
    if (eff > d) continue;
    if (!best || eff > String(best.effective_from).slice(0, 10)) best = v;
  }
  return best;
}

/**
 * Excel-style approximate match (VLOOKUP ..., TRUE): the bracket with the
 * largest wage_min that is <= wage. Returns null when wage is below every bracket.
 */
export function lookupBracket(brackets, wage) {
  if (!brackets || !brackets.length) return null;
  const w = Number(wage);
  let lo = 0, hi = brackets.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (num(brackets[mid].wage_min) <= w + 1e-9) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans < 0 ? null : brackets[ans];
}

export function roundAmount(x, mode) {
  if (mode === 'up_ringgit') return Math.ceil(r2(x) - 1e-9);
  if (mode === 'up_cent') return Math.ceil(x * 100 - 1e-9) / 100;
  if (mode === 'nearest_cent') return r2(x);
  return x; // 'none' – identical to the workbook's unrounded RS × 2%
}

function applyPercent(wage, rule) {
  return {
    er: roundAmount(wage * (Number(rule.er_pct) || 0) / 100, rule.round),
    ee: roundAmount(wage * (Number(rule.ee_pct) || 0) / 100, rule.round),
  };
}

/** Sort brackets once (tables loaded from Supabase may come in any order). */
export function prepareTables(tables) {
  for (const v of tables.versions || []) {
    v.brackets = (v.brackets || []).slice().sort((a, b) => num(a.wage_min) - num(b.wage_min));
  }
  return tables;
}

function fromVersion(v, wage) {
  if (!v) return { er: 0, ee: 0, missing: true };
  if (v.rule) return { ...applyPercent(wage, v.rule), versionId: v.id, label: v.label };
  const last = v.brackets[v.brackets.length - 1];
  if (v.above_max && last && last.wage_max !== null && wage > num(last.wage_max)) {
    return { ...applyPercent(wage, v.above_max), versionId: v.id, label: v.label, aboveMax: true };
  }
  const b = lookupBracket(v.brackets, wage);
  if (!b) return { er: 0, ee: 0, versionId: v.id, label: v.label };
  return {
    er: num(b.er) || 0, ee: num(b.ee) || 0,
    ee_inv: num(b.ee_inv), ee_nei: num(b.ee_nei),
    versionId: v.id, label: v.label, bracket: b,
  };
}

/**
 * EPF.  statClass: 'MY' | 'PR' | 'FR' (from the nationality list).
 * Order follows the workbook: foreign first, then age 60+, else standard.
 */
export function computeEPF(tables, { wage, age, statClass, periodDate }) {
  const w = Math.max(0, Number(wage) || 0);
  const variant = statClass === 'FR' ? 'FOREIGN' : (Number(age) >= 60 ? 'AGE60' : 'STD');
  const res = fromVersion(pickVersion(tables, 'EPF', variant, periodDate), w);
  return { variant, er: res.er, ee: res.ee, versionId: res.versionId, label: res.label,
           aboveMax: !!res.aboveMax, missing: !!res.missing };
}

/**
 * SOCSO.  Age 60+ = Second Category (employer only before Jun 2026; NEI share after).
 * neiOptOut: employee pays the invalidity portion only (workbook column "Opt Out Lindung 24").
 */
export function computeSOCSO(tables, { wage, age, periodDate, neiOptOut = false }) {
  const w = Math.max(0, Number(wage) || 0);
  const variant = Number(age) >= 60 ? 'CAT2' : 'CAT1';
  const res = fromVersion(pickVersion(tables, 'SOCSO', variant, periodDate), w);
  let ee = res.ee;
  if (neiOptOut && res.ee_inv !== null && res.ee_inv !== undefined) ee = res.ee_inv;
  return { variant, er: res.er, ee, ee_inv: res.ee_inv ?? null, ee_nei: res.ee_nei ?? null,
           versionId: res.versionId, label: res.label, missing: !!res.missing };
}

/** EIS.  rules = statutory_rules policy (exemptions are off by default = workbook behaviour). */
export function computeEIS(tables, { wage, age, statClass, periodDate }, rules = {}) {
  const w = Math.max(0, Number(wage) || 0);
  if ((rules.eis_exempt_age_60_plus && Number(age) >= 60) ||
      (rules.eis_exempt_foreign && statClass === 'FR')) {
    return { er: 0, ee: 0, exempt: true };
  }
  const res = fromVersion(pickVersion(tables, 'EIS', 'STD', periodDate), w);
  return { er: res.er, ee: res.ee, versionId: res.versionId, label: res.label, missing: !!res.missing };
}

/**
 * Build the three statutory wage bases from payroll lines using each
 * payment type's own switches.  lines: [{ amount, type:{kind, subject_epf, subject_socso, subject_eis} }]
 * Deductions ticked for a scheme reduce that base (e.g. unpaid leave).
 */
export function statutoryBases(lines) {
  const base = { epf: 0, socso: 0, eis: 0 };
  for (const l of lines || []) {
    const t = l.type || {};
    const amt = (Number(l.amount) || 0) * (t.kind === 'deduction' ? -1 : 1);
    if (t.subject_epf) base.epf += amt;
    if (t.subject_socso) base.socso += amt;
    if (t.subject_eis) base.eis += amt;
  }
  return { epf: r2(Math.max(0, base.epf)), socso: r2(Math.max(0, base.socso)), eis: r2(Math.max(0, base.eis)) };
}
