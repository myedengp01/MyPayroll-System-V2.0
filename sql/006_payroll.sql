-- =====================================================================
-- MyPayroll-System-V2.0  ·  006_payroll.sql  ·  UVN v2026.10.09-16:30
-- Run in the MyPayroll-System project AFTER 001–005. Safe to re-run.
-- Phase 4: monthly pay runs. One run per month; one line per employee per
-- paying company. HR / admin prepare and finalise; a finalised month is
-- locked (only an admin can reopen it, with a reason that is logged).
-- Everything here is admin + HR only, and payroll rows can only be written
-- through the functions at the end of this file.
-- =====================================================================

-- ---------- pay runs ---------------------------------------------------
create table if not exists public.eppd_pay_runs (
  id             bigint generated always as identity primary key,
  period         date not null unique check (extract(day from period) = 1),   -- first day of the month
  status         text not null default 'draft' check (status in ('draft', 'finalised')),
  source         text not null default 'app' check (source in ('app', 'import')),
  totals         jsonb not null default '{}'::jsonb,   -- cached run totals (whole run + per company)
  notes          text,
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid(),
  updated_at     timestamptz not null default now(),
  finalised_at   timestamptz,
  finalised_by   uuid,
  reopened_at    timestamptz,
  reopened_by    uuid,
  reopen_reason  text
);

-- ---------- pay lines (one per employee per paying company) -----------
create table if not exists public.eppd_pay_lines (
  id                   bigint generated always as identity primary key,
  run_id               bigint not null references public.eppd_pay_runs(id) on delete cascade,
  employee_id          bigint not null references public.eppd_employees(id) on delete restrict,
  assignment_id        bigint references public.eppd_assignments(id) on delete set null,
  company_id           bigint references public.eppd_companies(id) on delete set null,
  emp_name             text not null,          -- snapshot at the time of the run
  emp_code             text,                   -- Employee ID snapshot
  mode                 text not null default 'auto' check (mode in ('auto', 'fixed')),  -- fixed = figures as recorded (imported)
  excluded             boolean not null default false,
  items                jsonb not null default '[]'::jsonb,   -- earnings & deductions
  overrides            jsonb not null default '{}'::jsonb,   -- statutory amounts typed by HR
  inputs               jsonb not null default '{}'::jsonb,   -- what the line was calculated from
  warnings             jsonb not null default '[]'::jsonb,
  gross                numeric(12,2) not null default 0,
  epf_wage             numeric(12,2) not null default 0,
  socso_wage           numeric(12,2) not null default 0,
  eis_wage             numeric(12,2) not null default 0,
  epf_ee               numeric(12,2) not null default 0,
  epf_er               numeric(12,2) not null default 0,
  socso_ee             numeric(12,2) not null default 0,
  socso_er             numeric(12,2) not null default 0,
  eis_ee               numeric(12,2) not null default 0,
  eis_er               numeric(12,2) not null default 0,
  pcb                  numeric(12,2) not null default 0,
  net                  numeric(12,2) not null default 0,     -- gross − employee statutory − PCB
  personal_deductions  numeric(12,2) not null default 0,
  net_paid             numeric(12,2) not null default 0,     -- amount paid to the employee
  note                 text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists eppd_pay_lines_run_idx on public.eppd_pay_lines (run_id);
create index if not exists eppd_pay_lines_emp_idx on public.eppd_pay_lines (employee_id);
create unique index if not exists eppd_pay_lines_uq on public.eppd_pay_lines (run_id, employee_id, coalesce(company_id, 0));

-- ---------- lock -----------------------------------------------------
-- Signed-in users (roles authenticated / anon) change payroll ONLY through the payroll functions below,
-- which run as the owner. A client can delete a draft month, nothing else. Inside the functions a
-- finalised month stays locked unless Finalise / Reopen / Import switch the lock off for their own
-- transaction (the switch has no effect for a client role).
create or replace function public.eppd_pay_lock()
returns trigger language plpgsql set search_path = public as $$
declare v_old text; v_new text;
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op <> 'DELETE' then raise exception 'Payroll can only be changed from the payroll screens.'; end if;
    if tg_table_name = 'eppd_pay_runs' then
      if old.status = 'finalised' then raise exception 'This month is finalised and cannot be deleted.'; end if;
      return old;
    end if;
    select status into v_old from public.eppd_pay_runs where id = old.run_id;
    if v_old = 'finalised' then raise exception 'This month is finalised. Ask an admin to reopen it.'; end if;
    return old;
  end if;
  if current_setting('eppd.pay_unlock', true) = 'on' then return coalesce(new, old); end if;
  if tg_table_name = 'eppd_pay_runs' then
    if tg_op = 'DELETE' then
      if old.status = 'finalised' then raise exception 'This month is finalised and cannot be deleted.'; end if;
      return old;
    end if;
    if tg_op = 'UPDATE' and (old.status = 'finalised' or new.status = 'finalised') then raise exception 'This month is finalised. Ask an admin to reopen it.'; end if;
    if tg_op = 'INSERT' and new.status = 'finalised' then raise exception 'Use Finalise to lock a month.'; end if;
    return new;
  end if;
  if tg_op <> 'INSERT' then select status into v_old from public.eppd_pay_runs where id = old.run_id; end if;
  if tg_op <> 'DELETE' then select status into v_new from public.eppd_pay_runs where id = new.run_id; end if;
  if v_old = 'finalised' or v_new = 'finalised' then raise exception 'This month is finalised. Ask an admin to reopen it.'; end if;
  return coalesce(new, old);
end $$;

drop trigger if exists eppd_pay_runs_lock on public.eppd_pay_runs;
create trigger eppd_pay_runs_lock before insert or update or delete on public.eppd_pay_runs
  for each row execute function public.eppd_pay_lock();
drop trigger if exists eppd_pay_lines_lock on public.eppd_pay_lines;
create trigger eppd_pay_lines_lock before insert or update or delete on public.eppd_pay_lines
  for each row execute function public.eppd_pay_lock();

-- ---------- touch + audit + RLS (admin + hr only) ----------------------
do $$
declare t text;
begin
  foreach t in array array['eppd_pay_runs','eppd_pay_lines'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I
                    for each row execute function public.eppd_touch()', t, t);
    execute format('drop trigger if exists %I_audit on public.%I', t, t);
    execute format('create trigger %I_audit after insert or update or delete on public.%I
                    for each row execute function public.eppd_audit()', t, t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('drop policy if exists %I_write on public.%I', t, t);
    execute format('create policy %I_read on public.%I for select to authenticated
                    using (public.eppd_has_role(array[''admin'',''hr'']))', t, t);
    execute format('create policy %I_write on public.%I for all to authenticated
                    using (public.eppd_has_role(array[''admin'',''hr'']))
                    with check (public.eppd_has_role(array[''admin'',''hr'']))', t, t);
  end loop;
end $$;

-- ---------- audit summaries ------------------------------------------
-- Phase 3 helper keeps its own actions only (payroll entries cannot be written by a client).
create or replace function public.eppd_log_summary(p_table text, p_action text, p_data jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.eppd_has_role(array['admin','hr']) then raise exception 'Not allowed.'; end if;
  if p_action not in ('IMPORT','YEAR_CLOSE','OTCF_PULL') then raise exception 'Unknown action.'; end if;
  insert into public.eppd_audit_log (user_id, user_email, table_name, row_id, action, new_data)
  values (auth.uid(), (select email from auth.users where id = auth.uid()), p_table, null, p_action, p_data);
end $$;

-- payroll summary line (called only from the payroll functions; not granted to clients)
create or replace function public.eppd_pay_log(p_action text, p_data jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.eppd_audit_log (user_id, user_email, table_name, row_id, action, new_data)
  values (auth.uid(), (select email from auth.users where id = auth.uid()), 'eppd_pay_runs', p_data->>'run_id', p_action, p_data);
end $$;

-- insert the lines of one run (shared by save and import; not granted to clients)
create or replace function public.eppd_insert_pay_lines(p_run bigint, p_lines jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare x jsonb; n int := 0;
begin
  for x in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    insert into public.eppd_pay_lines (run_id, employee_id, assignment_id, company_id, emp_name, emp_code, mode, excluded,
      items, overrides, inputs, warnings, gross, epf_wage, socso_wage, eis_wage, epf_ee, epf_er, socso_ee, socso_er,
      eis_ee, eis_er, pcb, net, personal_deductions, net_paid, note)
    values (p_run, (x->>'employee_id')::bigint, nullif(x->>'assignment_id', '')::bigint, nullif(x->>'company_id', '')::bigint,
      x->>'emp_name', x->>'emp_code', coalesce(x->>'mode', 'auto'), coalesce((x->>'excluded')::boolean, false),
      coalesce(x->'items', '[]'::jsonb), coalesce(x->'overrides', '{}'::jsonb), coalesce(x->'inputs', '{}'::jsonb),
      coalesce(x->'warnings', '[]'::jsonb),
      coalesce((x->>'gross')::numeric, 0), coalesce((x->>'epf_wage')::numeric, 0), coalesce((x->>'socso_wage')::numeric, 0),
      coalesce((x->>'eis_wage')::numeric, 0), coalesce((x->>'epf_ee')::numeric, 0), coalesce((x->>'epf_er')::numeric, 0),
      coalesce((x->>'socso_ee')::numeric, 0), coalesce((x->>'socso_er')::numeric, 0), coalesce((x->>'eis_ee')::numeric, 0),
      coalesce((x->>'eis_er')::numeric, 0), coalesce((x->>'pcb')::numeric, 0), coalesce((x->>'net')::numeric, 0),
      coalesce((x->>'personal_deductions')::numeric, 0), coalesce((x->>'net_paid')::numeric, 0), x->>'note');
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- save a draft month (admin + hr): replaces all its lines ----------
-- p: { period:'YYYY-MM-01', notes, totals, lines:[...], expected_updated_at }
-- expected_updated_at = the draft's updated_at when the page loaded (null for a month not started):
-- if someone else saved in between, nothing is overwritten.
create or replace function public.eppd_save_pay_run(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_period date := (p->>'period')::date; v_run public.eppd_pay_runs; v_exists boolean; n int;
begin
  if not public.eppd_has_role(array['admin','hr']) then raise exception 'Only HR and admins can prepare payroll.'; end if;
  if v_period is null or extract(day from v_period) <> 1 then raise exception 'Period must be the first day of a month.'; end if;
  select * into v_run from public.eppd_pay_runs where period = v_period for update;
  v_exists := found;   -- PERFORM resets FOUND, so keep the answer
  if v_exists and v_run.status = 'finalised' then raise exception 'This month is finalised. Ask an admin to reopen it.'; end if;
  if v_exists and coalesce(p->>'expected_updated_at', '') = '' then
    raise exception 'Someone else started this month after you opened it. Reload the page to see their figures; nothing was saved.';
  end if;
  if v_exists and (p->>'expected_updated_at')::timestamptz is distinct from v_run.updated_at then
    raise exception 'Someone else saved this month after you opened it. Reload the page to see their changes; nothing was saved.';
  end if;
  perform set_config('eppd.skip_audit', 'on', true);
  if not v_exists then
    insert into public.eppd_pay_runs (period, notes, totals) values (v_period, p->>'notes', coalesce(p->'totals', '{}'::jsonb))
    returning * into v_run;
  else
    update public.eppd_pay_runs set notes = p->>'notes', totals = coalesce(p->'totals', '{}'::jsonb) where id = v_run.id
    returning * into v_run;
    delete from public.eppd_pay_lines where run_id = v_run.id;
  end if;
  n := public.eppd_insert_pay_lines(v_run.id, p->'lines');
  perform set_config('eppd.skip_audit', 'off', true);
  perform public.eppd_pay_log('PAY_SAVE', jsonb_build_object('run_id', v_run.id, 'period', v_period, 'lines', n) || coalesce(p->'totals'->'all', '{}'::jsonb));
  return jsonb_build_object('run_id', v_run.id, 'lines', n, 'updated_at', v_run.updated_at);
end $$;

-- ---------- finalise (admin + hr): locks the month ----------
create or replace function public.eppd_finalise_pay_run(p_run bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_run public.eppd_pay_runs; n int;
begin
  if not public.eppd_has_role(array['admin','hr']) then raise exception 'Only HR and admins can finalise payroll.'; end if;
  select * into v_run from public.eppd_pay_runs where id = p_run for update;
  if v_run.id is null then raise exception 'Pay run not found.'; end if;
  if v_run.status = 'finalised' then raise exception 'This month is already finalised.'; end if;
  select count(*) into n from public.eppd_pay_lines where run_id = p_run and not excluded;
  if n = 0 then raise exception 'There are no lines to finalise.'; end if;
  perform set_config('eppd.pay_unlock', 'on', true);
  update public.eppd_pay_runs set status = 'finalised', finalised_at = now(), finalised_by = auth.uid() where id = p_run;
  perform set_config('eppd.pay_unlock', 'off', true);
  perform public.eppd_pay_log('PAY_FINALISE', jsonb_build_object('run_id', p_run, 'period', v_run.period, 'lines', n) || coalesce(v_run.totals->'all', '{}'::jsonb));
  return jsonb_build_object('run_id', p_run, 'lines', n);
end $$;

-- ---------- reopen (admin only, reason required) ----------
create or replace function public.eppd_reopen_pay_run(p_run bigint, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_run public.eppd_pay_runs;
begin
  if not public.eppd_is_admin() then raise exception 'Only an admin can reopen a finalised month.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason for reopening.'; end if;
  select * into v_run from public.eppd_pay_runs where id = p_run for update;
  if v_run.id is null then raise exception 'Pay run not found.'; end if;
  if v_run.status <> 'finalised' then raise exception 'This month is not finalised.'; end if;
  perform set_config('eppd.pay_unlock', 'on', true);
  update public.eppd_pay_runs set status = 'draft', reopened_at = now(), reopened_by = auth.uid(), reopen_reason = trim(p_reason)
   where id = p_run;
  perform set_config('eppd.pay_unlock', 'off', true);
  perform public.eppd_pay_log('PAY_REOPEN', jsonb_build_object('run_id', p_run, 'period', v_run.period, 'reason', trim(p_reason)));
  return jsonb_build_object('run_id', p_run);
end $$;

-- ---------- import past months from the workbook (admin; finalised, re-runnable) ----------
-- p: { runs:[{ period, totals, lines:[...] }] }
-- Never replaces a month made in the app, or an imported month that was reopened (and possibly corrected).
create or replace function public.eppd_import_pay_history(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; v_period date; v_run public.eppd_pay_runs; v_exists boolean; n_runs int := 0; n_lines int := 0;
begin
  if not public.eppd_is_admin() then raise exception 'Only admins can import payroll history.'; end if;
  perform set_config('eppd.skip_audit', 'on', true);
  perform set_config('eppd.pay_unlock', 'on', true);
  for r in select * from jsonb_array_elements(coalesce(p->'runs', '[]'::jsonb)) loop
    v_period := (r->>'period')::date;
    select * into v_run from public.eppd_pay_runs where period = v_period for update;
    v_exists := found;
    if v_exists and v_run.source <> 'import' then
      raise exception '% already has a pay run made in the app; it was not replaced. Nothing was imported.', to_char(v_period, 'Mon YYYY');
    end if;
    if v_exists and v_run.reopened_at is not null then
      raise exception '% was reopened and changed in the app; it was not replaced. Nothing was imported.', to_char(v_period, 'Mon YYYY');
    end if;
    if v_exists then delete from public.eppd_pay_runs where id = v_run.id; end if;
    insert into public.eppd_pay_runs (period, status, source, totals, notes, finalised_at, finalised_by)
    values (v_period, 'finalised', 'import', coalesce(r->'totals', '{}'::jsonb), 'Imported from the MEG-EPPD workbook', now(), auth.uid())
    returning * into v_run;
    n_lines := n_lines + public.eppd_insert_pay_lines(v_run.id, r->'lines');
    n_runs := n_runs + 1;
  end loop;
  perform set_config('eppd.pay_unlock', 'off', true);
  perform set_config('eppd.skip_audit', 'off', true);
  perform public.eppd_pay_log('PAY_IMPORT', jsonb_build_object('months', n_runs, 'lines', n_lines, 'source', p->>'source'));
  return jsonb_build_object('months', n_runs, 'lines', n_lines);
end $$;

revoke execute on function public.eppd_insert_pay_lines(bigint, jsonb), public.eppd_pay_log(text, jsonb),
  public.eppd_save_pay_run(jsonb), public.eppd_finalise_pay_run(bigint), public.eppd_reopen_pay_run(bigint, text),
  public.eppd_import_pay_history(jsonb), public.eppd_log_summary(text, text, jsonb) from public, anon;
revoke execute on function public.eppd_insert_pay_lines(bigint, jsonb), public.eppd_pay_log(text, jsonb) from authenticated;
grant execute on function public.eppd_save_pay_run(jsonb), public.eppd_finalise_pay_run(bigint), public.eppd_reopen_pay_run(bigint, text),
  public.eppd_import_pay_history(jsonb), public.eppd_log_summary(text, text, jsonb) to authenticated;

-- ---------- payroll policy (never overwrites your edits) ----------
insert into public.eppd_policies (key, value, description) values
 ('payroll', '{
    "daily_rate_divisor": 26,
    "default_normal_hours": 8,
    "unpaid_leave_basis": "calendar_days",
    "prorate_basis": "calendar_days",
    "pcb_carry_forward": true,
    "rates": {"OT_NORMAL": 1.5, "OT_OFFDAY": 1.5, "RD_HALF": 0.5, "RD_FULL": 1, "RD_EXCESS": 2, "PH_NORMAL": 2, "PH_EXCESS": 3}
  }'::jsonb,
  'Monthly payroll. Daily rate = basic ÷ daily_rate_divisor (Employment Act: 26); hourly rate = daily rate ÷ normal hours. Rest-day and public-holiday days use the daily rate; OT hours use the hourly rate. Unpaid leave and part months use calendar days (as the workbook did).')
on conflict (key) do nothing;
