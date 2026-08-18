export function ensureEnv(keys: string[]) {
  const missing = keys.filter(k => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}. Add them to .env.local or the environment.`);
  }
}

export function getEnvOrThrow(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}
