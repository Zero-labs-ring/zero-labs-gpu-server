import { supabase } from './supabase';

// Cache config for 60s to avoid hammering Supabase on every request
let cache: Record<string, string> = {};
let cacheTime = 0;
const CACHE_TTL = 60_000;

export async function getConfig(): Promise<Record<string, string>> {
  if (Date.now() - cacheTime < CACHE_TTL && Object.keys(cache).length > 0) {
    return cache;
  }

  const { data, error } = await supabase.from('system_config').select('key, value');
  if (error) {
    console.error('[config] Failed to load system_config from Supabase:', error.message);
    // Fallback: load from process.env (useful for local dev before Supabase is set up)
    return getEnvFallback();
  }

  cache = {};
  for (const row of data ?? []) {
    cache[row.key] = row.value;
  }
  cacheTime = Date.now();
  return cache;
}

export async function getConfigValue(key: string, fallback = ''): Promise<string> {
  const cfg = await getConfig();
  return cfg[key] ?? process.env[key] ?? fallback;
}

// Used during local dev when Supabase tables aren't seeded yet
function getEnvFallback(): Record<string, string> {
  return {
    KAGGLE_ACCELERATOR:    process.env.KAGGLE_ACCELERATOR    ?? 'gpuT4x2',
    PRO_TARGET_SESSIONS:   process.env.PRO_TARGET_SESSIONS   ?? '1',
    ULTRA_TARGET_SESSIONS: process.env.ULTRA_TARGET_SESSIONS ?? '1',
    PRO_MAX_CONCURRENT:    process.env.PRO_MAX_CONCURRENT    ?? '64',
    ULTRA_MAX_CONCURRENT:  process.env.ULTRA_MAX_CONCURRENT  ?? '8',
    SESSION_SOFT_LIMIT_H:  process.env.SESSION_SOFT_LIMIT_H  ?? '9',
    PREFIRE_BUFFER_MIN:    process.env.PREFIRE_BUFFER_MIN     ?? '30',
    HF_TOKEN:              process.env.HF_TOKEN              ?? '',
    ZERO_API_KEY:          process.env.ZERO_API_KEY          ?? '',
    CRON_SECRET:           process.env.CRON_SECRET           ?? '',
    PRO_KERNEL_SLUG:       process.env.PRO_KERNEL_SLUG       ?? 'zero-pro-server',
    ULTRA_KERNEL_SLUG:     process.env.ULTRA_KERNEL_SLUG     ?? 'zero-ultra-server',
  };
}

export function invalidateCache() {
  cacheTime = 0;
}
