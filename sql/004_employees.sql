-- =====================================================================
-- MyPayroll-System-V2.0  ·  004_employees.sql  ·  UVN v2026.10.09-11:30
-- Run in the MyPayroll-System project AFTER 001–003. Safe to re-run.
-- Phase 2: employees (people), employment periods, company pay
-- assignments, salary history, allowances, Employee ID generation,
-- one-time import from the MEG-EPPD workbook.
--
-- Who sees what:
--   eppd_employees / eppd_employments / eppd_assignments  -> any active user
--   eppd_employee_private / eppd_salary_history / eppd_allowances
--                                                          -> admin + hr only
-- Creates ONLY new eppd_* objects (plus one new column on eppd_companies).
-- =====================================================================

-- ---------- companies: Employee ID prefix ------------------------------
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'eppd_companies' and column_name = 'eid_prefix') then
    alter table public.eppd_companies add column eid_prefix text not null default 'MEG';
    -- first run only: Happy Dino staff IDs use the HD prefix (seen in the workbook: HD0626M0149)
    update public.eppd_companies set eid_prefix = 'HD' where code = 'HD';
  end if;
end $$;

-- extra banks found in the workbook
insert into public.eppd_lookups (category, code, label, sort_order) values
  ('bank', 'RHB', 'RHB Bank', 11),
  ('bank', 'RYT', 'Ryt Bank', 12)
on conflict (category, code) do nothing;

-- ---------- people -----------------------------------------------------
create table if not exists public.eppd_employees (
  id             bigint generated always as identity primary key,
  emp_id         text,                   -- e.g. MEG0325F0118 (person-level, never per company)
  emp_serial     int,                    -- group-wide running number (last 4 digits)
  full_name      text not null,
  chinese_name   text,
  gender         text check (gender in ('F', 'M')),
  nationality    text,                   -- eppd_lookups(nationality).code
  race           text,                   -- eppd_lookups(race).code
  marital_status text,                   -- eppd_lookups(marital_status).code
  email          text,
  phone          text,
  remarks        text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default auth.uid()
);
create unique index if not exists eppd_employees_empid_uq on public.eppd_employees (upper(emp_id)) where emp_id is not null;
create index if not exists eppd_employees_name_idx on public.eppd_employees (full_name);

-- sensitive personal details (admin + hr only)
create table if not exists public.eppd_employee_private (
  employee_id        bigint primary key references public.eppd_employees(id) on delete cascade,
  nric               text,
  passport_no        text,
  dob                date,
  home_address       text,
  spouse_name        text,
  bank_code          text,               -- eppd_lookups(bank).code
  bank_account_no    text,
  epf_no             text,
  socso_no           text,               -- blank = derived from NRIC (digits only)
  tax_no             text,
  emergency_name     text,
  emergency_relation text,
  emergency_phone    text,
  updated_at         timestamptz not null default now()
);
create index if not exists eppd_private_nric_idx on public.eppd_employee_private (nric);

-- employment periods (a rehire = a new period for the same person)
create table if not exists public.eppd_employments (
  id                       bigint generated always as identity primary key,
  employee_id              bigint not null references public.eppd_employees(id) on delete cascade,
  join_date                date,
  confirmation_status      text not null default 'UP',  -- eppd_lookups(confirmation_status).code
  confirmed_date           date,
  job_status               text,                        -- eppd_lookups(job_status).code
  department_id            bigint references public.eppd_departments(id) on delete set null,
  job_title_id             bigint references public.eppd_job_titles(id) on delete set null,
  work_from                time,
  work_to                  time,
  meal_hours               numeric(4,2) default 1,
  ot_days                  numeric(5,2) default 26,
  ot_multiplier            numeric(4,2) default 1.5,
  resignation_letter_date  date,
  resigned_date            date,                        -- last working day
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index if not exists eppd_employments_emp_idx on public.eppd_employments (employee_id, join_date desc);

-- which company pays the person (one person can be paid by several companies)
create table if not exists public.eppd_assignments (
  id                 bigint generated always as identity primary key,
  employment_id      bigint not null references public.eppd_employments(id) on delete cascade,
  company_id         bigint not null references public.eppd_companies(id) on delete restrict,
  is_primary         boolean not null default true,
  start_date         date,
  end_date           date,
  epf_ee             boolean not null default true,
  epf_er             boolean not null default true,
  socso_ee           boolean not null default true,
  socso_er           boolean not null default true,
  eis_ee             boolean not null default true,
  eis_er             boolean not null default true,
  socso_nei_opt_out  boolean not null default false,   -- employee pays invalidity portion only
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);
create index if not exists eppd_assignments_emp_idx on public.eppd_assignments (employment_id);
create unique index if not exists eppd_assignments_one_primary on public.eppd_assignments (employment_id) where is_primary;

-- salary history (admin + hr only): the salary in force on the last day of a month is used for that month
create table if not exists public.eppd_salary_history (
  id              bigint generated always as identity primary key,
  assignment_id   bigint not null references public.eppd_assignments(id) on delete cascade,
  effective_from  date not null,
  amount          numeric(12,2) not null check (amount >= 0),
  pay_basis       text not null default 'monthly' check (pay_basis in ('monthly', 'hourly')),
  reason          text,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (assignment_id, effective_from)
);

-- recurring allowances with start / end dates (admin + hr only)
create table if not exists public.eppd_allowances (
  id               bigint generated always as identity primary key,
  assignment_id    bigint not null references public.eppd_assignments(id) on delete cascade,
  payment_type_id  bigint not null references public.eppd_payment_types(id) on delete restrict,
  amount           numeric(12,2) not null check (amount >= 0),
  start_date       date,
  end_date         date,
  note             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);
create index if not exists eppd_allowances_asg_idx on public.eppd_allowances (assignment_id);

-- ---------- audit: also key rows by employee_id; allow bulk import to skip row logging ----
create or replace function public.eppd_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare o jsonb; n jsonb; rid text;
begin
  if current_setting('eppd.skip_audit', true) = 'on' then return coalesce(new, old); end if;
  if tg_op <> 'INSERT' then o := to_jsonb(old) - 'logo'; end if;
  if tg_op <> 'DELETE' then n := to_jsonb(new) - 'logo'; end if;
  if tg_op = 'UPDATE' and tg_table_name = 'eppd_companies'
     and (to_jsonb(old)->>'logo') is distinct from (to_jsonb(new)->>'logo') then
    n := n || jsonb_build_object('logo_changed', true);
  end if;
  rid := coalesce(n->>'id', o->>'id', n->>'employee_id', o->>'employee_id',
                  n->>'user_id', o->>'user_id', n->>'key', o->>'key');
  insert into public.eppd_audit_log (user_id, user_email, table_name, row_id, action, old_data, new_data)
  values (auth.uid(), (select email from auth.users where id = auth.uid()),
          tg_table_name, rid, tg_op, o, n);
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['eppd_employees','eppd_employee_private','eppd_employments',
                           'eppd_assignments','eppd_salary_history','eppd_allowances']
  loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I
                    for each row execute function public.eppd_touch()', t, t);
    execute format('drop trigger if exists %I_audit on public.%I', t, t);
    execute format('create trigger %I_audit after insert or update or delete on public.%I
                    for each row execute function public.eppd_audit()', t, t);
  end loop;
end $$;

-- ---------- RLS ---------------------------------------------------------
do $$
declare t text; readers text;
begin
  for t, readers in
    select * from (values
      ('eppd_employees',        'all'),
      ('eppd_employments',      'all'),
      ('eppd_assignments',      'all'),
      ('eppd_employee_private', 'hr'),
      ('eppd_salary_history',   'hr'),
      ('eppd_allowances',       'hr')
    ) as x(t, r)
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('drop policy if exists %I_write on public.%I', t, t);
    if readers = 'all' then
      execute format('create policy %I_read on public.%I for select to authenticated
                      using (public.eppd_is_active())', t, t);
    else
      execute format('create policy %I_read on public.%I for select to authenticated
                      using (public.eppd_has_role(array[''admin'',''hr'']))', t, t);
    end if;
    execute format('create policy %I_write on public.%I for all to authenticated
                    using (public.eppd_has_role(array[''admin'',''hr'']))
                    with check (public.eppd_has_role(array[''admin'',''hr'']))', t, t);
  end loop;
end $$;

-- ---------- list view (respects RLS of the underlying tables) ----------
create or replace view public.eppd_employee_list with (security_invoker = true) as
select
  e.id, e.emp_id, e.emp_serial, e.full_name, e.chinese_name, e.gender, e.nationality,
  cur.id                       as employment_id,
  cur.join_date, cur.confirmation_status, cur.confirmed_date, cur.job_status,
  cur.resignation_letter_date, cur.resigned_date,
  d.id as department_id, d.code as department_code, d.name as department_name,
  jt.id as job_title_id, jt.name as job_title,
  pc.id as company_id, pc.code as company_code, coalesce(pc.short_name, pc.name) as company_name,
  (select count(*) from public.eppd_assignments a2 where a2.employment_id = cur.id) as company_count,
  (select count(*) from public.eppd_employments m2 where m2.employee_id = e.id)     as employment_count,
  e.updated_at
from public.eppd_employees e
left join lateral (
  select m.* from public.eppd_employments m
  where m.employee_id = e.id
  order by m.join_date desc nulls last, m.id desc limit 1
) cur on true
left join public.eppd_departments d on d.id = cur.department_id
left join public.eppd_job_titles jt on jt.id = cur.job_title_id
left join lateral (
  select c.* from public.eppd_assignments a join public.eppd_companies c on c.id = a.company_id
  where a.employment_id = cur.id
  order by a.is_primary desc, a.id limit 1
) pc on true;

grant select on public.eppd_employee_list to authenticated;

-- ---------- Employee ID helpers -----------------------------------------
-- Format: PREFIX + MMYY of join date + gender letter + 4-digit serial, e.g. MEG0325F0118.
create or replace function public.eppd_format_emp_id(p_prefix text, p_join date, p_gender text, p_serial int)
returns text language sql immutable as $$
  select upper(coalesce(nullif(trim(p_prefix), ''), 'MEG')) || to_char(p_join, 'MMYY')
         || upper(left(trim(p_gender), 1)) || lpad(p_serial::text, 4, '0')
$$;

-- serial = last 4 digits, counted only when the ID has a real month (01–12)
create or replace function public.eppd_parse_serial(p_emp_id text)
returns int language sql immutable as $$
  select case when p_emp_id ~ '^[A-Za-z]+(0[1-9]|1[0-2])[0-9]{2}[MFmf][0-9]{4}$'
              then right(p_emp_id, 4)::int end
$$;

-- next group-wide running number (one sequence for every company)
create or replace function public.eppd_next_emp_serial()
returns int language sql stable security definer set search_path = public as $$
  select coalesce(max(emp_serial), 0) + 1 from public.eppd_employees
$$;

-- Create an employee in one step (person + private + employment + company + first salary).
-- p: { emp_id?, auto_id:bool, full_name, chinese_name, gender, nationality, race, marital_status, email, phone,
--      private:{...}, employment:{join_date, confirmation_status, job_status, department_id, job_title_id, ...},
--      company_id, salary:{amount, pay_basis, effective_from} }
create or replace function public.eppd_create_employee(p jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_emp bigint; v_empl bigint; v_asg bigint; v_id text; v_serial int; v_prefix text;
  v_join date := nullif(p->'employment'->>'join_date', '')::date;
  v_company bigint := nullif(p->>'company_id', '')::bigint;
  v_gender text := upper(nullif(p->>'gender', ''));
  v_pr jsonb := coalesce(p->'private', '{}'::jsonb);
  v_em jsonb := coalesce(p->'employment', '{}'::jsonb);
  v_by text;
begin
  if not public.eppd_has_role(array['admin','hr']) then
    raise exception 'Only HR and admins can add employees.';
  end if;
  if coalesce(trim(p->>'full_name'), '') = '' then raise exception 'Employee name is required.'; end if;
  if v_company is null then raise exception 'Choose the company that pays this employee.'; end if;

  perform pg_advisory_xact_lock(hashtext('eppd_emp_id'));
  if coalesce(trim(p->>'emp_id'), '') <> '' then
    v_id := upper(trim(p->>'emp_id'));
    select full_name into v_by from public.eppd_employees where upper(emp_id) = v_id;
    if found then raise exception 'Employee ID % is already used by %.', v_id, v_by; end if;
    v_serial := public.eppd_parse_serial(v_id);
  elsif coalesce((p->>'auto_id')::boolean, true) then
    if v_join is null or v_gender is null then
      raise exception 'Join date and gender are needed to generate the Employee ID.';
    end if;
    select eid_prefix into v_prefix from public.eppd_companies where id = v_company;
    v_serial := public.eppd_next_emp_serial();
    v_id := public.eppd_format_emp_id(v_prefix, v_join, v_gender, v_serial);
  end if;

  insert into public.eppd_employees (emp_id, emp_serial, full_name, chinese_name, gender, nationality, race,
                                     marital_status, email, phone, remarks)
  values (v_id, v_serial, upper(trim(p->>'full_name')), nullif(p->>'chinese_name', ''), v_gender,
          nullif(p->>'nationality', ''), nullif(p->>'race', ''), nullif(p->>'marital_status', ''),
          nullif(p->>'email', ''), nullif(p->>'phone', ''), nullif(p->>'remarks', ''))
  returning id into v_emp;

  insert into public.eppd_employee_private (employee_id, nric, passport_no, dob, home_address, spouse_name,
         bank_code, bank_account_no, epf_no, socso_no, tax_no)
  values (v_emp, nullif(v_pr->>'nric', ''), nullif(v_pr->>'passport_no', ''), nullif(v_pr->>'dob', '')::date,
          nullif(v_pr->>'home_address', ''), nullif(v_pr->>'spouse_name', ''), nullif(v_pr->>'bank_code', ''),
          nullif(v_pr->>'bank_account_no', ''), nullif(v_pr->>'epf_no', ''), nullif(v_pr->>'socso_no', ''),
          nullif(v_pr->>'tax_no', ''));

  insert into public.eppd_employments (employee_id, join_date, confirmation_status, job_status, department_id,
         job_title_id, work_from, work_to, meal_hours, ot_days, ot_multiplier)
  values (v_emp, v_join, coalesce(nullif(v_em->>'confirmation_status', ''), 'UP'), nullif(v_em->>'job_status', ''),
          nullif(v_em->>'department_id', '')::bigint, nullif(v_em->>'job_title_id', '')::bigint,
          nullif(v_em->>'work_from', '')::time, nullif(v_em->>'work_to', '')::time,
          coalesce(nullif(v_em->>'meal_hours', '')::numeric, 1), coalesce(nullif(v_em->>'ot_days', '')::numeric, 26),
          coalesce(nullif(v_em->>'ot_multiplier', '')::numeric, 1.5))
  returning id into v_empl;

  insert into public.eppd_assignments (employment_id, company_id, is_primary, start_date)
  values (v_empl, v_company, true, v_join) returning id into v_asg;

  if nullif(p->'salary'->>'amount', '') is not null then
    insert into public.eppd_salary_history (assignment_id, effective_from, amount, pay_basis, reason)
    values (v_asg, coalesce(nullif(p->'salary'->>'effective_from', '')::date, v_join, current_date),
            (p->'salary'->>'amount')::numeric, coalesce(nullif(p->'salary'->>'pay_basis', ''), 'monthly'), 'Starting salary');
  end if;

  return jsonb_build_object('id', v_emp, 'emp_id', v_id);
end $$;

-- Give an existing employee (who has none) a generated ID from the running number.
create or replace function public.eppd_generate_emp_id(p_employee_id bigint)
returns text language plpgsql security invoker set search_path = public as $$
declare v_id text; v_serial int; v_join date; v_gender text; v_prefix text; v_cur text;
begin
  if not public.eppd_has_role(array['admin','hr']) then raise exception 'Only HR and admins can assign IDs.'; end if;
  perform pg_advisory_xact_lock(hashtext('eppd_emp_id'));
  select emp_id, gender into v_cur, v_gender from public.eppd_employees where id = p_employee_id;
  if not found then raise exception 'Employee not found.'; end if;
  if v_cur is not null then raise exception 'This employee already has ID %.', v_cur; end if;
  select m.join_date, c.eid_prefix into v_join, v_prefix
    from public.eppd_employments m
    left join public.eppd_assignments a on a.employment_id = m.id
    left join public.eppd_companies c on c.id = a.company_id
   where m.employee_id = p_employee_id
   order by m.join_date desc nulls last, a.is_primary desc nulls last limit 1;
  if v_join is null or v_gender is null then
    raise exception 'Add a join date and gender first; the ID is built from them.';
  end if;
  v_serial := public.eppd_next_emp_serial();
  v_id := public.eppd_format_emp_id(v_prefix, v_join, v_gender, v_serial);
  update public.eppd_employees set emp_id = v_id, emp_serial = v_serial where id = p_employee_id;
  return v_id;
end $$;

-- Records one summary line for a bulk import (the audit log only accepts trigger writes otherwise).
create or replace function public.eppd_log_import(p_summary jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.eppd_is_admin() then raise exception 'Only admins can record an import.'; end if;
  insert into public.eppd_audit_log (user_id, user_email, table_name, row_id, action, new_data)
  values (auth.uid(), (select email from auth.users where id = auth.uid()), 'eppd_employees', null, 'IMPORT', p_summary);
end $$;

-- One-time import of the workbook (admin only, all-or-nothing).
-- Payload is built in the browser by js/engines/importer.js.
create or replace function public.eppd_import_employees(p jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  per jsonb; emp jsonb; asg jsonb; sal jsonb; alw jsonb; x jsonb;
  v_emp bigint; v_empl bigint; v_asg bigint; v_company bigint; v_pt bigint;
  n_people int := 0; n_empl int := 0; n_asg int := 0; n_sal int := 0; n_alw int := 0;
begin
  if not public.eppd_is_admin() then raise exception 'Only admins can run the workbook import.'; end if;
  if exists (select 1 from public.eppd_employees) then
    raise exception 'Employees already exist. The import only runs on an empty employee list (see sql/reset_employees.sql).';
  end if;
  perform set_config('eppd.skip_audit', 'on', true);

  for x in select * from jsonb_array_elements(coalesce(p->'lookups', '[]'::jsonb)) loop
    insert into public.eppd_lookups (category, code, label, meta, sort_order)
    values (x->>'category', x->>'code', x->>'label', coalesce(x->'meta', '{}'::jsonb), coalesce((x->>'sort_order')::int, 90))
    on conflict (category, code) do nothing;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p->'job_titles', '[]'::jsonb)) loop
    insert into public.eppd_job_titles (name, sort_order) values (x#>>'{}', 100) on conflict (name) do nothing;
  end loop;

  for per in select * from jsonb_array_elements(p->'people') loop
    insert into public.eppd_employees (emp_id, emp_serial, full_name, chinese_name, gender, nationality, race,
                                       marital_status, email, phone, remarks)
    values (nullif(per->>'emp_id', ''), nullif(per->>'emp_serial', '')::int, per->>'full_name',
            nullif(per->>'chinese_name', ''), nullif(per->>'gender', ''), nullif(per->>'nationality', ''),
            nullif(per->>'race', ''), nullif(per->>'marital_status', ''), nullif(per->>'email', ''),
            nullif(per->>'phone', ''), nullif(per->>'remarks', ''))
    returning id into v_emp;
    n_people := n_people + 1;

    insert into public.eppd_employee_private (employee_id, nric, dob, home_address, spouse_name, bank_code,
           bank_account_no, epf_no, tax_no)
    select v_emp, nullif(q->>'nric', ''), nullif(q->>'dob', '')::date, nullif(q->>'home_address', ''),
           nullif(q->>'spouse_name', ''), nullif(q->>'bank_code', ''), nullif(q->>'bank_account_no', ''),
           nullif(q->>'epf_no', ''), nullif(q->>'tax_no', '')
    from (select coalesce(per->'private', '{}'::jsonb) as q) s;

    for emp in select * from jsonb_array_elements(coalesce(per->'employments', '[]'::jsonb)) loop
      insert into public.eppd_employments (employee_id, join_date, confirmation_status, confirmed_date, job_status,
             department_id, job_title_id, work_from, work_to, meal_hours, ot_days, ot_multiplier,
             resignation_letter_date, resigned_date, notes)
      values (v_emp, nullif(emp->>'join_date', '')::date, coalesce(nullif(emp->>'confirmation_status', ''), 'UP'),
              nullif(emp->>'confirmed_date', '')::date, nullif(emp->>'job_status', ''),
              (select id from public.eppd_departments where code = emp->>'department_code'),
              (select id from public.eppd_job_titles where name = emp->>'job_title'),
              nullif(emp->>'work_from', '')::time, nullif(emp->>'work_to', '')::time,
              coalesce(nullif(emp->>'meal_hours', '')::numeric, 1), coalesce(nullif(emp->>'ot_days', '')::numeric, 26),
              coalesce(nullif(emp->>'ot_multiplier', '')::numeric, 1.5),
              nullif(emp->>'resignation_letter_date', '')::date, nullif(emp->>'resigned_date', '')::date,
              nullif(emp->>'notes', ''))
      returning id into v_empl;
      n_empl := n_empl + 1;

      for asg in select * from jsonb_array_elements(coalesce(emp->'assignments', '[]'::jsonb)) loop
        select id into v_company from public.eppd_companies where code = asg->>'company_code';
        if v_company is null then raise exception 'Unknown company code % for %.', asg->>'company_code', per->>'full_name'; end if;
        insert into public.eppd_assignments (employment_id, company_id, is_primary, start_date, end_date,
               epf_ee, epf_er, socso_ee, socso_er, eis_ee, eis_er, socso_nei_opt_out)
        values (v_empl, v_company, coalesce((asg->>'is_primary')::boolean, true),
                nullif(asg->>'start_date', '')::date, nullif(asg->>'end_date', '')::date,
                coalesce((asg->>'epf_ee')::boolean, true), coalesce((asg->>'epf_er')::boolean, true),
                coalesce((asg->>'socso_ee')::boolean, true), coalesce((asg->>'socso_er')::boolean, true),
                coalesce((asg->>'eis_ee')::boolean, true), coalesce((asg->>'eis_er')::boolean, true),
                coalesce((asg->>'socso_nei_opt_out')::boolean, false))
        returning id into v_asg;
        n_asg := n_asg + 1;

        for sal in select * from jsonb_array_elements(coalesce(asg->'salary', '[]'::jsonb)) loop
          insert into public.eppd_salary_history (assignment_id, effective_from, amount, pay_basis, reason, note)
          values (v_asg, (sal->>'effective_from')::date, (sal->>'amount')::numeric,
                  coalesce(sal->>'pay_basis', 'monthly'), nullif(sal->>'reason', ''), nullif(sal->>'note', ''));
          n_sal := n_sal + 1;
        end loop;

        for alw in select * from jsonb_array_elements(coalesce(asg->'allowances', '[]'::jsonb)) loop
          select id into v_pt from public.eppd_payment_types where code = alw->>'payment_type_code';
          if v_pt is null then raise exception 'Unknown payment type %.', alw->>'payment_type_code'; end if;
          insert into public.eppd_allowances (assignment_id, payment_type_id, amount, start_date, end_date, note)
          values (v_asg, v_pt, (alw->>'amount')::numeric, nullif(alw->>'start_date', '')::date,
                  nullif(alw->>'end_date', '')::date, nullif(alw->>'note', ''));
          n_alw := n_alw + 1;
        end loop;
      end loop;
    end loop;
  end loop;

  perform set_config('eppd.skip_audit', 'off', true);
  perform public.eppd_log_import(jsonb_build_object('source', p->>'source', 'people', n_people, 'employments', n_empl,
                                                   'assignments', n_asg, 'salary_records', n_sal, 'allowances', n_alw));
  return jsonb_build_object('people', n_people, 'employments', n_empl, 'assignments', n_asg,
                            'salary_records', n_sal, 'allowances', n_alw);
end $$;

revoke execute on function public.eppd_create_employee(jsonb), public.eppd_generate_emp_id(bigint),
  public.eppd_import_employees(jsonb), public.eppd_next_emp_serial(), public.eppd_log_import(jsonb) from public, anon;
grant execute on function public.eppd_create_employee(jsonb), public.eppd_generate_emp_id(bigint),
  public.eppd_import_employees(jsonb), public.eppd_next_emp_serial(), public.eppd_log_import(jsonb),
  public.eppd_format_emp_id(text, date, text, int), public.eppd_parse_serial(text) to authenticated;

-- check: select table_name from information_schema.tables where table_name like 'eppd_e%' or table_name in ('eppd_assignments','eppd_salary_history','eppd_allowances') order by 1;
