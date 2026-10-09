// MyPayroll-System-V2.0 · megforms.js — read-only connection to the MEG-FORMS project (OTCF claims).
// Separate sign-in and storage key, so it never affects your payroll session.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import * as cfg from './config.js';

export const megformsConfigured = !!(cfg.MEGFORMS_URL && cfg.MEGFORMS_ANON_KEY);
export const mf = megformsConfigured ? createClient(cfg.MEGFORMS_URL, cfg.MEGFORMS_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'eppd-megforms-auth' },
}) : null;

/** Approved OTCF claims for a month (soft-deleted ones excluded when the column exists). */
export async function fetchApprovedOtcf(year, month) {
  const cols = 'id,serial_no,emp_name,company_code,department,month,year,line_items,status,approved_at,approved_by_name';
  let q = mf.from('otcf_submissions').select(cols + ',deleted_at').eq('status', 'approved').eq('year', year).eq('month', month).is('deleted_at', null);
  let { data, error } = await q;
  if (error && /deleted_at/.test(error.message || '')) ({ data, error } = await mf.from('otcf_submissions').select(cols).eq('status', 'approved').eq('year', year).eq('month', month));
  if (error) throw error;
  return data || [];
}
