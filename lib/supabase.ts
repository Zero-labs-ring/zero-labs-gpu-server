import { createClient } from '@supabase/supabase-js';
import { ensureEnv } from './env-check';

// Fail fast if essential server-side env vars are missing. This prevents
// accidentally shipping a hardcoded service role key or running with
// elevated privileges unintentionally.
ensureEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  global: {
    headers: {
      'X-Client-Info': 'zero-labs-admin/1.0',
    },
  },
});
