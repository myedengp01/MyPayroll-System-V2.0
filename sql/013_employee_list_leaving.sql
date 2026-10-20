-- MyPayroll V2.0 · 013: the employee list shows the leaving reason and rehire eligibility (PRI-002).
-- Also puts back "security_invoker" on the view (lost in 011), so the list follows each user's row rules again.
create or replace view public.eppd_employee_list with (security_invoker = true) as
 SELECT e.id, e.emp_id, e.emp_serial, e.full_name, e.chinese_name, e.gender, e.nationality,
    cur.id AS employment_id, cur.join_date, cur.confirmation_status, cur.confirmed_date, cur.job_status,
    cur.resignation_letter_date, cur.resigned_date,
    d.id AS department_id, d.code AS department_code, d.name AS department_name,
    jt.id AS job_title_id, jt.name AS job_title,
    pc.id AS company_id, pc.code AS company_code, COALESCE(pc.short_name, pc.name) AS company_name,
    (SELECT count(*) FROM eppd_assignments a2 WHERE a2.employment_id = cur.id) AS company_count,
    (SELECT count(*) FROM eppd_employments m2 WHERE m2.employee_id = e.id) AS employment_count,
    e.updated_at, cur.notice_until,
    cur.leaving_reason, cur.leaving_note, cur.rehire_eligibility, cur.rehire_note
   FROM eppd_employees e
     LEFT JOIN LATERAL (SELECT m.id, m.join_date, m.confirmation_status, m.confirmed_date, m.job_status, m.department_id, m.job_title_id,
            m.resignation_letter_date, m.resigned_date, m.notice_until, m.leaving_reason, m.leaving_note, m.rehire_eligibility, m.rehire_note
           FROM eppd_employments m WHERE m.employee_id = e.id
          ORDER BY m.join_date DESC NULLS LAST, m.id DESC LIMIT 1) cur ON true
     LEFT JOIN eppd_departments d ON d.id = cur.department_id
     LEFT JOIN eppd_job_titles jt ON jt.id = cur.job_title_id
     LEFT JOIN LATERAL (SELECT c.id, c.code, c.name, c.short_name
           FROM eppd_assignments a JOIN eppd_companies c ON c.id = a.company_id
          WHERE a.employment_id = cur.id
          ORDER BY (a.end_date IS NULL OR a.end_date >= CURRENT_DATE) DESC, a.is_primary DESC, a.start_date DESC NULLS LAST, a.id DESC
          LIMIT 1) pc ON true;
grant select on public.eppd_employee_list to authenticated;
