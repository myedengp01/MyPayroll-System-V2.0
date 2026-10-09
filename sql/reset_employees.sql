-- =====================================================================
-- MyPayroll-System-V2.0 · reset_employees.sql · UVN v2026.10.09-11:30
-- !!! PERMANENTLY DELETES every employee record in this app !!!
-- (people, private details, employment periods, company assignments,
--  salary history, allowances). Settings, companies, statutory tables,
-- users and the audit log are NOT touched. MyPRSys is NOT touched.
--
-- Only use this to redo the one-time workbook import before you start
-- using the app for real. Run in the SQL Editor; Supabase will warn that
-- it is destructive, which is correct.
-- =====================================================================
begin;
insert into public.eppd_audit_log (table_name, action, new_data)
select 'eppd_employees', 'RESET', jsonb_build_object('people_deleted', count(*)) from public.eppd_employees;
truncate public.eppd_allowances, public.eppd_salary_history, public.eppd_assignments,
         public.eppd_employments, public.eppd_employee_private, public.eppd_employees restart identity;
commit;
