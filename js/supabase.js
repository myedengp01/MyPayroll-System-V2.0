import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const isConfigured = !SUPABASE_ANON_KEY.startsWith('PASTE_');
export const sb = createClient(SUPABASE_URL, isConfigured ? SUPABASE_ANON_KEY : 'missing-key', {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'eppd-auth' },
});
