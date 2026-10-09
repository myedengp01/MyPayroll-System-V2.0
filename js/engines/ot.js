// MyPayroll-System-V2.0 · engines/ot.js — overtime categories (Employment Act) and OTCF conversion

export const OT_CATEGORIES = {
  OT_NORMAL: { label: 'Normal day OT', pay: '1.5× hourly rate per hour' },
  OT_OFFDAY: { label: 'Off day (Saturday) OT', pay: '1.5× hourly rate per hour' },
  RD_HALF:   { label: 'Rest day, up to half a day', pay: 'Half a day’s pay' },
  RD_FULL:   { label: 'Rest day, more than half a day', pay: 'One day’s pay' },
  RD_EXCESS: { label: 'Rest day, beyond normal hours', pay: '2× hourly rate per hour' },
  PH_NORMAL: { label: 'Public holiday, normal hours', pay: 'Two days’ pay' },
  PH_EXCESS: { label: 'Public holiday, beyond normal hours', pay: '3× hourly rate per hour' },
  PT_HOURS:  { label: 'Part-time hours worked', pay: 'Hourly rate per hour' },
};

const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** Normal daily working hours = (work to − work from) − meal break; default 8 if not recorded. */
export function normalHours(em, fallback = 8) {
  const a = toMin(em?.work_from), b = toMin(em?.work_to);
  if (a === null || b === null || b <= a) return fallback;
  return r2((b - a) / 60 - Number(em?.meal_hours ?? 1));
}

/** Names as typed in OTCF -> comparable key. */
export const normaliseName = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9@'\s]/g, ' ').replace(/\s+/g, ' ').trim();

/** OTCF line date 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'D' (day of month) -> ISO. */
export function otcfDate(raw, year, month) {
  const s = String(raw || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (m) return s;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{1,2})$/.exec(s); if (m && year && month) return `${year}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/**
 * Split one OTCF line into Employment Act categories.
 * line: { claimType:'Normal'|'Off Day'|'Rest Day'|'Public Holiday', ph:boolean, actualHrs, totalHrs }
 * Rest day:  up to half the normal hours -> RD_HALF; more than half -> RD_FULL (capped at normal hours); beyond -> RD_EXCESS.
 * Public holiday (or PH ticked): up to normal hours -> PH_NORMAL; beyond -> PH_EXCESS.
 */
export function classifyOtcfLine(line, normal) {
  const hrs = r2(Number(line.actualHrs ?? line.totalHrs) || 0);
  if (hrs <= 0) return [];
  const type = String(line.claimType || '').toLowerCase();
  if (line.ph || type.startsWith('public')) {
    const n = Math.min(hrs, normal);
    return [{ category: 'PH_NORMAL', hours: r2(n) }, ...(hrs > normal ? [{ category: 'PH_EXCESS', hours: r2(hrs - normal) }] : [])];
  }
  if (type.startsWith('rest')) {
    const within = Math.min(hrs, normal);
    const out = [{ category: within <= normal / 2 ? 'RD_HALF' : 'RD_FULL', hours: r2(within) }];
    if (hrs > normal) out.push({ category: 'RD_EXCESS', hours: r2(hrs - normal) });
    return out;
  }
  if (type.startsWith('off')) return [{ category: 'OT_OFFDAY', hours: hrs }];
  if (type.startsWith('normal')) return [{ category: 'OT_NORMAL', hours: hrs }];
  return [];
}

/**
 * Turn approved OTCF submissions into time entries.
 * subs: [{ id, serial_no, emp_name, month, year, line_items:[…] }]
 * resolve(name) -> employee or null; normalFor(employee) -> hours
 * Returns { entries:[…], unmatched:[{ name, submissions }], skipped:number }
 */
export function otcfToEntries(subs, resolve, normalFor) {
  const entries = []; const unmatched = new Map(); let skipped = 0;
  for (const s of subs) {
    const emp = resolve(s.emp_name);
    if (!emp) { const k = normaliseName(s.emp_name); if (!unmatched.has(k)) unmatched.set(k, { name: s.emp_name, key: k, submissions: [] }); unmatched.get(k).submissions.push(s); continue; }
    const normal = normalFor(emp);
    (s.line_items || []).forEach((li, idx) => {
      const parts = classifyOtcfLine(li, normal);
      const date = otcfDate(li.date, s.year, s.month);
      if (!parts.length || !date) { if (Number(li.actualHrs ?? li.totalHrs) > 0) skipped++; return; }
      for (const p of parts) entries.push({
        employee_id: emp.id, work_date: date, category: p.category, hours: p.hours,
        from_time: li.from || null, to_time: li.to || null,
        otcf_submission_id: String(s.id), otcf_serial: s.serial_no || null, otcf_line: idx,
        note: [`OTCF ${s.serial_no || s.id}`, li.claimType, li.remarks].filter(Boolean).join(' · '),
      });
    });
  }
  return { entries, unmatched: [...unmatched.values()], skipped };
}
