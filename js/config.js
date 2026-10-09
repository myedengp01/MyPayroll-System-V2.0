// Supabase connection for the MyPayroll-System project.
// The anon / publishable key is designed to be public (data is protected by RLS),
// so it is safe to commit. Find it in Supabase › Project Settings › API.
export const SUPABASE_URL = 'https://tjoijzzeayolsqnguvpj.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRqb2lqenplYXlvbHNxbmd1dnBqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ3MDU3MjEsImV4cCI6MjEwMDI4MTcyMX0.MlKm_MKVNYfGaep3o0OF3GUDcY0GcmyznhbWfOEWMqE';

// MEG-FORMS project (OTCF overtime claims). Public anon key, same as in the OTCF form itself.
// Used only by Time & leave › Overtime & hours › "Pull approved OTCF claims" (you sign in with your OTCF admin account).
export const MEGFORMS_URL = 'https://vzngfswtofegimfcoigx.supabase.co';
export const MEGFORMS_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6bmdmc3d0b2ZlZ2ltZmNvaWd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyODA5MzUsImV4cCI6MjEwMDg1NjkzNX0.47rTrOjzNgxarCBYGapqajLw5v_yATbeKitiyP6a2Sg';
