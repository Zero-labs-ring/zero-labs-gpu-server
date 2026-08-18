import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || supabaseUrl.includes('YOUR_PROJECT_ID')) {
  throw new Error(
    '[Zero Labs] SUPABASE_URL is not set. ' +
    'Add it to .env.local (local dev) or Vercel Environment Variables (production). ' +
    'Get it from: Supabase Dashboard → Settings → API → Project URL'
  );
}

if (!supabaseKey || supabaseKey.includes('YOUR_KEY_HERE')) {
  throw new Error(
    '[Zero Labs] SUPABASE_SERVICE_ROLE_KEY is not set. ' +
    'Add it to .env.local (local dev) or Vercel Environment Variables (production). ' +
    'Get it from: Supabase Dashboard → Settings → API → service_role key (secret)'
  );
}

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
