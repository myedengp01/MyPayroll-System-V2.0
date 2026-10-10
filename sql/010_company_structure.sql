-- =====================================================================
-- MyPayroll-System-V2.0  ·  010_company_structure.sql  ·  UVN v2026.10.10-19:00
-- Run in the MyPayroll-System project AFTER 001–009. Safe to re-run.
--
-- Puts the paying companies and departments in line with MyEden Group's structure:
--   Paying companies (active):  Myeden Group · Myeden Edu Hub · Happy Dino · Aborne Project
--   No longer paying (kept on record, inactive): Myeden Holding · Tadika Genius Eden · PJK Eden ·
--     Tadika Happy Dino · Eden Childcare · White Feather
--   Departments:  E1/E6/E7 Taska Genius Eden, E10/E11 Pusat Jagaan Kanak-Kanak Eden, HQ  → Myeden Group
--                 E3 Tadika Genius Eden, E3+ Tadika Happy Dino                           → Myeden Edu Hub
--                 E8 merged into HQ; E2, E4, E5, E9 switched off (former staff keep them on record)
-- Moves every paying-company record (current and former staff) off the inactive companies:
--   Tadika Genius Eden, Tadika Happy Dino → Myeden Edu Hub
--   PJK Eden, Eden Childcare, Myeden Holding → Myeden Group
-- then applies the per-person decisions below, and moves the 2026 payroll lines (finalised months
-- included) to the same companies. Only the company changes: no amount, total or status.
-- Also adds eppd_move_paying_company() used by Payroll › Paying companies.
-- =====================================================================

-- ---------- 1. companies ----------
update public.eppd_companies set name = 'Aborne Project Sdn. Bhd.', short_name = 'Aborne Project', is_active = true, is_primary = true where code = 'ABP';
update public.eppd_companies set is_active = true, is_primary = true where code in ('MEG', 'MEH', 'HD');
update public.eppd_companies set is_active = false, is_primary = false where code in ('MHD', 'TGE', 'PJKE', 'THD', 'EDC', 'WF');

-- ---------- 2. departments ----------
insert into public.eppd_departments (code, name, sort_order) values ('E3+', 'Tadika Happy Dino', 5), ('E11', 'Pusat Jagaan Kanak-Kanak Eden', 12)
on conflict (code) do nothing;
update public.eppd_departments d set name = v.name, company_id = c.id, is_active = true, sort_order = v.ord
from (values ('HQ', 'HQ', 'MEG', 1), ('E1', 'Taska Genius Eden', 'MEG', 2), ('E6', 'Taska Genius Eden', 'MEG', 3), ('E7', 'Taska Genius Eden', 'MEG', 4),
             ('E10', 'Pusat Jagaan Kanak-Kanak Eden', 'MEG', 5), ('E11', 'Pusat Jagaan Kanak-Kanak Eden', 'MEG', 6),
             ('E3', 'Tadika Genius Eden', 'MEH', 7), ('E3+', 'Tadika Happy Dino', 'MEH', 8)) as v(code, name, co, ord)
join public.eppd_companies c on c.code = v.co
where d.code = v.code;
-- E8 is HQ
update public.eppd_employments set department_id = (select id from public.eppd_departments where code = 'HQ')
 where department_id = (select id from public.eppd_departments where code = 'E8');
update public.eppd_departments set is_active = false where code in ('E8', 'E2', 'E4', 'E5', 'E9');

-- ---------- 3. company mapping (old → new) ----------
create temporary table if not exists eppd_co_map (old_code text primary key, new_code text);
truncate eppd_co_map;
insert into eppd_co_map values ('TGE', 'MEH'), ('THD', 'MEH'), ('PJKE', 'MEG'), ('EDC', 'MEG'), ('MHD', 'MEG');

-- per-person decisions (latest employment); names as recorded in the app
create temporary table if not exists eppd_person_co (full_name text primary key, co text, dept text);
truncate eppd_person_co;
insert into eppd_person_co values
  ('BEH YEN JUN', 'MEG', null), ('JESSICA CHONG YIHEN', 'MEG', null), ('WOO PEY YEE', 'MEG', null),
  ('BEE BEE HONG', 'MEG', null), ('CHONG CHIN LIN', 'MEG', null), ('TAN MEI SHY', 'MEG', null), ('TAN LAY LAY', 'MEG', null),
  ('JUANITA D''SALLE B. MACANAS', 'MEH', 'E3+'), ('WONG HUI MIN', 'MEH', 'E3+'), ('HONG MEI LING', 'MEH', null);

create temporary table if not exists eppd_co_report (step text, who text, from_co text, to_co text, n int);
truncate eppd_co_report;

do $$
declare r record; v_emp bigint; v_em bigint; v_co bigint; n int;
begin
  -- 3a. paying-company records on the inactive companies
  for r in select m.old_code, m.new_code, o.id as old_id, nw.id as new_id
             from eppd_co_map m join public.eppd_companies o on o.code = m.old_code join public.eppd_companies nw on nw.code = m.new_code loop
    update public.eppd_assignments set company_id = r.new_id where company_id = r.old_id;
    get diagnostics n = row_count;
    if n > 0 then insert into eppd_co_report values ('paying company records', 'all staff', r.old_code, r.new_code, n); end if;
    update public.eppd_loans set company_id = r.new_id where company_id = r.old_id;
    get diagnostics n = row_count;
    if n > 0 then insert into eppd_co_report values ('company loans', 'all staff', r.old_code, r.new_code, n); end if;
    update public.eppd_departments set company_id = null where company_id = r.old_id;
  end loop;

  -- 3b. per-person decisions
  for r in select p.*, c.id as co_id from eppd_person_co p join public.eppd_companies c on c.code = p.co loop
    select id into v_emp from public.eppd_employees where upper(full_name) = r.full_name order by id limit 1;
    if v_emp is null then insert into eppd_co_report values ('NOT FOUND — check this name', r.full_name, null, r.co, 0); continue; end if;
    select id into v_em from public.eppd_employments where employee_id = v_emp
      order by coalesce(join_date, '1900-01-01') desc, id desc limit 1;
    update public.eppd_assignments set company_id = r.co_id where employment_id = v_em and company_id <> r.co_id;
    get diagnostics n = row_count;
    insert into eppd_co_report values ('staff decision (records changed)', r.full_name, null, r.co, n);
    if r.dept is not null then
      update public.eppd_employments set department_id = (select id from public.eppd_departments where code = r.dept) where id = v_em;
    end if;
  end loop;
end $$;

-- ---------- 4. payroll lines: same companies (finalised months included) ----------
do $$
declare n int;
begin
  perform set_config('eppd.pay_unlock', 'on', true);
  perform set_config('eppd.skip_audit', 'on', true);
  -- lines follow the company of the paying-company record they were made from
  update public.eppd_pay_lines l set company_id = a.company_id
    from public.eppd_assignments a
   where a.id = l.assignment_id and l.company_id is distinct from a.company_id;
  get diagnostics n = row_count;
  insert into eppd_co_report values ('payroll lines moved (via paying company record)', 'all months', null, null, n);
  -- lines with no paying-company record left on an inactive company: use the mapping
  update public.eppd_pay_lines l set company_id = nw.id
    from eppd_co_map m join public.eppd_companies o on o.code = m.old_code join public.eppd_companies nw on nw.code = m.new_code
   where l.company_id = o.id;
  get diagnostics n = row_count;
  if n > 0 then insert into eppd_co_report values ('payroll lines moved (by company)', 'all months', null, null, n); end if;

  -- per-company totals of every month rebuilt from its lines (overall totals do not change)
  update public.eppd_pay_runs r set totals = jsonb_set(coalesce(r.totals, '{}'::jsonb), '{companies}', coalesce((
    select jsonb_object_agg(k, v) from (
      select coalesce(l.company_id, 0)::text as k, jsonb_build_object(
        'lines', count(*), 'gross', sum(l.gross), 'epf_ee', sum(l.epf_ee), 'epf_er', sum(l.epf_er), 'socso_ee', sum(l.socso_ee),
        'socso_ee_nei', sum(l.socso_ee_nei), 'socso_er', sum(l.socso_er), 'eis_ee', sum(l.eis_ee), 'eis_er', sum(l.eis_er), 'pcb', sum(l.pcb),
        'net', sum(l.net), 'personal_deductions', sum(l.personal_deductions), 'reimbursements', sum(l.reimbursements), 'net_paid', sum(l.net_paid),
        'employer_cost', sum(l.gross + l.epf_er + l.socso_er + l.eis_er)) as v
      from public.eppd_pay_lines l where l.run_id = r.id and not l.excluded group by 1) x), '{}'::jsonb))
  where jsonb_typeof(r.totals->'all') = 'object';

  perform set_config('eppd.pay_unlock', 'off', true);
  perform set_config('eppd.skip_audit', 'off', true);
end $$;

-- ---------- 5. move a person to another paying company from a given month (Payroll › Paying companies) ----------
-- If nothing has been paid on the old record before that month, the record simply changes company.
-- Otherwise the old record ends the day before and a new one starts that month, with the same salary
-- history, allowances and statutory switches, so earlier months (and their EA form) keep the old company.
create or replace function public.eppd_move_paying_company(p_assignment bigint, p_company bigint, p_from date)
returns bigint language plpgsql security definer set search_path = public as $$
declare a public.eppd_assignments; v_from date := date_trunc('month', p_from)::date; v_new bigint; v_paid boolean; v_fin text;
begin
  if not public.eppd_has_role(array['admin','hr']) then raise exception 'Only admin or HR can change paying companies.'; end if;
  select * into a from public.eppd_assignments where id = p_assignment for update;
  if not found then raise exception 'Paying company record not found.'; end if;
  if not exists (select 1 from public.eppd_companies where id = p_company and is_active) then raise exception 'Choose an active paying company.'; end if;
  if a.company_id = p_company then return a.id; end if;
  if a.end_date is not null and a.end_date < v_from then raise exception 'This record already ended on %.', a.end_date; end if;
  select string_agg(to_char(r.period, 'Mon YYYY'), ', ' order by r.period) into v_fin
    from public.eppd_pay_lines l join public.eppd_pay_runs r on r.id = l.run_id
   where l.assignment_id = a.id and r.period >= v_from and r.status = 'finalised';
  if v_fin is not null then raise exception 'Already finalised under the current company: %. Choose a later month, or ask an admin to reopen it.', v_fin; end if;
  select exists (select 1 from public.eppd_pay_lines l join public.eppd_pay_runs r on r.id = l.run_id
                  where l.assignment_id = a.id and r.period < v_from) into v_paid;
  if not v_paid and (a.start_date is null or a.start_date >= v_from or not exists (select 1 from public.eppd_pay_lines where assignment_id = a.id)) then
    update public.eppd_assignments set company_id = p_company where id = a.id;
    return a.id;
  end if;
  -- split: old record ends, new one starts
  update public.eppd_assignments set is_primary = false, end_date = v_from - 1 where id = a.id;
  insert into public.eppd_assignments (employment_id, company_id, is_primary, start_date, end_date, epf_ee, epf_er, socso_ee, socso_er, eis_ee, eis_er, socso_nei_opt_out)
  values (a.employment_id, p_company, a.is_primary, v_from, a.end_date, a.epf_ee, a.epf_er, a.socso_ee, a.socso_er, a.eis_ee, a.eis_er, a.socso_nei_opt_out)
  returning id into v_new;
  insert into public.eppd_salary_history (assignment_id, effective_from, amount, pay_basis, reason, note)
  select v_new, effective_from, amount, pay_basis, reason, note from public.eppd_salary_history where assignment_id = a.id;
  insert into public.eppd_allowances (assignment_id, payment_type_id, amount, start_date, end_date, note)
  select v_new, payment_type_id, amount, greatest(coalesce(start_date, v_from), v_from), end_date, note
    from public.eppd_allowances where assignment_id = a.id and (end_date is null or end_date >= v_from);
  return v_new;
end $$;
revoke execute on function public.eppd_move_paying_company(bigint, bigint, date) from public, anon;
grant execute on function public.eppd_move_paying_company(bigint, bigint, date) to authenticated;

-- let the API see the new function straight away
notify pgrst, 'reload schema';

-- ---------- result ----------
select step, who, from_co, to_co, n as records from eppd_co_report
union all
select 'current staff now paid by', c.short_name, null, null, count(distinct em.employee_id)::int
  from public.eppd_assignments a join public.eppd_employments em on em.id = a.employment_id join public.eppd_companies c on c.id = a.company_id
 where (em.resigned_date is null or em.resigned_date >= current_date) and (a.end_date is null or a.end_date >= current_date)
 group by c.short_name
union all
select '2026 payroll lines now under', c.short_name, null, null, count(*)::int
  from public.eppd_pay_lines l join public.eppd_pay_runs r on r.id = l.run_id left join public.eppd_companies c on c.id = l.company_id
 where r.period >= '2026-01-01' group by c.short_name;
