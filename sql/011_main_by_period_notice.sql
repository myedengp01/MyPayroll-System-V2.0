-- MyPayroll-System-V2.0 · 011 (applied in the MyEden Group CMS database on 2026-10-19)
-- 1. The main paying company can change from a month: two records of one employment may both be marked main
--    as long as their dates do not overlap (was: one main record ever). A transfer keeps the old company's mark
--    for its own months.
-- 2. Notice period until stored on the employment, filled from the notice_period policy; HR can change it.
-- 3. eppd_employee_list: the company shown is the current one; adds notice_until.

create extension if not exists btree_gist with schema extensions;
alter table public.eppd_assignments
  add constraint eppd_assignments_one_main_per_period
  exclude using gist (employment_id with =, daterange(start_date, end_date, '[]') with &&) where (is_primary);
drop index if exists public.eppd_assignments_one_primary;

alter table public.eppd_employments add column if not exists notice_until date;
comment on column public.eppd_employments.notice_until is 'Last day of the notice period. Filled from the notice_period policy when a resignation letter date is entered; HR may change it (agreed shorter/longer notice).';

create or replace function public.eppd_notice_until(p_join date, p_letter date, p_probation boolean)
returns date language sql stable security definer set search_path = public, pg_temp as $$
  with pol as (select value v from public.eppd_policies where key = 'notice_period'),
  yrs as (select greatest(0, extract(year from age(p_letter, p_join))::int) y)
  select case when p_letter is null then null else p_letter + 7 * coalesce(
    case when p_probation or p_join is null then (select (v->>'probation_weeks')::int from pol)
         else (select (b->>'weeks')::int from pol, jsonb_array_elements(pol.v->'bands') b, yrs
               where yrs.y >= (b->>'from_years')::int and (b->>'to_years' is null or yrs.y < (b->>'to_years')::int) limit 1) end, 0) end;
$$;

-- a new or changed letter date (or join / confirmed date) recalculates, unless the same save sets notice_until by hand;
-- clearing the letter date clears it
create or replace function public.eppd_employments_notice()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.resignation_letter_date is null then
    if tg_op = 'UPDATE' and old.resignation_letter_date is not null and new.notice_until is not distinct from old.notice_until then new.notice_until := null; end if;
    return new;
  end if;
  if tg_op = 'INSERT' and new.notice_until is null
     or tg_op = 'UPDATE' and (new.resignation_letter_date is distinct from old.resignation_letter_date or new.join_date is distinct from old.join_date
                              or new.confirmed_date is distinct from old.confirmed_date)
        and new.notice_until is not distinct from old.notice_until then
    new.notice_until := public.eppd_notice_until(new.join_date, new.resignation_letter_date,
      new.confirmation_status = 'UP' or (new.confirmed_date is not null and new.confirmed_date > new.resignation_letter_date));
  end if;
  return new;
end $$;
create trigger eppd_employments_notice before insert or update on public.eppd_employments
  for each row execute function public.eppd_employments_notice();

create or replace view public.eppd_employee_list as
 SELECT e.id, e.emp_id, e.emp_serial, e.full_name, e.chinese_name, e.gender, e.nationality,
    cur.id AS employment_id, cur.join_date, cur.confirmation_status, cur.confirmed_date, cur.job_status,
    cur.resignation_letter_date, cur.resigned_date,
    d.id AS department_id, d.code AS department_code, d.name AS department_name,
    jt.id AS job_title_id, jt.name AS job_title,
    pc.id AS company_id, pc.code AS company_code, COALESCE(pc.short_name, pc.name) AS company_name,
    ( SELECT count(*) FROM eppd_assignments a2 WHERE a2.employment_id = cur.id) AS company_count,
    ( SELECT count(*) FROM eppd_employments m2 WHERE m2.employee_id = e.id) AS employment_count,
    e.updated_at, cur.notice_until
   FROM eppd_employees e
     LEFT JOIN LATERAL ( SELECT m.* FROM eppd_employments m WHERE m.employee_id = e.id
          ORDER BY m.join_date DESC NULLS LAST, m.id DESC LIMIT 1) cur ON true
     LEFT JOIN eppd_departments d ON d.id = cur.department_id
     LEFT JOIN eppd_job_titles jt ON jt.id = cur.job_title_id
     LEFT JOIN LATERAL ( SELECT c.* FROM eppd_assignments a JOIN eppd_companies c ON c.id = a.company_id
          WHERE a.employment_id = cur.id
          ORDER BY (a.end_date IS NULL OR a.end_date >= CURRENT_DATE) DESC, a.is_primary DESC, a.start_date DESC NULLS LAST, a.id DESC
         LIMIT 1) pc ON true;


-- MyPayroll's own transfer keeps the old company's main mark for its months too
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
  -- the old record keeps its main mark for its own months (011)
  update public.eppd_assignments set end_date = v_from - 1 where id = a.id;
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
