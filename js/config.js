// Supabase connection. Since v2026.10.19 MyPayroll runs on the MyEden Group CMS database
// (project vzngfswtofegimfcoigx, the same project as MEG-FORMS). The old MyPayroll-System project
// (tjoijzzeayolsqnguvpj) is kept untouched as the record of the data before the move.
// The anon / publishable key is designed to be public (data is protected by RLS),
// so it is safe to commit. Find it in Supabase › Project Settings › API.

// MEG-FORMS project (OTCF overtime claims). Public anon key, same as in the OTCF form itself.
// Used only by Time & leave › Overtime & hours › "Pull approved OTCF claims" (you sign in with your OTCF admin account).
export const MEGFORMS_URL = 'https://vzngfswtofegimfcoigx.supabase.co';
export const MEGFORMS_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6bmdmc3d0b2ZlZ2ltZmNvaWd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyODA5MzUsImV4cCI6MjEwMDg1NjkzNX0.47rTrOjzNgxarCBYGapqajLw5v_yATbeKitiyP6a2Sg';

// MyPayroll itself now uses the CMS database (= the MEG-FORMS project above).
export const SUPABASE_URL = MEGFORMS_URL;
export const SUPABASE_ANON_KEY = MEGFORMS_ANON_KEY;
