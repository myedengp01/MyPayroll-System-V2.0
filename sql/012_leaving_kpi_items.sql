-- MyPayroll-System-V2.0 · 012 (applied in the MyEden Group CMS database on 2026-10-20)
-- PRI-002 leaving reasons + rehire eligibility · PRI-003 item-type statutory treatment · PRI-004 KPI carry forward
-- Additive only.

-- ---------------------------------------------------------------- PRI-002
alter table public.eppd_employments
  add column if not exists leaving_reason text,
  add column if not exists leaving_note text,
  add column if not exists rehire_eligibility text check (rehire_eligibility in ('eligible', 'conditional', 'not_eligible')),
  add column if not exists rehire_note text;
comment on column public.eppd_employments.leaving_reason is 'Code from eppd_lookups (category leaving_reason). Required whenever a last working day is recorded.';

insert into public.eppd_lookups (category, code, label, meta, is_active, sort_order) values
  ('leaving_reason', 'RS_STUDY', 'Resigned – further studies', '{}', true, 1),
  ('leaving_reason', 'RS_CAREER', 'Resigned – better offer / career change', '{}', true, 2),
  ('leaving_reason', 'RS_RELOC', 'Resigned – relocation', '{}', true, 3),
  ('leaving_reason', 'RS_FAMILY', 'Resigned – personal / family', '{}', true, 4),
  ('leaving_reason', 'HEALTH', 'Health', '{}', true, 5),
  ('leaving_reason', 'CONTRACT_END', 'Contract ended', '{}', true, 6),
  ('leaving_reason', 'NOT_CONFIRMED', 'Not confirmed after probation', '{}', true, 7),
  ('leaving_reason', 'TERM_PERF', 'Terminated – performance', '{}', true, 8),
  ('leaving_reason', 'TERM_MISC', 'Terminated – misconduct', '{}', true, 9),
  ('leaving_reason', 'DISMISSED', 'Dismissed', '{}', true, 10),
  ('leaving_reason', 'RETIRED', 'Retirement', '{}', true, 11),
  ('leaving_reason', 'MUTUAL', 'Mutual agreement', '{}', true, 12),
  ('leaving_reason', 'ABSCOND', 'Absconded / did not return', '{}', true, 13),
  ('leaving_reason', 'DECEASED', 'Passed away', '{}', true, 14),
  ('leaving_reason', 'OTHER', 'Other (details required)', '{"needs_note": true}', true, 15)
on conflict do nothing;

-- a last working day that is newly recorded or changed needs a reason (imports and the first copy of history are exempt)
create or replace function public.eppd_employments_leaving_check()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_setting('eppd.skip_audit', true) = 'on' then return new; end if;
  if new.resigned_date is not null and new.resigned_date is distinct from old.resigned_date and new.leaving_reason is null then
    raise exception 'Choose the reason for leaving.';
  end if;
  if new.leaving_reason is not null and new.leaving_reason is distinct from old.leaving_reason
     and exists (select 1 from public.eppd_lookups l where l.category = 'leaving_reason' and l.code = new.leaving_reason and (l.meta->>'needs_note')::boolean)
     and length(btrim(coalesce(new.leaving_note, ''))) < 3 then
    raise exception 'Give the details for "Other".';
  end if;
  return new;
end $$;
create trigger eppd_employments_leaving_check before update on public.eppd_employments
  for each row execute function public.eppd_employments_leaving_check();

-- ---------------------------------------------------------------- PRI-003
alter table public.eppd_payment_types add column if not exists treatment text;
comment on column public.eppd_payment_types.treatment is 'Statutory preset the ticks were set from (e.g. wages, travel, overtime, bonus, gift, reimbursement, compensation). A changed tick is explained in notes.';

-- ---------------------------------------------------------------- PRI-004
alter table public.eppd_kpi_ratings
  add column if not exists graded_by uuid default auth.uid(),
  add column if not exists graded_at timestamptz default now(),
  add column if not exists cf_override numeric(6,2),
  add column if not exists cf_override_reason text;
alter table public.eppd_kpi_ratings alter column grade drop not null;
update public.eppd_policies
   set value = value || jsonb_build_object('kpi_cutoff_month', coalesce(value->'kpi_cutoff_month', '10'::jsonb), 'buyback_needs_approval', true)
 where key = 'carry_forward';

-- existing item types: the preset their ticks follow
update public.eppd_payment_types set treatment = case
 when code in ('BASIC','ALLOW_A1','ALLOW_A2','ALLOW_A3','LEADER') then 'wages'
 when code in ('FIRST_AID','SKM1','SKM2','TRANSPORT') then 'travel'
 when code in ('MVC','COMMISSION','INCENTIVE','FULL_ATT','REFERRAL') then 'incentive'
 when code = 'BONUS' then 'bonus' when code = 'ANG_BAO' then 'gift'
 when code in ('AL_BUYBACK','AL_ENCASH') then 'leave_pay'
 when code like 'OT\_%' then 'overtime' when code = 'UNPAID_LEAVE' then 'unpaid_leave'
 when code like 'CLAIM\_%' then 'reimbursement' when code = 'NOTICE_PAY' then 'compensation'
 when kind = 'deduction' then 'personal' end
where treatment is null;
