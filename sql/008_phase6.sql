-- =====================================================================
-- MyPayroll-System-V2.0  ·  008_phase6.sql  ·  UVN v2026.10.09-20:00
-- Run in the MyPayroll-System project AFTER 001–007. Safe to re-run.
-- Phase 6 (each part can be switched on/off in Settings › HR policies › Optional modules):
--   · automatic PCB (LHDN computerised method) with per-employee tax details
--   · MEG-FORMS claims (SCF, MTCF) paid with the salary
--   · company loans with monthly instalments
--   · final settlement for leavers (unused leave, notice pay, loan recovery)
-- Everything here is admin + HR only.
-- =====================================================================

-- ---------- new payment types (never overwrite your edits) -------------
insert into public.eppd_payment_types (code,name,kind,category,subject_epf,subject_socso,subject_eis,subject_pcb,is_recurring,is_system,notes,sort_order) values
  ('ZAKAT','Zakat (salary deduction)','deduction','personal',false,false,false,false,true,true,'Zakat paid through the payroll; reduces PCB for the month.',25),
  ('CLAIM_SCF','Staff claim (SCF)','earning','reimbursement',false,false,false,false,false,true,'Reimbursement from MEG-FORMS SCF. Not wages: no EPF/SOCSO/EIS/PCB, not on the EA form, paid on top of net pay.',26),
  ('CLAIM_MTCF','Mileage claim (MTCF)','earning','reimbursement',false,false,false,false,false,true,'Reimbursement from MEG-FORMS MTCF. Not wages: no EPF/SOCSO/EIS/PCB, not on the EA form, paid on top of net pay.',27),
  ('NOTICE_PAY','Payment in lieu of notice','earning','compensation',false,false,false,true,false,true,'Paid by the employer when the notice period is cut short. Taxable; not EPF/SOCSO/EIS wages.',28),
  ('NOTICE_SHORT','Notice period not served','deduction','personal',false,false,false,false,false,true,'Deducted when the employee leaves without serving the notice period.',29)
on conflict (code) do nothing;
-- unused annual leave paid out on leaving: same statutory treatment as the AL buy-back type you already have
insert into public.eppd_payment_types (code,name,kind,category,subject_epf,subject_socso,subject_eis,subject_pcb,is_recurring,is_system,notes,sort_order)
select 'AL_ENCASH','Unused annual leave paid out','earning','leave',subject_epf,subject_socso,subject_eis,subject_pcb,false,true,
       'Final settlement: unused annual leave × daily rate. Statutory switches copied from AL Buy Back.',30
from public.eppd_payment_types where code = 'AL_BUYBACK'
on conflict (code) do nothing;

-- ---------- pay lines: claims are paid on top of net pay ----------
alter table public.eppd_pay_lines add column if not exists reimbursements numeric(12,2) not null default 0;

create or replace function public.eppd_insert_pay_lines(p_run bigint, p_lines jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare x jsonb; n int := 0;
begin
  for x in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    insert into public.eppd_pay_lines (run_id, employee_id, assignment_id, company_id, emp_name, emp_code, mode, excluded,
      items, overrides, inputs, warnings, gross, epf_wage, socso_wage, eis_wage, epf_ee, epf_er, socso_ee, socso_er,
      eis_ee, eis_er, pcb, net, personal_deductions, reimbursements, net_paid, note)
    values (p_run, (x->>'employee_id')::bigint, nullif(x->>'assignment_id', '')::bigint, nullif(x->>'company_id', '')::bigint,
      x->>'emp_name', x->>'emp_code', coalesce(x->>'mode', 'auto'), coalesce((x->>'excluded')::boolean, false),
      coalesce(x->'items', '[]'::jsonb), coalesce(x->'overrides', '{}'::jsonb), coalesce(x->'inputs', '{}'::jsonb),
      coalesce(x->'warnings', '[]'::jsonb),
      coalesce((x->>'gross')::numeric, 0), coalesce((x->>'epf_wage')::numeric, 0), coalesce((x->>'socso_wage')::numeric, 0),
      coalesce((x->>'eis_wage')::numeric, 0), coalesce((x->>'epf_ee')::numeric, 0), coalesce((x->>'epf_er')::numeric, 0),
      coalesce((x->>'socso_ee')::numeric, 0), coalesce((x->>'socso_er')::numeric, 0), coalesce((x->>'eis_ee')::numeric, 0),
      coalesce((x->>'eis_er')::numeric, 0), coalesce((x->>'pcb')::numeric, 0), coalesce((x->>'net')::numeric, 0),
      coalesce((x->>'personal_deductions')::numeric, 0), coalesce((x->>'reimbursements')::numeric, 0),
      coalesce((x->>'net_paid')::numeric, 0), x->>'note');
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.eppd_insert_pay_lines(bigint, jsonb) from public, anon, authenticated;

-- ---------- tax details per employee (automatic PCB) ----------
create table if not exists public.eppd_tax_profiles (
  employee_id          bigint primary key references public.eppd_employees(id) on delete cascade,
  pcb_manual           boolean not null default false,   -- true = HR types PCB for this person every month
  resident             boolean not null default true,    -- non-resident = flat rate
  category             int not null default 1 check (category in (1, 2, 3)),  -- 1 single · 2 married, spouse not working · 3 married, spouse working
  children             int not null default 0 check (children >= 0),           -- children claimed at the basic child relief
  child_relief_extra   numeric(12,2) not null default 0,  -- extra child relief a year (higher education, disabled child …)
  disabled             boolean not null default false,
  spouse_disabled      boolean not null default false,
  tp1_monthly          numeric(12,2) not null default 0,  -- other deductions claimed via Form TP1, per month
  zakat_monthly        numeric(12,2) not null default 0,  -- zakat deducted through payroll each month
  prev_year            int,                               -- previous employment in this year (Form TP3)
  prev_gross           numeric(12,2) not null default 0,
  prev_epf             numeric(12,2) not null default 0,
  prev_pcb             numeric(12,2) not null default 0,
  prev_zakat           numeric(12,2) not null default 0,
  note                 text,
  updated_at           timestamptz not null default now()
);

-- ---------- MEG-FORMS claims paid through payroll ----------
create table if not exists public.eppd_claims (
  id              bigint generated always as identity primary key,
  employee_id     bigint not null references public.eppd_employees(id) on delete restrict,
  form_code       text not null check (form_code in ('scf', 'mtcf')),
  submission_id   text not null,          -- MEG-FORMS submission id
  serial_no       text,
  claimant_name   text,                   -- name as typed in MEG-FORMS
  claim_date      date,
  amount          numeric(12,2) not null check (amount >= 0),
  pay_period      date not null check (extract(day from pay_period) = 1),   -- payroll month it is paid in
  status          text not null default 'active' check (status in ('active', 'cancelled')),
  note            text,
  created_at      timestamptz not null default now(),
  created_by      uuid default auth.uid(),
  updated_at      timestamptz not null default now(),
  unique (form_code, submission_id)
);
create index if not exists eppd_claims_period_idx on public.eppd_claims (pay_period);

-- ---------- company loans ----------
create table if not exists public.eppd_loans (
  id                  bigint generated always as identity primary key,
  employee_id         bigint not null references public.eppd_employees(id) on delete restrict,
  company_id          bigint references public.eppd_companies(id) on delete set null,
  description         text,
  principal           numeric(12,2) not null check (principal > 0),
  monthly_instalment  numeric(12,2) not null check (monthly_instalment > 0),
  start_period        date not null check (extract(day from start_period) = 1),  -- first payroll month deducted
  loan_date           date,
  status              text not null default 'active' check (status in ('active', 'closed')),
  closed_note         text,
  created_at          timestamptz not null default now(),
  created_by          uuid default auth.uid(),
  updated_at          timestamptz not null default now()
);
create index if not exists eppd_loans_emp_idx on public.eppd_loans (employee_id);

-- ---------- final settlement for a leaver (one per employment period) ----------
create table if not exists public.eppd_settlements (
  id               bigint generated always as identity primary key,
  employment_id    bigint not null unique references public.eppd_employments(id) on delete cascade,
  al_mode          text not null default 'auto' check (al_mode in ('auto', 'none', 'custom')),  -- auto = unused AL × daily rate
  al_days          numeric(6,2),            -- custom: days to pay (negative = deduct leave taken in advance)
  al_amount        numeric(12,2),           -- custom: amount (overrides days × rate)
  notice_mode      text not null default 'none' check (notice_mode in ('none', 'employer_pays', 'employee_pays')),
  notice_days      numeric(6,2),
  notice_amount    numeric(12,2),
  recover_loans    boolean not null default true,
  note             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------- triggers + RLS (admin + hr only) ----------
do $$
declare t text;
begin
  foreach t in array array['eppd_tax_profiles','eppd_claims','eppd_loans','eppd_settlements'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I for each row execute function public.eppd_touch()', t, t);
    execute format('drop trigger if exists %I_audit on public.%I', t, t);
    execute format('create trigger %I_audit after insert or update or delete on public.%I for each row execute function public.eppd_audit()', t, t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('drop policy if exists %I_write on public.%I', t, t);
    execute format('create policy %I_read on public.%I for select to authenticated using (public.eppd_has_role(array[''admin'',''hr'']))', t, t);
    execute format('create policy %I_write on public.%I for all to authenticated using (public.eppd_has_role(array[''admin'',''hr''])) with check (public.eppd_has_role(array[''admin'',''hr'']))', t, t);
  end loop;
end $$;

-- ---------- policies (never overwrite your edits) ----------
insert into public.eppd_policies (key, value, description) values
 ('modules', '{"pcb_auto": false, "claims": {"enabled": false, "scf": true, "mtcf": true}, "loans": false, "settlement": false}'::jsonb,
  'Optional modules. All off until switched on in Settings › HR policies › Optional modules.'),
 ('pcb', '{
    "year_from": 2026,
    "reliefs": {"individual": 9000, "spouse": 4000, "disabled": 7000, "spouse_disabled": 6000, "child": 2000},
    "epf_cap": 4000,
    "socso_relief": true, "socso_relief_cap": 350,
    "non_resident_rate": 30,
    "min_pcb": 10,
    "rebate_limit": 35000,
    "additional_categories": ["bonus", "incentive", "compensation"],
    "additional_codes": ["AL_BUYBACK", "AL_ENCASH"],
    "bands": [
      {"from": 0,       "rate": 0,  "b13": 0,      "b2": 0},
      {"from": 5000,    "rate": 1,  "b13": -400,   "b2": -800},
      {"from": 20000,   "rate": 3,  "b13": -250,   "b2": -650},
      {"from": 35000,   "rate": 6,  "b13": 600,    "b2": 600},
      {"from": 50000,   "rate": 11, "b13": 1500,   "b2": 1500},
      {"from": 70000,   "rate": 19, "b13": 3700,   "b2": 3700},
      {"from": 100000,  "rate": 25, "b13": 9400,   "b2": 9400},
      {"from": 400000,  "rate": 26, "b13": 84400,  "b2": 84400},
      {"from": 600000,  "rate": 28, "b13": 136400, "b2": 136400},
      {"from": 2000000, "rate": 30, "b13": 528400, "b2": 528400}
    ]
  }'::jsonb,
  'Automatic PCB (LHDN computerised calculation). bands: M (from), R (rate %), B for categories 1 & 3 (b13) and 2 (b2) — B already includes the RM400 / RM800 rebate for chargeable income up to RM35,000. Check against the LHDN e-PCB calculator each January.'),
 ('settlement', '{"al_mode_default": "auto", "notice_rate": "daily_26"}'::jsonb,
  'Final settlement defaults: unused annual leave paid out at the daily rate (basic ÷ 26); notice pay in lieu at the daily rate per calendar day short.')
on conflict (key) do nothing;
