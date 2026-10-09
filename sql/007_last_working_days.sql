-- =====================================================================
-- MyPayroll-System-V2.0  ·  007_last_working_days.sql  ·  UVN v2026.10.09-19:30
-- One-off data fix. Run in the MyPayroll-System project AFTER 001–006.
-- Seven former staff were marked Resigned / Dismissed in the workbook but had
-- no "Resigned Date", so the app treated them as still employed.
-- Sets their last working day (dates supplied by HR on 9 Oct 2026) and ends
-- their paying-company assignment on the same day.
-- Safe to re-run: only fills dates that are still empty. Every change is in the audit log.
-- =====================================================================

with fix(name_pattern, last_day) as (values
  ('RAIDEN LEE DONG%',   date '2026-09-04'),
  ('CHUA KUANG FA',      date '2024-11-30'),
  ('EU LEH SA',          date '2024-12-31'),
  ('LAI SOOK KUEN',      date '2024-07-31'),
  ('LEE HUI LIN',        date '2024-12-20'),
  ('OO KAH MENG',        date '2022-07-31'),
  ('JOSPIN SOOSIAPPAN',  date '2022-02-21')
),
target as (   -- each person's latest employment period that has no last day yet
  select distinct on (e.id) em.id as employment_id, f.last_day
  from fix f
  join public.eppd_employees e on upper(e.full_name) like f.name_pattern
  join public.eppd_employments em on em.employee_id = e.id
  where em.resigned_date is null and (em.join_date is null or em.join_date <= f.last_day)
  order by e.id, em.join_date desc nulls last
),
upd_em as (
  update public.eppd_employments em set resigned_date = t.last_day
  from target t where em.id = t.employment_id
  returning em.id, em.resigned_date
)
update public.eppd_assignments a set end_date = u.resigned_date
from upd_em u
where a.employment_id = u.id and a.end_date is null and (a.start_date is null or a.start_date <= u.resigned_date);

-- check: all seven should show their last working day
select e.full_name, em.join_date, em.resigned_date as last_working_day, em.confirmation_status as status
from public.eppd_employees e
join public.eppd_employments em on em.employee_id = e.id
where upper(e.full_name) like any (array['RAIDEN LEE DONG%','CHUA KUANG FA','EU LEH SA','LAI SOOK KUEN','LEE HUI LIN','OO KAH MENG','JOSPIN SOOSIAPPAN'])
order by e.full_name, em.join_date;
