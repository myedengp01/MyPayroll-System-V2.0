// MyPayroll-System-V2.0 · engines/pcb.js — automatic PCB (monthly tax deduction), LHDN computerised method
// Pure functions only. Every rate and relief comes from the 'pcb' policy so it can be updated each year.
//
// Normal remuneration (this month):
//   P  = [Σ(Y − K) + (Y1 − K1) + (Y2 − K2) × n] − [D + S + DU + SU + Q×C + (ΣLP + LP1)]
//   PCB_normal = [ (P − M) × R + B − (Z + X) ] ÷ (n + 1)
// Additional remuneration (bonus, commission, leave pay-out …):
//   P' = P + (Yt − Kt)                     tax' = (P' − M) × R + B
//   PCB_additional = tax' − [ X + PCB_normal × (n + 1) ] − Z
// Y2 = Y1 (this month's normal pay is assumed for the rest of the year); K, K1, K2, Kt are EPF limited to the yearly cap.
// n = months left in the year after this one. Each PCB is cut to 2 decimals, then rounded UP to the next 5 sen;
// a total below the minimum (RM10) is not deducted. Zakat paid this month is taken off the result.

export const DEFAULT_PCB = {
  reliefs: { individual: 9000, spouse: 4000, disabled: 7000, spouse_disabled: 6000, child: 2000 },
  epf_cap: 4000, socso_relief: true, socso_relief_cap: 350, non_resident_rate: 30, min_pcb: 10, rebate_limit: 35000,
  additional_categories: ['bonus', 'incentive', 'compensation'], additional_codes: ['AL_BUYBACK', 'AL_ENCASH'],
  bands: [
    { from: 0, rate: 0, b13: 0, b2: 0 }, { from: 5000, rate: 1, b13: -400, b2: -800 }, { from: 20000, rate: 3, b13: -250, b2: -650 },
    { from: 35000, rate: 6, b13: 600, b2: 600 }, { from: 50000, rate: 11, b13: 1500, b2: 1500 }, { from: 70000, rate: 19, b13: 3700, b2: 3700 },
    { from: 100000, rate: 25, b13: 9400, b2: 9400 }, { from: 400000, rate: 26, b13: 84400, b2: 84400 },
    { from: 600000, rate: 28, b13: 136400, b2: 136400 }, { from: 2000000, rate: 30, b13: 528400, b2: 528400 },
  ],
};
export const pcbPolicy = (p) => ({ ...DEFAULT_PCB, ...(p || {}), reliefs: { ...DEFAULT_PCB.reliefs, ...(p?.reliefs || {}) }, bands: (p?.bands?.length ? p.bands : DEFAULT_PCB.bands) });

const r2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const trunc2 = (x) => Math.floor(Number(x) * 100 + 1e-7) / 100;
/** Cut to 2 decimals, then round up to the next 5 sen (123.02 → 123.05, 123.06 → 123.10). */
export const roundPcb = (x) => { if (!(x > 0)) return 0; const t = trunc2(x); return Math.ceil(Math.round(t * 100) / 5 - 1e-9) * 5 / 100; };

/** Annual tax on chargeable income P for a category (M, R, B table). */
export function annualTax(P, category, pol) {
  if (!(P > 0)) return { tax: 0, band: pol.bands[0] };
  let band = pol.bands[0];
  for (const b of pol.bands) if (P > b.from) band = b;
  const B = category === 2 ? band.b2 : band.b13;
  const tax = (P - band.from) * band.rate / 100 + B;
  return { tax: Math.max(0, tax), band, M: band.from, R: band.rate, B };
}

/** Which items count as additional remuneration. */
export const isAdditional = (i, pol) => (pol.additional_categories || []).includes(i.category) || (pol.additional_codes || []).includes(i.code);

/**
 * Split a line's items into taxable normal (Y1) and additional (Yt) pay, and the EPF-subject part of each.
 * Reimbursements and personal deductions are not pay; unpaid leave reduces normal pay.
 */
export function taxablePay(items, pol, itemAmount) {
  let Y1 = 0, Yt = 0, epf1 = 0, epft = 0;
  for (const i of items || []) {
    if (i.category === 'reimbursement' || (i.kind === 'deduction' && i.category === 'personal')) continue;
    const a = itemAmount(i) * (i.kind === 'deduction' ? -1 : 1);
    const add = i.kind === 'earning' && isAdditional(i, pol);
    if (i.pcb_subject !== false) { if (add) Yt += a; else Y1 += a; }
    if (i.epf) { if (add) epft += a; else epf1 += a; }
  }
  return { Y1: r2(Math.max(0, Y1)), Yt: r2(Math.max(0, Yt)), epf1: r2(epf1), epft: r2(epft) };
}

/**
 * PCB for one month.
 * a = { month (1–12), profile, ytd:{Y,K,X,Z,LP}, Y1, Yt, epfEe (this month's employee EPF), epf1, epft (EPF-subject pay split),
 *       socsoEis (this month's employee SOCSO + EIS), zakat (this month), policy }
 * Returns { pcb (net, after zakat), gross_pcb, normal, additional, P, Padd, n, detail }
 */
export function computePCB(a) {
  const pol = pcbPolicy(a.policy);
  const pr = a.profile || {};
  const zakat = Math.max(0, Number(a.zakat) || 0);
  const Y1 = Math.max(0, Number(a.Y1) || 0), Yt = Math.max(0, Number(a.Yt) || 0);
  if (pr.resident === false) {
    const g = roundPcb((Y1 + Yt) * pol.non_resident_rate / 100);
    return { pcb: Math.max(0, r2(g - zakat)), gross_pcb: g, normal: g, additional: 0, nonResident: true, n: 12 - a.month, detail: `Non-resident: ${pol.non_resident_rate}% of RM${r2(Y1 + Yt)}` };
  }
  const ytd = { Y: 0, K: 0, X: 0, Z: 0, LP: 0, ...(a.ytd || {}) };
  const n = 12 - a.month;
  // EPF this month split between normal and additional pay
  const epfEe = Math.max(0, Number(a.epfEe) || 0);
  const epfBase = (Number(a.epf1) || 0) + (Number(a.epft) || 0);
  const Kt0 = epfBase > 0 ? epfEe * Math.max(0, Number(a.epft) || 0) / epfBase : 0;
  const K10 = epfEe - Kt0;
  // EPF relief cap for the year
  const cap = pol.epf_cap;
  const K = Math.min(ytd.K, cap);
  const K1 = Math.min(K10, Math.max(0, cap - K));
  // normal PCB does not depend on the bonus: project EPF for the rest of the year first,
  // then the bonus's EPF uses whatever is left of the cap
  const K2 = n > 0 ? Math.min(K1, Math.max(0, cap - K - K1) / n) : 0;
  // with additional pay (LHDN): Kt limited to what is left after K and K1, and the projection K2 recalculated with Kt
  const Kt = Math.min(Kt0, Math.max(0, cap - K - K1));
  const K2a = n > 0 ? Math.min(K1, Math.max(0, cap - K - K1 - Kt) / n) : 0;
  // reliefs
  const rl = pol.reliefs;
  const cat = pr.category === 2 ? 2 : pr.category === 3 ? 3 : 1;
  const D = rl.individual, S = cat === 2 ? rl.spouse : 0, DU = pr.disabled ? rl.disabled : 0, SU = pr.spouse_disabled && cat === 2 ? rl.spouse_disabled : 0;
  const QC = rl.child * Math.max(0, Number(pr.children) || 0) + Math.max(0, Number(pr.child_relief_extra) || 0);
  let LP1 = Math.max(0, Number(pr.tp1_monthly) || 0);
  let LPsocso = 0;
  if (pol.socso_relief) LPsocso = Math.min(Math.max(0, Number(a.socsoEis) || 0), Math.max(0, pol.socso_relief_cap - (ytd.LPsocso || 0)));
  LP1 += LPsocso;
  const reliefs = D + S + DU + SU + QC + (ytd.LP || 0) + LP1;
  const P = (ytd.Y - K) + (Y1 - K1) + (Y1 - K2) * n - reliefs;
  const tN = annualTax(P, cat, pol);
  let normal = (tN.tax - (ytd.Z + ytd.X)) / (n + 1);
  normal = normal > 0 ? normal : 0;
  let additional = 0, Padd = null, tA = null;
  if (Yt > 0) {
    Padd = (ytd.Y - K) + (Y1 - K1) + (Y1 - K2a) * n + (Yt - Kt) - reliefs;
    tA = annualTax(Padd, cat, pol);
    additional = tA.tax - (ytd.X + normal * (n + 1)) - ytd.Z;
    additional = additional > 0 ? additional : 0;
  }
  const normalR = roundPcb(normal), additionalR = roundPcb(additional);
  let gross_pcb = r2(normalR + additionalR);
  if (gross_pcb < pol.min_pcb) gross_pcb = 0;
  const pcb = Math.max(0, r2(gross_pcb - zakat));
  const fmt = (x) => r2(x).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const detail = [
    `Category ${cat}${pr.children ? `, ${pr.children} child(ren)` : ''}; ${n} month(s) left after this one`,
    `Chargeable income for the year P = RM${fmt(P)} → tax RM${fmt(tN.tax)} (M ${tN.M ?? 0}, R ${tN.R ?? 0}%, B ${tN.B ?? 0})`,
    `Paid so far: PCB RM${fmt(ytd.X)}${ytd.Z ? `, zakat RM${fmt(ytd.Z)}` : ''} → normal PCB RM${fmt(normalR)}`,
    Yt > 0 ? `Additional pay RM${fmt(Yt)} → P' RM${fmt(Padd)}, tax RM${fmt(tA.tax)} → additional PCB RM${fmt(additionalR)}` : null,
    gross_pcb === 0 && (normalR + additionalR) > 0 ? `Below RM${pol.min_pcb}: not deducted` : null,
    zakat ? `Less zakat this month RM${fmt(zakat)}` : null,
  ].filter(Boolean);
  return { pcb, gross_pcb, normal: normalR, additional: additionalR, P: r2(P), Padd: Padd === null ? null : r2(Padd), n, category: cat,
    epf: { K: r2(K), K1: r2(K1), K2: r2(K2), Kt: r2(Kt), K2a: r2(K2a) }, reliefs: r2(reliefs), lpSocso: r2(LPsocso), detail };
}

/** Year-to-date figures for PCB from earlier finalised lines of the same employer this year (plus previous employment). */
export function pcbYtd(prevLines, profile, year, itemAmount, pol) {
  const ytd = { Y: 0, K: 0, X: 0, Z: 0, LP: 0, LPsocso: 0 };
  const p = pcbPolicy(pol);
  for (const l of prevLines || []) {
    if (l.excluded) continue;
    const t = taxablePay(l.items, p, itemAmount);
    ytd.Y += t.Y1 + t.Yt; ytd.K += Number(l.epf_ee) || 0; ytd.X += Number(l.pcb) || 0;
    for (const i of l.items || []) if (i.code === 'ZAKAT') ytd.Z += itemAmount(i);
    const tp1 = Number(l.inputs?.pcb?.tp1) || 0; ytd.LP += tp1;
    const s = Number(l.inputs?.pcb?.lp_socso);
    ytd.LPsocso += Number.isFinite(s) ? s : Math.min((Number(l.socso_ee) || 0) + (Number(l.eis_ee) || 0), Math.max(0, p.socso_relief_cap - ytd.LPsocso));
  }
  if (profile && Number(profile.prev_year) === Number(year)) {
    ytd.Y += Number(profile.prev_gross) || 0; ytd.K += Number(profile.prev_epf) || 0;
    ytd.X += Number(profile.prev_pcb) || 0; ytd.Z += Number(profile.prev_zakat) || 0;
  }
  ytd.LP += ytd.LPsocso;   // SOCSO/EIS relief already claimed counts towards ΣLP
  for (const k of Object.keys(ytd)) ytd[k] = r2(ytd[k]);
  return ytd;
}
