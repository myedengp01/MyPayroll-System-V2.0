# MyPayroll System V2.0

Payroll app for MyEden Group, rebuilt from the MEG-EPPD 2026 workbook.
Static site (GitHub Pages) + Supabase. No build step.

**Current version:** v2026.10.09-11:30 · **Phase 2 – Employees**

## First-time setup

### 1. Database (Supabase › SQL Editor, project *MyPayroll-System*)
Run these **in order**. Each file is safe to re-run.

| File | What it does |
|---|---|
| `sql/001_foundation.sql` | Tables, access rules, audit log. Makes trade12win@gmail.com admin. |
| `sql/002_seed_masterdata.sql` | Companies, departments, job titles, pick-lists, payment types, policies. Never overwrites your edits. |
| `sql/003_seed_statutory.sql` | EPF / SOCSO / EIS tables from the workbook (8 versions, 1,133 rows). |
| `sql/004_employees.sql` | Phase 2: employees, employment periods, paying companies, salary history, allowances, Employee ID generator, workbook import. |

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

### 5. After first sign-in
Work through the checklist on the Overview page: upload the four logos, fill in employer numbers,
paste the year's public holidays, review payment-type switches, approve users.

## Access
People sign up on the login page and wait until an admin approves them in **Users & access**.
Access is separate from MyPRSys even though both use the same Supabase login.

| Role | Can do |
|---|---|
| admin | Everything, including statutory tables, payment types, policies, users |
| hr | Employees incl. NRIC, bank, salary and allowances; companies, departments, job titles, pick-lists, holidays |
| approver | Employee names and jobs only (payroll approval arrives in Phase 4) |
| viewer | Employee names and jobs only |

NRIC, date of birth, address, bank, EPF/SOCSO/tax numbers, salary history and allowances are stored in
separate tables that only admin and HR can read. The database enforces this, not just the screens.

## Project layout
```
index.html            app shell
css/app.css           all styles (light + dark)
js/version.js         VERSION — the only place the UVN is set
js/config.js          Supabase URL + anon key
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
- **v2026.10.09-11:30** — Phase 2: employees. Employee list (search, status/company/department filters, CSV export),
  profile (personal, identity & bank, employment periods incl. rehires, resignation with contract notice periods,
  pay: paying companies, statutory switches, effective-dated salary history incl. hourly rates, allowances with end dates),
  add employee with automatic Employee ID (one running number across the group; per-company prefix, HD for Happy Dino),
  Employee IDs page (duplicates, missing IDs, generate), one-time workbook import with a salary-history check against
  PayrollSMRY2026 (379 of 382 months match).
- **v2026.10.05-12:00** — Phase 1: foundations (access, companies & logos, master data,
  payment types with per-item EPF/SOCSO/EIS/PCB switches, versioned statutory tables with calculator,
  public holidays, HR policies incl. contract notice periods, users, audit log).
