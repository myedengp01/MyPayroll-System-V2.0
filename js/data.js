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
