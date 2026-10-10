# MyPayroll System V2.0

Payroll app for MyEden Group, rebuilt from the MEG-EPPD 2026 workbook.
Static site (GitHub Pages) + Supabase. No build step.

**Current version:** v2026.10.10-17:45 · **Phase 6 – Automatic PCB, claims, loans, final settlement** (+ SOCSO NEI split)

## First-time setup

### 1. Database (Supabase › SQL Editor, project *MyPayroll-System*)
Run these **in order**. Each file is safe to re-run.

| File | What it does |
|---|---|
| `sql/001_foundation.sql` | Tables, access rules, audit log. Makes trade12win@gmail.com admin. |
| `sql/002_seed_masterdata.sql` | Companies, departments, job titles, pick-lists, payment types, policies. Never overwrites your edits. |
| `sql/003_seed_statutory.sql` | EPF / SOCSO / EIS tables from the workbook (8 versions, 1,133 rows). |
| `sql/004_employees.sql` | Phase 2: employees, employment periods, paying companies, salary history, allowances, Employee ID generator, workbook import. |
| `sql/005_leave_time.sql` | Phase 3: leave records, balance adjustments, KPI grades, year-end close, overtime & part-time hours, OTCF links; working-week, leave, carry-forward and part-time policies. |
| `sql/006_payroll.sql` | Phase 4: pay runs and pay lines, finalise / reopen, payroll history import, payroll policy. |
| `sql/007_last_working_days.sql` | One-off fix: last working day for 7 former staff whose workbook "Resigned Date" was blank. |
| `sql/008_phase6.sql` | Phase 6: tax details (automatic PCB), MEG-FORMS claims, loans, final settlement; new payment types (ZAKAT, CLAIM_SCF, CLAIM_MTCF, NOTICE_PAY, NOTICE_SHORT, AL_ENCASH); `modules`, `pcb` and `settlement` policies. All modules start **off**. |
| `sql/009_socso_nei.sql` | Keeps the employee's SOCSO in two parts, invalidity and non-employment injury (NEI), on every pay line, and fills in the split for months already saved by matching each amount to the SOCSO table. Totals are unchanged. Ends with a table per month; `could_not_split` should be empty. |

`sql/reset_employees.sql` is **not** part of setup. It deletes every employee record so the one-time
workbook import can be run again before going live.

Every object is prefixed `eppd_`. Nothing belonging to MyPRSys is touched.

### 2. Connect the app
Open `js/config.js` and replace `PASTE_YOUR_ANON_PUBLIC_KEY_HERE` with the **anon public** key
(Supabase › Project Settings › API). This key is meant to be public; the data is protected by row-level security.

### 3. Publish
Push this folder to `myedengp01/MyPayroll-System-V2.0`, then Settings › Pages › deploy from `main` / root.

In Supabase › Authentication › URL Configuration, add the Pages URL
(`https://myedengp01.github.io/MyPayroll-System-V2.0/`) to **Redirect URLs** so password-reset and sign-up emails return to the app.

### 4. Import your staff (admin)
People › Import from workbook › choose the MEG-EPPD .xlsm. The file is read in your browser; only the
cleaned records are saved. Review the preview (decisions, checks, salary-history match), then press Import.
It runs once, all-or-nothing.

### 5. Import leave and hours (admin)
Time & leave › Import leave › choose the same .xlsm. Reads this year's leave, replacement leave, AL buy-back,
overtime and part-time hours from ALMC_PT_2025, last year's brought-forward balance from StaffPersonalData,
and checks the result against the latest month of PayrollSMRY2026. Re-running replaces only what came from the
workbook; leave and hours entered in the app are kept. Then add **weekly hours** for each part-timer
(Employee › Employment) so their leave is pro-rated.

### 6. Overtime from OTCF
Time & leave › Overtime & hours › Pull approved OTCF claims. Sign in with a MEG-FORMS **admin or approver**
account (the OTCF database only lets those roles read every claim). Names are matched to employees; any you
match by hand are remembered. Pulled lines can be edited or deleted, and pulling again never duplicates.

### 7. Import past payroll months (admin)
Payroll › Import past months › choose the same .xlsm. January–September 2026 come in from PayrollSMRY2026 as
**finalised** months, exactly as the workbook calculated them (year-to-date totals for Phase 5). Rows that look
wrong are held back as "left out" unless you tick them. The preview also runs each month through the new engine
and lists every line that would come out differently, with the cause. December 2025 is not imported.

### 8. Each month
Payroll › Monthly payroll › **Start <month>**. The run is built from salary history, allowances, unpaid leave,
overtime & part-time hours and year-end AL buy-backs (paid in January). Click a line to add one-off items
(bonus, commission, MVC…), type PCB from the LHDN calculator (last month's PCB is copied in as a starting point),
adjust an amount or leave the line out. **Save as draft** any time; **Recalculate** picks up new leave / OT
while keeping your edits. **Finalise** locks the month. Only an admin can reopen a finalised month, with a reason
that goes into the audit log.

**Statutory figures** are shown share by share everywhere (screens, payslips, lists, Excel): EPF employee / employer,
SOCSO employee **invalidity** / employee **NEI** (non-employment injury, from June 2026) / employer, EIS employee / employer.
On a payroll line the employee's SOCSO has two boxes, invalidity and NEI; leave both empty to use the table. NEI is 0 for
anyone with the NEI opt-out and for months before June 2026; staff aged 60+ pay NEI only. The EPF and SOCSO & EIS lists keep a
"Total to pay" column for the portals. The EA form (E2) still shows employee SOCSO + EIS in one figure, as LHDN asks.

Pay rules (Settings › HR policies › Payroll): daily rate = basic ÷ 26, hourly rate = daily rate ÷ normal hours
(work hours less meal break). Normal-day OT × the person's OT multiplier (1.5), off day × 1.5, rest day ½ day / 1 day
/ × 2 per extra hour, public holiday 2 days / × 3 per extra hour. Unpaid leave and part months use calendar days.
EPF / SOCSO / EIS follow each payment type's switches and each person's paying-company switches.

### 9. Payslips & reports (admin + HR)
Payroll › Payslips & reports, for any **finalised** month:
- **Payslips**: one A4 page per person per paying company (logo, earnings, deductions, employer contributions,
  year to date, leave balances). "Print all" or one person; choose "Save as PDF" in the print window.
- **Monthly summary** (on screen + Excel, one sheet per company), **Payment list** (bank, account no., net pay per
  company; print or Excel), **EPF**, **SOCSO & EIS** and **PCB** lists per company to key into the portals,
  flagging missing EPF / tax numbers and bank accounts.
- **Year to date** per person per company (Excel).
- **EA forms** (Borang EA, C.P.8A) per person per paying company: B1(a) basic, overtime, leave pay less unpaid
  leave · B1(b) commission, incentives, bonus · B1(c) allowances, gifts, perquisites · F items whose payment type is
  not subject to PCB · D1 PCB · E1 EPF and E2 PERKESO (SOCSO + EIS) employee shares. Fill in each company's
  LHDN E number and each employee's tax number first; ask your tax agent to confirm the allowance treatment.

### 10. Optional modules (Phase 6)
Switch each on or off in **Settings › HR policies › Optional modules**. Switching one off hides its screen and stops
it adding items to new payroll lines; finalised months are never changed.

- **Automatic PCB** — PCB is worked out each month by the LHDN computerised method (normal + additional
  remuneration, year-to-date from finalised months, EPF relief capped at RM4,000, SOCSO/EIS relief up to RM350,
  rounded up to 5 sen, under RM10 not deducted, zakat taken off). Fill in **Employee › Pay › Tax details**:
  category (1 single · 2 married, spouse not working · 3 married, spouse working), children, disability, TP1
  monthly deductions, zakat, and TP3 previous employment this year. Tick *PCB typed by hand* for anyone whose PCB
  you want to keep typing. On any payroll line you can still type a PCB over the automatic one, and "How PCB was
  worked out" shows the steps. Bonus, incentive, commission, notice pay and leave pay-outs count as additional
  remuneration. Reliefs, caps and the band table are in **Settings › HR policies › PCB rules** — check them
  against the LHDN e-PCB calculator every January.
- **Claims (MEG-FORMS SCF / MTCF)** — Payroll › MEG-FORMS claims › pull approved claims (MEG-FORMS admin sign-in), match
  names, choose the pay month. Claims are reimbursements: no EPF/SOCSO/EIS/PCB, not on the EA form, paid on top of
  net pay and shown separately on the payslip. Still mark them paid in MEG-FORMS.
- **Loans** — Payroll › Company loans: amount, monthly instalment, first month. The instalment is deducted each month until
  repaid (the last one is the balance); repayments come from finalised months.
- **Final settlement** — Payroll › Final settlement lists people leaving soon or recently left. For each: unused
  annual leave paid out (auto = balance on the last day × daily rate), not paid, or your own days / amount
  (negative days deduct leave taken in advance); notice pay in lieu or notice not served; and whether to take the
  remaining loan balance. Items appear in the leaver's last payroll month and can be edited there.

### 11. After first sign-in
Work through the checklist on the Overview page: upload the four logos, fill in employer numbers,
paste the year's public holidays, review payment-type switches, approve users.

## Access
People sign up on the login page and wait until an admin approves them in **Users & access**.
Access is separate from MyPRSys even though both use the same Supabase login.

| Role | Can do |
|---|---|
| admin | Everything, including statutory tables, payment types, policies, users |
| hr | Employees incl. NRIC, bank, salary and allowances; leave, balances, year-end close, overtime; monthly payroll (prepare and finalise); companies, departments, job titles, pick-lists, holidays |
| approver | Employee names and jobs only (payroll is finalised by HR / admin) |
| viewer | Employee names and jobs only |

NRIC, date of birth, address, bank, EPF/SOCSO/tax numbers, salary history and allowances are stored in
separate tables that only admin and HR can read. All leave, KPI, overtime and payroll data is admin/HR only too.
The database enforces this, not just the screens.

## Project layout
```
index.html            app shell
css/app.css           all styles (light + dark)
js/version.js         VERSION — the only place the UVN is set
js/config.js          Supabase URL + anon key (also MEG-FORMS, for OTCF)
js/app.js             sign-in flow, sidebar, router
js/engines/           pure calculation code (tested in Node)
js/modules/           one file per screen
sql/                  numbered migrations
tests/                Node tests
```

## Tests
Requires Node 20+: `npm install` then `npm test`

To also test the importer against the real workbook (kept out of the repo because it holds personal data):
`EPPD_WORKBOOK=/path/to/MEG_EPPD_2026.xlsm npm test`

`tests/statutory.test.js` includes a golden test comparing the engine against every
Dec 2025 – Sep 2026 row of the workbook (345 rows × 6 contribution values).
Its fixture contains real salaries, so it is **git-ignored** and skipped automatically when absent.

## Changing a version
1. Edit `VERSION` in `js/version.js` (login screen and footer read from it).
2. Note the change below.

## Change log
- **v2026.10.10-17:45** — Employee and employer shares shown separately everywhere (import preview, payroll months list, month
  figures, company totals, line window, CSV, payslips, monthly summary, EPF and SOCSO & EIS lists, year to date, employee
  payroll history). Employee SOCSO split into invalidity and NEI: stored per line, two boxes on the payroll line, separate
  rows on the payslip, separate columns in every report. Imported months split by matching the workbook amount to the SOCSO
  table. "Total to pay" kept on the EPF and SOCSO & EIS lists. Run `sql/009_socso_nei.sql`.
- **v2026.10.09-20:00** — Phase 6: optional modules (each switchable). Automatic PCB (LHDN computerised method) with
  per-employee tax details, typed override per line and per person, editable PCB rules; MEG-FORMS SCF / MTCF claims
  paid as reimbursements; company loans with instalments; final settlement for leavers (annual leave pay-out or
  deduction, notice pay, loan recovery). Payslip shows claims; EA form adds B6 (compensation for loss of employment).
  Run `sql/008_phase6.sql`.
- **v2026.10.09-19:45** — Phase 5: payslips & reports. Payslips (print / save as PDF, one or all), monthly summary
  with Excel, salary payment list, EPF / SOCSO & EIS / PCB lists per company (print + Excel), year-to-date report,
  EA forms (C.P.8A) with signatory, checks for missing EPF / tax / E numbers and bank accounts. No database change.
- **v2026.10.09-19:30** — Former staff fix. Payroll leaves out anyone marked Resigned / Terminated / Dismissed who has
  no last working day, and names them on the payroll page. The Employment form has a Last working day field, required
  for those statuses (company assignments end on the same day). People › Former staff in the menu; status tabs show
  counts; a name search looks across everyone; former staff list shows the last day; "no last working day" check on
  the Employees page, the profile and the Overview checklist; service on a former employee's profile stops at the
  last day. `sql/007_last_working_days.sql` sets the 7 missing last days.
- **v2026.10.09-16:30** — Phase 4: monthly payroll. One pay run a month, one line per employee per paying company;
  basic from salary history (part months by calendar days, hourly staff from part-time hours), unpaid leave,
  overtime at Employment Act rates (basic ÷ 26 ÷ normal hours), recurring allowances and personal deductions,
  January AL buy-back from the year-end close, EPF / SOCSO / EIS from the statutory engine with payment-type and
  company switches and the age-60 rule (age on the last day of the previous month); PCB typed in (last month's
  copied as a start); one-off items, amount overrides, statutory overrides, leave-out; per-company totals; CSV export;
  save draft / recalculate / finalise (locked) / admin reopen with reason; January–September 2026 history import
  from PayrollSMRY2026 with an engine-vs-workbook comparison; payroll history on the employee's Pay tab;
  payroll rules editor. Also: dialogs fit phone screens.
- **v2026.10.09-14:45** — Phase 3: leave & time. Leave records (HR/admin; working days counted automatically,
  skipping Saturday off days, Sunday rest days and public holidays; half days; override), leave balances for every type
  (AL by service band with the workbook's month rule; sick 14/18/22, hospitalisation 60 incl. sick, maternity 98,
  paternity 7 per the Employment Act; compassionate 2 per occasion / 4 a year; replacement leave earned and taken;
  unpaid), manual adjustments, CSV export, AL calculator, part-time pro-rating by weekly hours, year-end close with
  KPI grades (E 6 · S 3 · A 1 · I 0 · U 0 days carried, confirmed staff only), buy-back of the excess for E/S/A at
  50/25/10 % or a custom rate, optional expiry of carried leave, overtime & hours by Employment Act category with
  OTCF pull from MEG-FORMS, one-time leave import from the workbook with a reconciliation check, Leave tab on each
  employee, new policy editors (working week, leave entitlements, carry forward, part-time).
- **v2026.10.09-11:30** — Phase 2: employees. Employee list (search, status/company/department filters, CSV export),
  profile (personal, identity & bank, employment periods incl. rehires, resignation with contract notice periods,
  pay: paying companies, statutory switches, effective-dated salary history incl. hourly rates, allowances with end dates),
  add employee with automatic Employee ID (one running number across the group; per-company prefix, HD for Happy Dino),
  Employee IDs page (duplicates, missing IDs, generate), one-time workbook import with a salary-history check against
  PayrollSMRY2026 (379 of 382 months match).
- **v2026.10.05-12:00** — Phase 1: foundations (access, companies & logos, master data,
  payment types with per-item EPF/SOCSO/EIS/PCB switches, versioned statutory tables with calculator,
  public holidays, HR policies incl. contract notice periods, users, audit log).
