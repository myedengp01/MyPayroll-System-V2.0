-- =====================================================================
-- MyPayroll-System-V2.0  ·  001_foundation.sql  ·  UVN v2026.10.05-12:00
-- Run FIRST in the MyPayroll-System Supabase project (SQL Editor).
-- Creates ONLY new eppd_* objects. No MyPRSys table is touched.
-- Safe to re-run (idempotent).
-- =====================================================================

-- ---------- shared trigger: updated_at --------------------------------
create or replace function public.eppd_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------- access: roles per app user --------------------------------
create table if not exists public.eppd_user_roles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  display_name text,
  role         text not null default 'viewer'
               check (role in ('admin','hr','approver','viewer')),
  status       text not null default 'pending'
               check (status in ('pending','active','disabled')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
drop trigger if exists eppd_user_roles_touch on public.eppd_user_roles;
create trigger eppd_user_roles_touch before update on public.eppd_user_roles
  for each row execute function public.eppd_touch();

-- SECURITY DEFINER helpers (avoid RLS self-recursion on eppd_user_roles)
create or replace function public.eppd_my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.eppd_user_roles
  where user_id = auth.uid() and status = 'active'
$$;

create or replace function public.eppd_is_active()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.eppd_user_roles
                 where user_id = auth.uid() and status = 'active')
$$;

create or replace function public.eppd_has_role(roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.eppd_my_role() = any(roles), false)
$$;

create or replace function public.eppd_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.eppd_has_role(array['admin'])
$$;

grant execute on function public.eppd_my_role(), public.eppd_is_active(),
  public.eppd_has_role(text[]), public.eppd_is_admin() to authenticated;

-- Guard: never leave the app with zero active admins
create or replace function public.eppd_guard_last_admin()
returns trigger language plpgsql security definer set search_path = public as $$
declare remaining int;
begin
  if (tg_op = 'DELETE' and old.role = 'admin' and old.status = 'active')
     or (tg_op = 'UPDATE' and old.role = 'admin' and old.status = 'active'
         and (new.role <> 'admin' or new.status <> 'active')) then
    select count(*) into remaining from public.eppd_user_roles
     where role = 'admin' and status = 'active' and user_id <> old.user_id;
    if remaining = 0 then
      raise exception 'At least one active admin is required.';
    end if;
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists eppd_user_roles_guard on public.eppd_user_roles;
create trigger eppd_user_roles_guard before update or delete on public.eppd_user_roles
  for each row execute function public.eppd_guard_last_admin();

alter table public.eppd_user_roles enable row level security;
drop policy if exists eppd_ur_select on public.eppd_user_roles;
drop policy if exists eppd_ur_insert_self on public.eppd_user_roles;
drop policy if exists eppd_ur_update_admin on public.eppd_user_roles;
drop policy if exists eppd_ur_delete_admin on public.eppd_user_roles;
create policy eppd_ur_select on public.eppd_user_roles for select to authenticated
  using (user_id = auth.uid() or public.eppd_is_admin());
-- first sign-in: a user may register themselves, but only as pending viewer
create policy eppd_ur_insert_self on public.eppd_user_roles for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending' and role = 'viewer');
create policy eppd_ur_update_admin on public.eppd_user_roles for update to authenticated
  using (public.eppd_is_admin()) with check (public.eppd_is_admin());
create policy eppd_ur_delete_admin on public.eppd_user_roles for delete to authenticated
  using (public.eppd_is_admin());

-- ---------- audit log -------------------------------------------------
create table if not exists public.eppd_audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  user_id     uuid,
  user_email  text,
  table_name  text not null,
  row_id      text,
  action      text not null,
  old_data    jsonb,
  new_data    jsonb
);
create index if not exists eppd_audit_at_idx on public.eppd_audit_log (at desc);
create index if not exists eppd_audit_tbl_idx on public.eppd_audit_log (table_name);

create or replace function public.eppd_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare o jsonb; n jsonb; rid text;
begin
  if tg_op <> 'INSERT' then o := to_jsonb(old) - 'logo'; end if;
  if tg_op <> 'DELETE' then n := to_jsonb(new) - 'logo'; end if;
  -- logos are large base64 strings: record only that they changed
  if tg_op = 'UPDATE' and tg_table_name = 'eppd_companies'
     and (to_jsonb(old)->>'logo') is distinct from (to_jsonb(new)->>'logo') then
    n := n || jsonb_build_object('logo_changed', true);
  end if;
  rid := coalesce(n->>'id', o->>'id', n->>'user_id', o->>'user_id', n->>'key', o->>'key');
  insert into public.eppd_audit_log (user_id, user_email, table_name, row_id, action, old_data, new_data)
  values (auth.uid(), (select email from auth.users where id = auth.uid()),
          tg_table_name, rid, tg_op, o, n);
  return coalesce(new, old);
end $$;

alter table public.eppd_audit_log enable row level security;
drop policy if exists eppd_audit_select on public.eppd_audit_log;
create policy eppd_audit_select on public.eppd_audit_log for select to authenticated
  using (public.eppd_is_admin());
-- no insert/update/delete policies: only the SECURITY DEFINER trigger writes here

-- ---------- master data ----------------------------------------------
create table if not exists public.eppd_companies (
  id                 bigint generated always as identity primary key,
  code               text not null unique,
  name               text not null,
  short_name         text,
  registration_no    text,
  epf_employer_no    text,
  socso_employer_no  text,
  tax_employer_no    text,          -- LHDN E-number
  address            text,
  phone              text,
  email              text,
  logo               text,          -- data URL (PNG/WebP), resized client-side
  is_primary         boolean not null default false,  -- shown on login screen
  is_active          boolean not null default true,
  sort_order         int not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.eppd_departments (
  id          bigint generated always as identity primary key,
  code        text not null unique,
  name        text not null,
  company_id  bigint references public.eppd_companies(id) on delete set null,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.eppd_job_titles (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- generic pick-lists: gender, nationality, race, marital_status, bank,
-- job_status, confirmation_status, leave_type
create table if not exists public.eppd_lookups (
  id          bigint generated always as identity primary key,
  category    text not null,
  code        text not null,
  label       text not null,
  meta        jsonb not null default '{}'::jsonb,   -- e.g. nationality {"stat_class":"MY"}
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (category, code)
);

-- payment types: each item carries its own statutory treatment
create table if not exists public.eppd_payment_types (
  id             bigint generated always as identity primary key,
  code           text not null unique,
  name           text not null,
  kind           text not null check (kind in ('earning','deduction')),
  category       text not null default 'other',
  subject_epf    boolean not null default true,
  subject_socso  boolean not null default true,
  subject_eis    boolean not null default true,
  subject_pcb    boolean not null default true,
  is_recurring   boolean not null default false,
  is_system      boolean not null default false,   -- used by the payroll engine; cannot be deleted
  is_active      boolean not null default true,
  sort_order     int not null default 0,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- HR / payroll policies as JSON documents (notice period, AL bands, OT defaults ...)
create table if not exists public.eppd_policies (
  key          text primary key,
  value        jsonb not null,
  description  text,
  updated_at   timestamptz not null default now(),
  updated_by   uuid default auth.uid()
);

-- ---------- statutory tables (versioned by effective date) ------------
create table if not exists public.eppd_stat_versions (
  id              bigint generated always as identity primary key,
  scheme          text not null check (scheme in ('EPF','SOCSO','EIS')),
  variant         text not null,        -- EPF: STD/AGE60/FOREIGN · SOCSO: CAT1/CAT2 · EIS: STD
  effective_from  date not null,
  label           text not null,
  source          text,
  rule            jsonb,                -- percentage rule when no bracket table is used
  above_max       jsonb,                -- percentage rule for wages above the last bracket
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (scheme, variant, effective_from)
);

create table if not exists public.eppd_stat_brackets (
  id          bigint generated always as identity primary key,
  version_id  bigint not null references public.eppd_stat_versions(id) on delete cascade,
  wage_min    numeric(12,2) not null,
  wage_max    numeric(12,2),            -- null = no upper limit (contribution ceiling row)
  er          numeric(10,2) not null default 0,
  ee          numeric(10,2) not null default 0,
  ee_inv      numeric(10,2),            -- SOCSO from Jun 2026: invalidity portion
  ee_nei      numeric(10,2)             -- SOCSO from Jun 2026: non-employment injury portion
);
create index if not exists eppd_stat_br_idx on public.eppd_stat_brackets (version_id, wage_min);

-- ---------- public holidays -------------------------------------------
create table if not exists public.eppd_holidays (
  id            bigint generated always as identity primary key,
  holiday_date  date not null,
  name          text not null,
  scope         text not null default 'Johor',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (holiday_date, scope)
);

-- ---------- triggers: updated_at + audit on every master table --------
do $$
declare t text;
begin
  foreach t in array array['eppd_companies','eppd_departments','eppd_job_titles',
    'eppd_lookups','eppd_payment_types','eppd_policies','eppd_stat_versions','eppd_holidays']
  loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I
                    for each row execute function public.eppd_touch()', t, t);
  end loop;
  foreach t in array array['eppd_user_roles','eppd_companies','eppd_departments','eppd_job_titles',
    'eppd_lookups','eppd_payment_types','eppd_policies','eppd_stat_versions','eppd_holidays']
  loop
    execute format('drop trigger if exists %I_audit on public.%I', t, t);
    execute format('create trigger %I_audit after insert or update or delete on public.%I
                    for each row execute function public.eppd_audit()', t, t);
  end loop;
end $$;

-- ---------- RLS: read = any active user; write by role ----------------
do $$
declare t text; writers text;
begin
  for t, writers in
    select * from (values
      ('eppd_companies',     '{admin,hr}'),
      ('eppd_departments',   '{admin,hr}'),
      ('eppd_job_titles',    '{admin,hr}'),
      ('eppd_lookups',       '{admin,hr}'),
      ('eppd_holidays',      '{admin,hr}'),
      ('eppd_payment_types', '{admin}'),
      ('eppd_policies',      '{admin}'),
      ('eppd_stat_versions', '{admin}'),
      ('eppd_stat_brackets', '{admin}')
    ) as x(t, w)
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('drop policy if exists %I_write on public.%I', t, t);
    execute format('create policy %I_read on public.%I for select to authenticated
                    using (public.eppd_is_active())', t, t);
    execute format('create policy %I_write on public.%I for all to authenticated
                    using (public.eppd_has_role(%L::text[]))
                    with check (public.eppd_has_role(%L::text[]))', t, t, writers, writers);
  end loop;
end $$;

-- ---------- login-screen branding (anon-safe: names + logos only) -----
create or replace function public.eppd_brand()
returns table (code text, name text, short_name text, logo text)
language sql stable security definer set search_path = public as $$
  select code, name, short_name, logo from public.eppd_companies
  where is_primary and is_active order by sort_order, id
$$;
grant execute on function public.eppd_brand() to anon, authenticated;

-- ---------- bootstrap admin -------------------------------------------
insert into public.eppd_user_roles (user_id, email, display_name, role, status)
select id, email, 'CLC', 'admin', 'active' from auth.users
where lower(email) = 'trade12win@gmail.com'
on conflict (user_id) do update set role = 'admin', status = 'active';

-- quick check (should list your admin row):
-- select * from public.eppd_user_roles;
