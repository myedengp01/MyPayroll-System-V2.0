// MyPayroll-System-V2.0 · engines/eid.js — Employee ID rules (mirrors the EID Generator sheet)
// Format: PREFIX + MM + YY (join date) + gender letter + 4-digit running number, e.g. MEG0325F0118.
// The running number is ONE sequence across the whole group (all companies, all prefixes).

const ID_RE = /^([A-Z]+)(\d{2})(\d{2})([MF])(\d{4})$/;

export function parseEmpId(id) {
  const m = ID_RE.exec(String(id ?? '').trim().toUpperCase());
  if (!m) return null;
  const month = Number(m[2]);
  return { prefix: m[1], mm: m[2], yy: m[3], gender: m[4], serial: Number(m[5]), hasRealMonth: month >= 1 && month <= 12 };
}
export const isEmpIdFormat = (id) => !!parseEmpId(id);

/** Serial that counts toward the running number (IDs like MEG0000M1000 do not). */
export function serialOf(id) {
  const p = parseEmpId(id);
  return p && p.hasRealMonth ? p.serial : null;
}

export function formatEmpId({ prefix = 'MEG', joinDate, gender, serial }) {
  if (!joinDate || !gender || !serial) return null;
  const [y, m] = String(joinDate).split('-');
  return `${String(prefix || 'MEG').toUpperCase()}${m}${y.slice(2)}${String(gender).trim().toUpperCase()[0]}${String(serial).padStart(4, '0')}`;
}

export function nextSerial(serials) {
  let max = 0;
  for (const s of serials) if (Number.isFinite(s) && s > max) max = s;
  return max + 1;
}

/**
 * Checks the EID Generator sheet used to do, for a list of people.
 * people: [{ id, emp_id, gender, join_date, full_name }]
 * Returns { duplicates:[{emp_id, people}], badFormat:[], missing:[], monthMismatch:[], genderMismatch:[], nextSerial, gaps }
 */
export function auditIds(people) {
  const byId = new Map(); const out = { duplicates: [], badFormat: [], missing: [], monthMismatch: [], genderMismatch: [] };
  const serials = [];
  for (const p of people) {
    if (!p.emp_id) { out.missing.push(p); continue; }
    const key = p.emp_id.toUpperCase();
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(p);
    const parsed = parseEmpId(key);
    if (!parsed) { out.badFormat.push(p); continue; }
    if (parsed.hasRealMonth) serials.push(parsed.serial);
    if (parsed.hasRealMonth && p.join_date && (parsed.mm !== p.join_date.slice(5, 7) || parsed.yy !== p.join_date.slice(2, 4))) out.monthMismatch.push(p);
    if (p.gender && parsed.gender !== p.gender) out.genderMismatch.push(p);
  }
  for (const [emp_id, list] of byId) if (list.length > 1) out.duplicates.push({ emp_id, people: list });
  out.nextSerial = nextSerial(serials);
  const set = new Set(serials);
  out.gaps = [];
  for (let i = 1; i < out.nextSerial; i++) if (!set.has(i)) out.gaps.push(i);
  return out;
}
