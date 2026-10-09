-- =====================================================================
-- MyPayroll-System-V2.0  ·  005_leave_time.sql  ·  UVN v2026.10.09-14:45
-- Run in the MyPayroll-System project AFTER 001–004. Safe to re-run.
-- Phase 3: leave records, leave adjustments (carry forward, buy-back,
-- forfeits, replacement leave earned), KPI grades, year-end close,
-- overtime / part-time hours (incl. OTCF pulls), workbook import.
-- Everything here is admin + HR only (leave includes health-related records).
-- =====================================================================

-- part-timers: contracted weekly hours (used to pro-rate leave)
alter table public.eppd_employments add column if not exists weekly_hours numeric(5,2);

-- ---------- policies (never overwrite your edits) ----------------------
insert into public.eppd_policies (key, value, description) values
 ('leave_rules', '{
    "SL":  {"bands":[{"until_years":2,"days":14},{"until_years":5,"days":18},{"until_years":null,"days":22}]},
    "HPL": {"days":60, "includes_sick_leave":true},
    "MTL": {"days":98, "count":"calendar", "gender":"F"},
    "PTL": {"days":7,  "count":"calendar", "gender":"M", "min_service_months":12, "married_only":true},
    "CPL": {"per_occasion":2, "per_year":4},
    "RL":  {},
    "UPL": {}
  }'::jsonb, 'Leave entitlements (Employment Act minimums; compassionate leave is company policy). Annual leave bands live in al_entitlement.'),
 ('working_week', '{"rest_days":[0], "off_days":[6]}'::jsonb,
  'Days not counted as leave: 0 = Sunday (rest day), 6 = Saturday (off day). Public holidays are skipped too.'),
 ('carry_forward', '{
    "confirmed_only": true,
    "grades": {"E":6, "S":3, "A":1, "I":0, "U":0},
    "grade_labels": {"E":"Excellent", "S":"Satisfactory", "A":"Average", "I":"Needs improvement", "U":"Under performing"},
    "buyback_grades": ["E","S","A"],
    "buyback_options": [50, 25, 10],
    "expiry": null
  }'::jsonb, 'Year-end annual leave carry forward by KPI grade (confirmed staff only). Unused days above the cap may be bought back (E/S/A) or are forfeited. expiry = null or "MM-DD" in the following year.'),
 ('part_time', '{"full_time_weekly_hours":45, "prorate":["AL","SL"], "rounding":"half_up"}'::jsonb,
  'Part-time leave = full-time entitlement × (contracted weekly hours ÷ full-time weekly hours).')
on conflict (key) do nothing;

-- ---------- leave taken ------------------------------------------------
create table if not exists public.eppd_leave_records (
  id            bigint generated always as identity primary key,
  employee_id   bigint not null references public.eppd_employees(id) on delete cascade,
  leave_type    text not null,                       -- eppd_lookups(leave_type).code: AL SL HPL MTL PTL RL CPL UPL
  date_from     date not null,
  date_to       date not null,
  half_day      text not null default 'none' check (half_day in ('none','am','pm')),
  days          numeric(6,2) not null check (days >= 0),
  days_override boolean not null default false,      -- HR typed the day count instead of the automatic count
  status        text not null default 'taken' check (status in ('taken','cancelled')),
  source        text not null default 'manual' check (source in ('manual','import')),
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  check (date_to >= date_from)
);
create index if not exists eppd_leave_records_emp_idx on public.eppd_leave_records (employee_id, date_from);

-- carry forward, opening balances, replacement leave earned, buy-back, forfeits, manual corrections
create table if not exists public.eppd_leave_adjustments (
  id              bigint generated always as identity primary key,
  employee_id     bigint not null references public.eppd_employees(id) on delete cascade,
  leave_type      text not null default 'AL',
  year            int  not null,
  kind            text not null check (kind in ('carry_forward','opening','earned','manual','buyback','forfeit','expired')),
  days            numeric(6,2) not null,
  effective_date  date,
  expires_on      date,                               -- carry forward only
  buyback_pct     numeric(5,2),                       -- buyback only (e.g. 50 = paid at 50% of the daily rate)
  close_year      int,                                -- set when created by a year-end close
  source          text not null default 'manual' check (source in ('manual','import','year_close')),
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid default auth.uid()
);
create index if not exists eppd_leave_adj_emp_idx on public.eppd_leave_adjustments (employee_id, year);

create table if not exists public.eppd_kpi_ratings (
  id           bigint generated always as identity primary key,
  employee_id  bigint not null references public.eppd_employees(id) on delete cascade,
  year         int not null,
  grade        text not null check (grade in ('E','S','A','I','U')),
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (employee_id, year)
);

create table if not exists public.eppd_leave_year_closes (
  year       int primary key,
  closed_at  timestamptz not null default now(),
  closed_by  uuid default auth.uid(),
  summary    jsonb
);

-- ---------- overtime & part-time hours ---------------------------------
-- Categories follow the Employment Act and the workbook's ALMC columns:
--   OT_NORMAL  normal working day, after normal hours          (pay 1.5x hourly)
--   OT_OFFDAY  off day (Saturday)                              (pay 1.5x hourly, company rule)
--   RD_HALF    rest day, up to half the normal hours           (half a day's pay)
--   RD_FULL    rest day, more than half, up to normal hours    (one day's pay)
--   RD_EXCESS  rest day, hours beyond normal hours             (2x hourly)
--   PH_NORMAL  public holiday, up to normal hours              (2 days' pay)
--   PH_EXCESS  public holiday, hours beyond normal hours       (3x hourly)
--   PT_HOURS   part-timer hours worked
create table if not exists public.eppd_time_entries (
  id                  bigint generated always as identity primary key,
  employee_id         bigint not null references public.eppd_employees(id) on delete cascade,
  work_date           date not null,
  category            text not null check (category in ('OT_NORMAL','OT_OFFDAY','RD_HALF','RD_FULL','RD_EXCESS','PH_NORMAL','PH_EXCESS','PT_HOURS')),
  hours               numeric(6,2) not null check (hours >= 0),
  from_time           time,
  to_time             time,
  source              text not null default 'manual' check (source in ('manual','otcf','import')),
  otcf_submission_id  text,
  otcf_serial         text,
  otcf_line           int,
  note                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid default auth.uid()
);
create index if not exists eppd_time_entries_emp_idx on public.eppd_time_entries (employee_id, work_date);
create unique index if not exists eppd_time_entries_otcf_uq on public.eppd_time_entries (otcf_submission_id, otcf_line, category)
  where otcf_submission_id is not null;

-- OTCF stores the claimant's typed name; remember which employee each name belongs to
create table if not exists public.eppd_otcf_links (
  id           bigint generated always as identity primary key,
  otcf_name    text not null unique,                  -- normalised: upper case, single spaces
  employee_id  bigint not null references public.eppd_employees(id) on delete cascade,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------- triggers + RLS (admin + hr only) ---------------------------
do $$
declare t text;
begin
  foreach t in array array['eppd_leave_records','eppd_leave_adjustments','eppd_kpi_ratings',
                           'eppd_time_entries','eppd_otcf_links']
  loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I
                    for each row execute function public.eppd_touch()', t, t);
  end loop;
  foreach t in array array['eppd_leave_records','eppd_leave_adjustments','eppd_kpi_ratings',
                           'eppd_time_entries','eppd_otcf_links','eppd_leave_year_closes']
  loop
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

-- ---------- summary line in the audit log for bulk actions -------------
create or replace function public.eppd_log_summary(p_table text, p_action text, p_data jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.eppd_has_role(array['admin','hr']) then raise exception 'Not allowed.'; end if;
  if p_action not in ('IMPORT','YEAR_CLOSE','OTCF_PULL') then raise exception 'Unknown action.'; end if;
  insert into public.eppd_audit_log (user_id, user_email, table_name, row_id, action, new_data)
  values (auth.uid(), (select email from auth.users where id = auth.uid()), p_table, null, p_action, p_data);
end $$;

-- ---------- workbook import (admin; re-runnable: replaces earlier imported rows only) ----------
create or replace function public.eppd_import_leave(p jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare x jsonb; n_rec int := 0; n_adj int := 0; n_time int := 0;
begin
  if not public.eppd_is_admin() then raise exception 'Only admins can run the workbook import.'; end if;
  perform set_config('eppd.skip_audit', 'on', true);
  delete from public.eppd_leave_records     where source = 'import';
  delete from public.eppd_leave_adjustments where source = 'import';
  delete from public.eppd_time_entries      where source = 'import';
  for x in select * from jsonb_array_elements(coalesce(p->'records', '[]'::jsonb)) loop
    insert into public.eppd_leave_records (employee_id, leave_type, date_from, date_to, days, days_override, source, note)
    values ((x->>'employee_id')::bigint, x->>'leave_type', (x->>'date_from')::date, (x->>'date_to')::date,
            (x->>'days')::numeric, true, 'import', x->>'note');
    n_rec := n_rec + 1;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p->'adjustments', '[]'::jsonb)) loop
    insert into public.eppd_leave_adjustments (employee_id, leave_type, year, kind, days, effective_date, buyback_pct, source, note)
    values ((x->>'employee_id')::bigint, x->>'leave_type', (x->>'year')::int, x->>'kind', (x->>'days')::numeric,
            nullif(x->>'effective_date', '')::date, nullif(x->>'buyback_pct', '')::numeric, 'import', x->>'note');
    n_adj := n_adj + 1;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p->'time', '[]'::jsonb)) loop
    insert into public.eppd_time_entries (employee_id, work_date, category, hours, source, note)
    values ((x->>'employee_id')::bigint, (x->>'work_date')::date, x->>'category', (x->>'hours')::numeric, 'import', x->>'note');
    n_time := n_time + 1;
  end loop;
  perform set_config('eppd.skip_audit', 'off', true);
  perform public.eppd_log_summary('eppd_leave_records', 'IMPORT',
    jsonb_build_object('source', p->>'source', 'leave_records', n_rec, 'adjustments', n_adj, 'time_entries', n_time));
  return jsonb_build_object('leave_records', n_rec, 'adjustments', n_adj, 'time_entries', n_time);
end $$;

-- ---------- year-end close (admin + hr; re-running a year replaces that year's close) ----------
-- p: { year, adjustments:[{employee_id, leave_type, year, kind, days, effective_date, expires_on, buyback_pct, note}], summary }
create or replace function public.eppd_close_leave_year(p jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare v_year int := (p->>'year')::int; x jsonb; n int := 0;
begin
  if not public.eppd_has_role(array['admin','hr']) then raise exception 'Only HR and admins can close a leave year.'; end if;
  if v_year is null then raise exception 'Year is required.'; end if;
  delete from public.eppd_leave_adjustments where source = 'year_close' and close_year = v_year;
  for x in select * from jsonb_array_elements(coalesce(p->'adjustments', '[]'::jsonb)) loop
    insert into public.eppd_leave_adjustments (employee_id, leave_type, year, kind, days, effective_date, expires_on,
           buyback_pct, close_year, source, note)
    values ((x->>'employee_id')::bigint, coalesce(x->>'leave_type', 'AL'), (x->>'year')::int, x->>'kind', (x->>'days')::numeric,
            nullif(x->>'effective_date', '')::date, nullif(x->>'expires_on', '')::date,
            nullif(x->>'buyback_pct', '')::numeric, v_year, 'year_close', x->>'note');
    n := n + 1;
  end loop;
  insert into public.eppd_leave_year_closes (year, closed_at, closed_by, summary)
  values (v_year, now(), auth.uid(), p->'summary')
  on conflict (year) do update set closed_at = now(), closed_by = auth.uid(), summary = excluded.summary;
  perform public.eppd_log_summary('eppd_leave_adjustments', 'YEAR_CLOSE', jsonb_build_object('year', v_year, 'adjustments', n) || coalesce(p->'summary', '{}'::jsonb));
  return jsonb_build_object('adjustments', n);
end $$;

-- ---------- save an OTCF pull (admin + hr; each claim line is saved once) ----------
-- p: { links:[{otcf_name, employee_id}], entries:[{employee_id, work_date, category, hours, from_time, to_time,
--      otcf_submission_id, otcf_serial, otcf_line, note}], month }
create or replace function public.eppd_save_otcf_pull(p jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare x jsonb; n int := 0; v_added int;
begin
  if not public.eppd_has_role(array['admin','hr']) then raise exception 'Only HR and admins can pull overtime claims.'; end if;
  for x in select * from jsonb_array_elements(coalesce(p->'links', '[]'::jsonb)) loop
    insert into public.eppd_otcf_links (otcf_name, employee_id) values (x->>'otcf_name', (x->>'employee_id')::bigint)
    on conflict (otcf_name) do update set employee_id = excluded.employee_id;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p->'entries', '[]'::jsonb)) loop
    insert into public.eppd_time_entries (employee_id, work_date, category, hours, from_time, to_time, source,
           otcf_submission_id, otcf_serial, otcf_line, note)
    values ((x->>'employee_id')::bigint, (x->>'work_date')::date, x->>'category', (x->>'hours')::numeric,
            nullif(x->>'from_time', '')::time, nullif(x->>'to_time', '')::time, 'otcf',
            x->>'otcf_submission_id', x->>'otcf_serial', (x->>'otcf_line')::int, x->>'note')
    on conflict (otcf_submission_id, otcf_line, category) where otcf_submission_id is not null do nothing;
    get diagnostics v_added = row_count; n := n + v_added;
  end loop;
  perform public.eppd_log_summary('eppd_time_entries', 'OTCF_PULL', jsonb_build_object('month', p->>'month', 'entries_added', n));
  return jsonb_build_object('entries_added', n);
end $$;

revoke execute on function public.eppd_log_summary(text, text, jsonb), public.eppd_import_leave(jsonb),
  public.eppd_close_leave_year(jsonb), public.eppd_save_otcf_pull(jsonb) from public, anon;
grant execute on function public.eppd_log_summary(text, text, jsonb), public.eppd_import_leave(jsonb),
  public.eppd_close_leave_year(jsonb), public.eppd_save_otcf_pull(jsonb) to authenticated;
