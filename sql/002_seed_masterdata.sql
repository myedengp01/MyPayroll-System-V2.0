-- =====================================================================
-- MyPayroll-System-V2.0  ·  002_seed_masterdata.sql  ·  UVN v2026.10.05-12:00
-- Run AFTER 001. Cleaned lists taken from the MEG-EPPD Settings sheet.
-- ON CONFLICT DO NOTHING: re-running never overwrites your edits.
-- =====================================================================

-- Companies (the first four appear on the login screen; upload logos in Settings › Companies)
insert into public.eppd_companies (code,name,short_name,is_primary,sort_order) values
  ('MEG','Myeden Group Sdn. Bhd.','Myeden Group',true,1),
  ('MEH','Myeden Edu Hub Sdn. Bhd.','Myeden Edu Hub',true,2),
  ('HD','Happy Dino Sdn. Bhd.','Happy Dino',true,3),
  ('ABP','Aborne Project','Aborne Project',true,4),
  ('MHD','Myeden Holding Sdn. Bhd.','Myeden Holding',false,5),
  ('TGE','Tadika Genius Eden','Tadika Genius Eden',false,6),
  ('PJKE','Pusat Jagaan Kanak-Kanak Eden','PJK Eden',false,7),
  ('THD','Tadika Happy Dino','Tadika Happy Dino',false,8),
  ('EDC','Eden Childcare','Eden Childcare',false,9),
  ('WF','White Feather Sdn. Bhd.','White Feather',false,10)
on conflict (code) do nothing;

-- Departments (names default to the code; rename in Settings)
insert into public.eppd_departments (code,name,sort_order) values
  ('HQ','Head Office',1),
  ('E1','E1',2),
  ('E2','E2',3),
  ('E3','E3',4),
  ('E4','E4',5),
  ('E5','E5',6),
  ('E6','E6',7),
  ('E7','E7',8),
  ('E8','E8',9),
  ('E9','E9',10),
  ('E10','E10',11),
  ('E11','E11',12)
on conflict (code) do nothing;

-- Job titles
insert into public.eppd_job_titles (name,sort_order) values
  ('Marketing Executive',1),
  ('Designer',2),
  ('Account Supervisor',3),
  ('HR Manager',4),
  ('Mentor',5),
  ('Playgroup',6),
  ('Kindergarten Teacher',7),
  ('Kindergarten Assistant Teacher',8),
  ('R&D Executive',9),
  ('Infantcare',10),
  ('Crew',11),
  ('Admin',12),
  ('Cook',13),
  ('Trainee Mentor',14),
  ('Nursery Teacher',15),
  ('Manager',16),
  ('Account & Payroll',17),
  ('COO Cum Leader (E1/E3/E6/E7/E10)',18),
  ('Managing Director',19),
  ('Marketing',20),
  ('Driver cum GA',21),
  ('CEO',22),
  ('Junior Marketing Executive',23),
  ('Mentor Leader - Vice Principal (010422)',24),
  ('Assistant Teacher',25),
  ('Account Assistant',26),
  ('E1 Mentor',27),
  ('Driver',28),
  ('Graphic Designer',29)
on conflict (name) do nothing;

-- Pick-lists
insert into public.eppd_lookups (category,code,label,meta,sort_order) values
  ('gender','F','Female','{}'::jsonb,1),
  ('gender','M','Male','{}'::jsonb,2),
  ('nationality','MALAYSIAN','Malaysian','{"stat_class": "MY"}'::jsonb,1),
  ('nationality','MALAYSIAN_PR','Malaysian PR','{"stat_class": "PR"}'::jsonb,2),
  ('nationality','INDONESIAN','Indonesian','{"stat_class": "FR"}'::jsonb,3),
  ('nationality','PHILIPPINE','Philippine','{"stat_class": "FR"}'::jsonb,4),
  ('nationality','INDIAN','Indian','{"stat_class": "FR"}'::jsonb,5),
  ('nationality','SINGAPOREAN','Singaporean','{"stat_class": "FR"}'::jsonb,6),
  ('race','MALAY','Malay','{}'::jsonb,1),
  ('race','CHINESE','Chinese','{}'::jsonb,2),
  ('race','INDIAN','Indian','{}'::jsonb,3),
  ('race','OTHERS','Others','{}'::jsonb,4),
  ('marital_status','SINGLE','Single','{}'::jsonb,1),
  ('marital_status','MARRIED','Married','{}'::jsonb,2),
  ('marital_status','DIVORCED','Divorced','{}'::jsonb,3),
  ('marital_status','WIDOWED','Widowed','{}'::jsonb,4),
  ('bank','MBB','Maybank','{}'::jsonb,1),
  ('bank','CIMB','CIMB Bank','{}'::jsonb,2),
  ('bank','PBB','Public Bank','{}'::jsonb,3),
  ('bank','HLB','Hong Leong Bank','{}'::jsonb,4),
  ('bank','AMBANK','AmBank','{}'::jsonb,5),
  ('bank','BSN','Bank Simpanan Nasional','{}'::jsonb,6),
  ('bank','AFFIN','Affin Bank','{}'::jsonb,7),
  ('bank','SCB','Standard Chartered','{}'::jsonb,8),
  ('bank','CITI','Citibank','{}'::jsonb,9),
  ('bank','TNG','Touch ''n Go eWallet','{}'::jsonb,10),
  ('job_status','FT','Full Time','{}'::jsonb,1),
  ('job_status','PT','Part Time','{}'::jsonb,2),
  ('job_status','TEMP','Temporary','{}'::jsonb,3),
  ('job_status','INTERN','Internship','{}'::jsonb,4),
  ('confirmation_status','UP','Under probation','{"is_active_employment": true}'::jsonb,1),
  ('confirmation_status','C','Confirmed','{"is_active_employment": true}'::jsonb,2),
  ('confirmation_status','CT','Contract','{"is_active_employment": true}'::jsonb,3),
  ('confirmation_status','PT','Part time','{"is_active_employment": true}'::jsonb,4),
  ('confirmation_status','INT','Internship','{"is_active_employment": true}'::jsonb,5),
  ('confirmation_status','R','Resigned','{"is_active_employment": false}'::jsonb,6),
  ('confirmation_status','TR','Terminated','{"is_active_employment": false}'::jsonb,7),
  ('confirmation_status','DM','Dismissed','{"is_active_employment": false}'::jsonb,8),
  ('leave_type','AL','Annual Leave','{}'::jsonb,1),
  ('leave_type','SL','Sick Leave','{}'::jsonb,2),
  ('leave_type','HPL','Hospitalisation Leave','{}'::jsonb,3),
  ('leave_type','MTL','Maternity Leave','{}'::jsonb,4),
  ('leave_type','PTL','Paternity Leave','{}'::jsonb,5),
  ('leave_type','RL','Replacement Leave','{}'::jsonb,6),
  ('leave_type','CPL','Compassionate Leave','{}'::jsonb,7),
  ('leave_type','UPL','Unpaid Leave','{}'::jsonb,8)
on conflict (category,code) do nothing;

-- Payment types (statutory switches are editable per item in Settings › Payment types)
insert into public.eppd_payment_types (code,name,kind,category,subject_epf,subject_socso,subject_eis,subject_pcb,is_recurring,is_system,notes,sort_order) values
  ('BASIC','Basic Salary','earning','basic',true,true,true,true,true,true,null,1),
  ('ALLOW_A1','Allowance (A1)','earning','allowance',true,true,true,true,false,true,null,2),
  ('ALLOW_A2','Allowance (A2)','earning','allowance',true,true,true,true,false,true,null,3),
  ('ALLOW_A3','Allowance (A3)','earning','allowance',true,true,true,true,false,true,null,4),
  ('LEADER','Leader Allowance','earning','allowance',true,true,true,true,true,true,null,5),
  ('FIRST_AID','1st Aid Allowance','earning','allowance',false,false,false,true,true,true,'Workbook grouped this under travel allowance (not subject to EPF/SOCSO/EIS).',6),
  ('SKM1','SKM1 Allowance','earning','allowance',false,false,false,true,true,true,'Workbook grouped this under travel allowance.',7),
  ('SKM2','SKM2 Allowance','earning','allowance',false,false,false,true,true,true,'Workbook grouped this under travel allowance.',8),
  ('TRANSPORT','Transport Allowance','earning','allowance',false,false,false,true,true,true,'Travel allowance.',9),
  ('MVC','MVC','earning','other',true,true,true,true,false,true,null,10),
  ('COMMISSION','Commission','earning','incentive',true,true,true,true,false,true,null,11),
  ('INCENTIVE','Incentive','earning','incentive',true,true,true,true,false,true,null,12),
  ('FULL_ATT','Full Attendance','earning','incentive',true,true,true,true,false,true,null,13),
  ('REFERRAL','New Employee Referral','earning','incentive',true,true,true,true,false,true,null,14),
  ('BONUS','Bonus','earning','bonus',true,false,false,true,false,true,'Bonus: EPF yes, SOCSO/EIS no (wage-type matrix).',15),
  ('ANG_BAO','Cash Ang Bao','earning','gift',false,false,false,true,false,true,'Gift: matrix says not subject to EPF/SOCSO/EIS. The old workbook applied EPF and EIS (but not SOCSO). Adjust the switches if needed.',16),
  ('AL_BUYBACK','AL Buy Back','earning','leave',true,true,true,true,false,true,'Payment for unutilised leave.',17),
  ('OT_NORMAL','Overtime (Normal day)','earning','overtime',false,true,true,true,false,true,'Overtime: not subject to EPF.',18),
  ('OT_RESTDAY','Overtime (Rest day)','earning','overtime',false,true,true,true,false,true,'Overtime: not subject to EPF.',19),
  ('OT_PH','Overtime (Public holiday)','earning','overtime',false,true,true,true,false,true,'Overtime: not subject to EPF.',20),
  ('UNPAID_LEAVE','Unpaid Leave','deduction','leave',true,true,true,true,false,true,'Reduces every statutory base it is ticked for.',21),
  ('CHILDCARE','Childcare (personal deduction)','deduction','personal',false,false,false,false,true,true,'Deducted from net pay only.',22),
  ('LOAN','Company Loan','deduction','personal',false,false,false,false,true,true,'Deducted from net pay only.',23),
  ('OTHER_DED','Other Deduction','deduction','personal',false,false,false,false,false,true,'Deducted from net pay only.',24)
on conflict (code) do nothing;

-- Policies
insert into public.eppd_policies (key,value,description) values
  ('notice_period','{"basis": "contract", "probation_weeks": 4, "bands": [{"from_years": 0, "to_years": 2, "weeks": 4}, {"from_years": 2, "to_years": 5, "weeks": 6}, {"from_years": 5, "to_years": null, "weeks": 12}]}'::jsonb,'Notice period by completed years of service. Employees on probation use probation_weeks.'),
  ('al_entitlement','{"bands": [{"until_months": 24, "days": 8}, {"until_months": 60, "days": 12}, {"until_months": null, "days": 16}], "start_day_counts_if_lte": 15, "end_day_counts_if_gte": 15, "rounding": "half_up"}'::jsonb,'Annual leave days per year by service band, pro-rated by counted months (workbook rule).'),
  ('ot_defaults','{"working_days_per_month": 26, "normal_ot_multiplier": 1.5, "meal_break_hours": 1}'::jsonb,'Defaults for new employees; each employee can override.'),
  ('statutory_rules','{"eis_exempt_age_60_plus": false, "eis_exempt_foreign": false}'::jsonb,'Off = same behaviour as the old workbook. Switch on to stop EIS for age 60+ or foreign staff.')
on conflict (key) do nothing;
