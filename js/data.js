// MyPayroll-System-V2.0 · data.js — shared loaders
import { prepareTables } from './engines/statutory.js';

/** Fetch every row of a query, 1000 at a time (Supabase caps a single response). */
export async function fetchAll(buildQuery, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return out;
}

/** Load all statutory versions with their brackets, ready for engines/statutory.js. */
export async function loadStatTables(sb) {
  const versions = await fetchAll(() => sb.from('eppd_stat_versions').select('*').order('scheme').order('variant').order('effective_from'));
  const brackets = await fetchAll(() => sb.from('eppd_stat_brackets').select('*').order('id'));
  const byVersion = new Map(versions.map((v) => [v.id, { ...v, brackets: [] }]));
  for (const b of brackets) byVersion.get(b.version_id)?.brackets.push(b);
  return prepareTables({ versions: [...byVersion.values()] });
}

export async function loadPolicy(sb, key) {
  const { data, error } = await sb.from('eppd_policies').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  return data?.value || null;
}

/** Companies, departments, job titles, pick-lists and payment types in one go (for forms and labels). */
export async function loadRef(sb) {
  const [companies, departments, jobTitles, lookups, paymentTypes, policies] = await Promise.all([
    sb.from('eppd_companies').select('id,code,name,short_name,eid_prefix,is_active,is_primary,sort_order').order('sort_order').order('id'),
    sb.from('eppd_departments').select('id,code,name,is_active,sort_order').order('sort_order').order('code'),
    fetchAll(() => sb.from('eppd_job_titles').select('id,name,is_active,sort_order').order('name')),
    fetchAll(() => sb.from('eppd_lookups').select('category,code,label,meta,is_active,sort_order').order('sort_order').order('label')),
    sb.from('eppd_payment_types').select('id,code,name,kind,category,is_active,sort_order').order('sort_order'),
    sb.from('eppd_policies').select('key,value'),
  ]);
  for (const r of [companies, departments, paymentTypes, policies]) if (r.error) throw r.error;
  const lk = {};
  for (const l of lookups) (lk[l.category] ||= []).push(l);
  const label = (cat, code) => (lk[cat] || []).find((l) => l.code === code)?.label || code || '';
  const options = (cat, current) => (lk[cat] || []).filter((l) => l.is_active || l.code === current).map((l) => [l.code, l.label]);
  const confMeta = Object.fromEntries((lk.confirmation_status || []).map((l) => [l.code, { label: l.label, is_active_employment: l.meta?.is_active_employment !== false }]));
  return {
    companies: companies.data, departments: departments.data, jobTitles, lookups, lk, paymentTypes: paymentTypes.data,
    policies: Object.fromEntries((policies.data || []).map((p) => [p.key, p.value])),
    label, options, confMeta,
    company: (id) => companies.data.find((c) => c.id === id),
    department: (id) => departments.data.find((d) => d.id === id),
    jobTitle: (id) => jobTitles.find((t) => t.id === id),
  };
}
