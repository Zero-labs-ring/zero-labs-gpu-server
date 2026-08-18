import { supabase } from './supabase';
import { decrypt } from './crypto';
import { getConfigValue } from './config';

export interface KaggleAccount {
  username: string;
  apiKey: string;
}

export class KaggleClient {
  private baseUrl = 'https://www.kaggle.com/api/v1';
  private authHeader: string;

  constructor(private account: KaggleAccount) {
    // Kaggle API v1 accepts Bearer token for personal API tokens or Basic auth
    if (account.apiKey.startsWith('KGAT_') || account.apiKey.startsWith('kgat_')) {
      this.authHeader = `Bearer ${account.apiKey}`;
    } else {
      // Modern Kaggle API accepts Bearer token directly
      this.authHeader = `Bearer ${account.apiKey}`;
    }
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Kaggle API ${method} ${path} → ${response.status}: ${text}`);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : ({} as T);
  }

  async pushKernel(kernelSlug: string, notebookContent: object, accelerator: string = 'nvidiaTeslaT4') {
    const fullSlug = kernelSlug.includes('/') ? kernelSlug : `${this.account.username}/${kernelSlug}`;
    const cleanTitle = kernelSlug.includes('/') ? kernelSlug.split('/')[1] : kernelSlug;
    return this.request('POST', '/kernels/push', {
      slug: fullSlug,
      newTitle: cleanTitle,
      text: JSON.stringify(notebookContent),
      language: 'python',
      kernelType: 'notebook',
      isPrivate: true,
      enableGpu: true,
      accelerator: accelerator || 'nvidiaTeslaT4',
      machineShape: 'NvidiaTeslaT4',
      machine_shape: 'NvidiaTeslaT4',
      enableInternet: true,
      datasetDataSources: [],
      kernelDataSources: [],
      competitionDataSources: [],
      categoryIds: [],
    });
  }


  async getKernelStatus(username: string, slug: string) {
    return this.request<{ status: string; failureReason?: string }>(
      'GET', `/kernels/status?userName=${username}&kernelSlug=${slug}`
    );
  }

  async getKernelOutput(username: string, slug: string): Promise<string> {
    const result = await this.request<{ files?: { data: string }[]; log?: string }>(
      'GET', `/kernels/output?userName=${username}&kernelSlug=${slug}`
    );
    const files = result?.files ?? [];
    return files.map((f) => f.data).join('\n') || result?.log || '';
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.request('GET', `/kernels?ownerSlug=${this.account.username}&pageSize=1`);
      return true;
    } catch {
      return false;
    }
  }
}

export function parseNotebookOutput(raw: string): Record<string, unknown> | null {
  const START = '===ZERO_LABS_OUTPUT_START===';
  const END = '===ZERO_LABS_OUTPUT_END===';
  const si = raw.indexOf(START);
  const ei = raw.indexOf(END);
  if (si !== -1 && ei !== -1 && ei > si) {
    const jsonStr = raw.slice(si + START.length, ei).trim();
    try {
      return JSON.parse(jsonStr);
    } catch (err) {
      console.warn('[kaggle] Failed to parse JSON between START/END markers:', err);
    }
  }

  // Fallback: attempt to find a JSON object in the output that looks like
  // the orchestration payload (contains `status` or `endpoints`). This helps
  // when notebook output formatting changes or the markers are altered.
  const jsonMatch = raw.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed && typeof parsed === 'object' && (parsed.hasOwnProperty('status') || parsed.hasOwnProperty('endpoints'))) {
        console.warn('[kaggle] parseNotebookOutput: using JSON fallback extraction');
        return parsed as Record<string, unknown>;
      }
    } catch (err) {
      // ignore and fall through to null
    }
  }

  return null;
}

// Also search for cloudflare URLs as fallback
export function extractTunnelUrls(raw: string): string[] {
  const matches = raw.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g) ?? [];
  return [...new Set(matches)];
}

export async function getKaggleClientForAccount(accountId: string): Promise<KaggleClient | null> {
  const { data: account } = await supabase
    .from('kaggle_accounts')
    .select('*')
    .eq('id', accountId)
    .single();

  if (!account) return null;

  const apiKey = decrypt(account.api_key_encrypted, account.api_key_iv, account.api_key_tag);
  return new KaggleClient({ username: account.username, apiKey });
}

export async function getKaggleClientFromEnv(): Promise<KaggleClient> {
  const username = process.env.KAGGLE_USERNAME ?? '';
  const apiKey = process.env.KAGGLE_KEY ?? process.env.KAGGLE_API_TOKEN ?? '';
  if (!username || !apiKey) throw new Error('KAGGLE_USERNAME and KAGGLE_KEY must be set');
  return new KaggleClient({ username, apiKey });
}
