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

/**
 * Approved claims (SCF / MTCF) from the MEG-FORMS admin view all_submissions_view, normalised.
 * forms: ['scf','mtcf']. Rows already soft-deleted are left out. Column names differ a little between forms,
 * so each field is read from the first name that exists.
 */
export async function fetchApprovedClaims(forms) {
  const { data, error } = await mf.from('all_submissions_view').select('*');
  if (error) throw new Error(`MEG-FORMS claims view (all_submissions_view): ${error.message}`);
  const pick = (r, ...ks) => { for (const k of ks) if (r[k] !== undefined && r[k] !== null && r[k] !== '') return r[k]; return null; };
  return (data || []).map((r) => {
    const form = String(pick(r, 'form_code', 'form', 'source') || '').toLowerCase().replace(/[^a-z]/g, '').replace(/^meg/, '');
    return {
      form_code: form, submission_id: String(pick(r, 'id', 'submission_id') ?? ''),
      serial_no: pick(r, 'serial_no', 'serial'), claimant: pick(r, 'claimant', 'claimant_name', 'emp_name', 'claimed_by', 'name'),
      company: pick(r, 'company', 'company_code', 'company_name'), amount: Number(pick(r, 'amount', 'total_amount', 'total')) || 0,
      unit: String(pick(r, 'amount_unit', 'unit') || 'RM'), status: String(pick(r, 'status') || '').toLowerCase(),
      date: String(pick(r, 'approved_at', 'submitted_at', 'created_at') || '').slice(0, 10) || null,
      paid: !!pick(r, 'paid_at', 'payment_confirmed_at', 'payment_date', 'paid_by_name'), deleted: !!pick(r, 'deleted_at'),
    };
  }).filter((c) => forms.includes(c.form_code) && ['approved', 'done'].includes(c.status) && !c.deleted && !/hr/i.test(c.unit) && c.amount > 0 && c.submission_id);
}
