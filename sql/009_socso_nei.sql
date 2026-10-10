-- =====================================================================
-- MyPayroll-System-V2.0  ·  009_socso_nei.sql  ·  UVN v2026.10.10-17:45
-- Run in the MyPayroll-System project AFTER 001–008. Safe to re-run.
--
-- Keeps the employee's SOCSO in two parts on every pay line:
--   invalidity  +  non-employment injury (NEI, from June 2026)
-- New column eppd_pay_lines.socso_ee_nei (invalidity = socso_ee − socso_ee_nei).
--
-- Months already saved (imported Jan–Sep 2026 and any month made in the app) are filled in by
-- matching each employee SOCSO amount against the SOCSO table in force that month:
--   amount = invalidity + NEI  → NEI from the table
--   amount = invalidity only   → NEI 0 (opted out)
--   before the NEI table       → NEI 0 (all invalidity)
-- No amount, total or status changes; only how the existing employee SOCSO divides.
-- Lines that match no table row are listed at the end and left at NEI 0.
-- =====================================================================

alter table public.eppd_pay_lines add column if not exists socso_ee_nei numeric(12,2) not null default 0;

-- ---------- save path: include the NEI part ----------
create or replace function public.eppd_insert_pay_lines(p_run bigint, p_lines jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare x jsonb; n int := 0;
begin
  for x in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    insert into public.eppd_pay_lines (run_id, employee_id, assignment_id, company_id, emp_name, emp_code, mode, excluded,
      items, overrides, inputs, warnings, gross, epf_wage, socso_wage, eis_wage, epf_ee, epf_er, socso_ee, socso_ee_nei, socso_er,
      eis_ee, eis_er, pcb, net, personal_deductions, reimbursements, net_paid, note)
    values (p_run, (x->>'employee_id')::bigint, nullif(x->>'assignment_id', '')::bigint, nullif(x->>'company_id', '')::bigint,
      x->>'emp_name', x->>'emp_code', coalesce(x->>'mode', 'auto'), coalesce((x->>'excluded')::boolean, false),
      coalesce(x->'items', '[]'::jsonb), coalesce(x->'overrides', '{}'::jsonb), coalesce(x->'inputs', '{}'::jsonb),
      coalesce(x->'warnings', '[]'::jsonb),
      coalesce((x->>'gross')::numeric, 0), coalesce((x->>'epf_wage')::numeric, 0), coalesce((x->>'socso_wage')::numeric, 0),
      coalesce((x->>'eis_wage')::numeric, 0), coalesce((x->>'epf_ee')::numeric, 0), coalesce((x->>'epf_er')::numeric, 0),
      coalesce((x->>'socso_ee')::numeric, 0), coalesce((x->>'socso_ee_nei')::numeric, 0), coalesce((x->>'socso_er')::numeric, 0),
      coalesce((x->>'eis_ee')::numeric, 0), coalesce((x->>'eis_er')::numeric, 0), coalesce((x->>'pcb')::numeric, 0),
      coalesce((x->>'net')::numeric, 0), coalesce((x->>'personal_deductions')::numeric, 0),
      coalesce((x->>'reimbursements')::numeric, 0), coalesce((x->>'net_paid')::numeric, 0), x->>'note');
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.eppd_insert_pay_lines(bigint, jsonb) from public, anon, authenticated;

-- ---------- fill in months already saved ----------
create temporary table if not exists eppd_nei_fill (line_id bigint primary key, period date, emp_name text, socso_ee numeric, nei numeric, matched boolean);
truncate eppd_nei_fill;

insert into eppd_nei_fill (line_id, period, emp_name, socso_ee, nei, matched)
select l.id, r.period, l.emp_name, l.socso_ee, m.nei, m.nei is not null
from public.eppd_pay_lines l
join public.eppd_pay_runs r on r.id = l.run_id
left join lateral (
  -- the bracket in force for this month and wage, First Category first, then Second Category
  select case when abs(l.socso_ee - b.ee) < 0.005 then least(l.socso_ee, coalesce(b.ee_nei, 0))
              when abs(l.socso_ee - b.ee_inv) < 0.005 then 0 end as nei
  from (values (1, 'CAT1'), (2, 'CAT2')) as cat(ord, variant)
  cross join lateral (
    select v.id from public.eppd_stat_versions v
    where v.scheme = 'SOCSO' and v.variant = cat.variant and coalesce(v.is_active, true) and v.effective_from <= r.period
    order by v.effective_from desc limit 1) ver
  cross join lateral (
    select * from public.eppd_stat_brackets b
    where b.version_id = ver.id and b.wage_min <= round(l.socso_wage, 2) + 0.000001
    order by b.wage_min desc limit 1) b
  where b.ee_inv is not null
    and (abs(l.socso_ee - b.ee) < 0.005 or abs(l.socso_ee - b.ee_inv) < 0.005)
  order by cat.ord limit 1
) m on true
where l.socso_ee > 0;

-- months before the NEI table (no split columns in force): all invalidity
update eppd_nei_fill f set nei = 0, matched = true
where not f.matched and not exists (
  select 1 from public.eppd_stat_versions v join public.eppd_stat_brackets b on b.version_id = v.id
  where v.scheme = 'SOCSO' and coalesce(v.is_active, true) and v.effective_from <= f.period and b.ee_inv is not null);

do $$
begin
  -- these are finalised months: switch the payroll lock and the per-row audit off for this one update only
  perform set_config('eppd.pay_unlock', 'on', true);
  perform set_config('eppd.skip_audit', 'on', true);
  update public.eppd_pay_lines l
     set socso_ee_nei = f.nei,
         overrides = case when l.mode = 'fixed' then coalesce(l.overrides, '{}'::jsonb) || jsonb_build_object('socso_ee_nei', f.nei) else l.overrides end
    from eppd_nei_fill f
   where f.line_id = l.id and f.matched and l.socso_ee_nei is distinct from f.nei;
  -- run totals ({all, companies}) carry the NEI total too
  update public.eppd_pay_runs r
     set totals = jsonb_set(
           jsonb_set(r.totals, '{all}', coalesce(r.totals->'all', '{}'::jsonb) || jsonb_build_object('socso_ee_nei',
             (select coalesce(sum(l.socso_ee_nei), 0) from public.eppd_pay_lines l where l.run_id = r.id and not l.excluded))),
           '{companies}', coalesce((
             select jsonb_object_agg(e.k, e.v || jsonb_build_object('socso_ee_nei',
               (select coalesce(sum(l.socso_ee_nei), 0) from public.eppd_pay_lines l
                 where l.run_id = r.id and not l.excluded and coalesce(l.company_id, 0)::text = e.k)))
             from jsonb_each(r.totals->'companies') as e(k, v)), '{}'::jsonb))
   where jsonb_typeof(r.totals->'all') = 'object';
  perform set_config('eppd.pay_unlock', 'off', true);
  perform set_config('eppd.skip_audit', 'off', true);
end $$;

-- ---------- result (one row per month) ----------
-- could_not_split lists anyone whose employee SOCSO fits no table row; they keep NEI 0 — check them in Payroll
select to_char(period, 'Mon YYYY') as month,
       count(*)                                   as lines_with_socso,
       count(*) filter (where matched and nei > 0) as with_nei,
       count(*) filter (where matched and nei = 0) as invalidity_only,
       sum(nei) filter (where matched)             as nei_total,
       coalesce(string_agg(emp_name || ' (RM' || socso_ee || ')', ', ') filter (where not matched), '') as could_not_split
from eppd_nei_fill group by period order by period;
