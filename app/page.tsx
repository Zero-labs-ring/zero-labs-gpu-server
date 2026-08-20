'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

interface Session {
  id: string;
  account_id: string;
  model: 'pro' | 'ultra';
  status: 'queued' | 'warming' | 'ready' | 'expiring' | 'dead' | 'error' | 'terminating';
  kernel_slug: string;
  pushed_at: string;
  ready_at: string;
  expires_at: string;
  total_concurrent: number;
  error_message: string;
  endpoints: Array<{ port: number; tunnel_url: string; openai_api_url: string }>;
  kaggle_accounts?: { username: string; label: string };
  updated_at?: string;
}

interface Account {
  id: string;
  username: string;
  label: string;
  model_assignment: 'pro' | 'ultra' | 'both';
  weekly_hours_used: number;
  weekly_hours_reset_at: string;
  rotation_count: number;
  last_used_at: string;
  is_active: boolean;
  created_at: string;
}

interface ConfigRow {
  key: string;
  value: string;
  description: string;
}

interface StealthAccount {
  id: string;
  username: string;
  label: string;
  model_assignment: string;
  weekly_hours_used: number;
  rotation_count: number;
  last_used_at: string;
  hours_remaining: number;
  is_active: boolean;
  stealth_score: number;
}

interface SearchSource {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

function ago(ts: string) {
  if (!ts) return '—';
  const d = Date.now() - new Date(ts).getTime();
  if (d < 60000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  return `${(d / 3600000).toFixed(1)}h ago`;
}

function timeLeft(ts: string) {
  if (!ts) return '—';
  const d = new Date(ts).getTime() - Date.now();
  if (d < 0) return 'expired';
  const h = Math.floor(d / 3600000);
  const m = Math.floor((d % 3600000) / 60000);
  return `${h}h ${m}m`;
}

async function apiFetch(url: string, opts?: RequestInit) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let data: unknown;
  try { data = JSON.parse(t); } catch { data = t; }
  if (!r.ok) throw new Error((data as { error?: string })?.error || String(data));
  return data;
}

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'playground', label: 'Playground' },
  { id: 'sessions', label: 'Nodes & Sessions' },
  { id: 'accounts', label: 'Accounts & Quota' },
  { id: 'search', label: 'Search Engine' },
  { id: 'stealth', label: 'Rotation Engine' },
  { id: 'config', label: 'Settings' },
];

export default function Dashboard() {
  const [tab, setTab] = useState('overview');
  const [health, setHealth] = useState<{ pro: boolean; ultra: boolean }>({ pro: false, ultra: false });
  const [sessions, setSessions] = useState<Session[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [originUrl, setOriginUrl] = useState('');
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const publicApiKey = process.env.NEXT_PUBLIC_ZERO_API_KEY ?? '';

  const fetchGlobal = useCallback(async () => {
    try {
      const [ep, sData, aData] = await Promise.all([
        apiFetch('/api/endpoints') as Promise<{ healthy: { pro: boolean; ultra: boolean } }>,
        apiFetch('/api/sessions') as Promise<Session[]>,
        apiFetch('/api/accounts') as Promise<Account[]>,
      ]);
      if (ep?.healthy) setHealth(ep.healthy);
      if (Array.isArray(sData)) setSessions(sData);
      if (Array.isArray(aData)) setAccounts(aData);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') setOriginUrl(window.location.origin);
    fetchGlobal();
    const iv = setInterval(fetchGlobal, 4000);
    return () => clearInterval(iv);
  }, [fetchGlobal]);

  const copy = (text: string, type: 'url' | 'key') => {
    navigator.clipboard.writeText(text);
    if (type === 'url') {
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } else {
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    }
  };

  const activeNodes = sessions.filter(s => ['ready', 'warming', 'queued'].includes(s.status)).length;
  const totalWeeklyQuota = accounts.filter(a => a.is_active).length * 30;
  const hoursUsed = accounts.reduce((acc, a) => acc + (a.weekly_hours_used || 0), 0);

  return (
    <div className="app-container">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="brand-dot" />
          <div className="brand-title">Zero Labs</div>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-label">Compute</div>
          {TABS.slice(0, 3).map(t => (
            <div
              key={t.id}
              className={`nav-item ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </div>
          ))}

          <div className="nav-label">Fleet</div>
          {TABS.slice(3, 5).map(t => (
            <div
              key={t.id}
              className={`nav-item ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </div>
          ))}

          <div className="nav-label">System</div>
          {TABS.slice(5).map(t => (
            <div
              key={t.id}
              className={`nav-item ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ color: 'var(--text-muted)' }}>Pro 9B</span>
            <span className={`badge ${health.pro ? 'badge-live' : 'badge-offline'}`}>{health.pro ? 'online' : 'offline'}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-muted)' }}>Ultra 27B</span>
            <span className={`badge ${health.ultra ? 'badge-live' : 'badge-offline'}`}>{health.ultra ? 'online' : 'offline'}</span>
          </div>
        </div>
      </aside>

      {/* ── Main View ── */}
      <main className="main-content">
        {/* Vercel Style Gateway Bar */}
        <div className="gateway-bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Endpoint:
            </span>
            <div className="gateway-pill" onClick={() => copy(`${originUrl || 'https://zero-gpu-server.vercel.app'}/v1`, 'url')}>
              <span>{originUrl ? `${originUrl}/v1` : 'https://zero-gpu-server.vercel.app/v1'}</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{copiedUrl ? 'Copied' : 'Copy'}</span>
            </div>
            <div className="gateway-pill" onClick={() => publicApiKey && copy(publicApiKey, 'key')}>
              <span>{publicApiKey ? `Bearer ${publicApiKey}` : 'Set NEXT_PUBLIC_ZERO_API_KEY'}</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{copiedKey ? 'Copied' : 'Copy'}</span>
            </div>
          </div>
        </div>

        {tab === 'overview' && (
          <OverviewView
            health={health}
            sessions={sessions}
            accounts={accounts}
            activeNodes={activeNodes}
            totalQuota={totalWeeklyQuota}
            hoursUsed={hoursUsed}
            onNavigate={setTab}
            onRefresh={fetchGlobal}
          />
        )}
        {tab === 'playground' && <PlaygroundView originUrl={originUrl} />}
        {tab === 'sessions' && <SessionsView onRefresh={fetchGlobal} />}
        {tab === 'accounts' && <AccountsView onRefresh={fetchGlobal} />}
        {tab === 'search' && <SearchView />}
        {tab === 'stealth' && <StealthView />}
        {tab === 'config' && <ConfigView />}
      </main>
    </div>
  );
}

// ════════════════════════ OVERVIEW VIEW ════════════════════════
function OverviewView({
  health,
  sessions,
  accounts,
  activeNodes,
  totalQuota,
  hoursUsed,
  onNavigate,
  onRefresh,
}: {
  health: { pro: boolean; ultra: boolean };
  sessions: Session[];
  accounts: Account[];
  activeNodes: number;
  totalQuota: number;
  hoursUsed: number;
  onNavigate: (t: string) => void;
  onRefresh: () => void;
}) {
  const [firing, setFiring] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('auto');

  const handleLaunch = async (model: 'pro' | 'ultra') => {
    setFiring(model);
    try {
      await apiFetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          account_id: selectedAccountId === 'auto' ? undefined : selectedAccountId
        }),
      });
      onRefresh();
    } catch { /* ignore */ }
    finally { setFiring(null); }
  };

  const readySessions = sessions.filter(s => s.status === 'ready');
  const totalCapacity = readySessions.reduce((acc, s) => acc + (s.total_concurrent || 0), 0);

  const activeSessions = sessions.filter(s => {
    if (['ready', 'warming', 'queued'].includes(s.status)) return true;
    if (s.status === 'dead' && s.updated_at) {
      const msSinceDead = Date.now() - new Date(s.updated_at).getTime();
      // Show as "Terminating..." for 8 minutes after it's killed
      if (msSinceDead < 8 * 60000) return true;
    }
    return false;
  });

  return (
    <>
      <div className="top-header">
        <div>
          <h2>Overview</h2>
          <p>Cluster telemetry and GPU instance management.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '4px 8px' }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>Target Account:</span>
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              style={{
                background: 'transparent',
                color: 'var(--text-primary)',
                border: 'none',
                fontSize: 12,
                fontFamily: 'inherit',
                outline: 'none',
                cursor: 'pointer'
              }}
            >
              <option value="auto" style={{ background: '#1c1c1e', color: '#fff' }}>⚡ Auto (Lowest Usage)</option>
              {accounts.filter(a => a.is_active).map(a => (
                <option key={a.id} value={a.id} style={{ background: '#1c1c1e', color: '#fff' }}>
                  @{a.username} {a.label ? `(${a.label})` : ''} [{a.weekly_hours_used.toFixed(1)}h/30h]
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={onRefresh}>Refresh</button>
          <button className="btn btn-white btn-sm" onClick={() => onNavigate('playground')}>Open Playground</button>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Active Nodes</div>
          <div className="stat-val">{activeNodes}</div>
          <div className="stat-sub">{readySessions.length} ready instances</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Fleet Quota</div>
          <div className="stat-val">{totalQuota}h</div>
          <div className="stat-sub">{hoursUsed.toFixed(1)}h consumed this week</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Concurrency</div>
          <div className="stat-val">{totalCapacity || 64}</div>
          <div className="stat-sub">Max batch capacity</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Accounts</div>
          <div className="stat-val">{accounts.length}</div>
          <div className="stat-sub">{accounts.filter(a => a.is_active).length} active</div>
        </div>
      </div>

      {/* Model Clusters */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
        <div className="panel" style={{ margin: 0 }}>
          <div className="panel-header">
            <div>
              <div className="panel-title">Titan Pro 9B</div>
              <div className="panel-desc">MTP speculative decoding · Dual T4 · High throughput</div>
            </div>
            <span className={`badge ${health.pro ? 'badge-live' : 'badge-offline'}`}>
              {health.pro ? 'online' : 'offline'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              className="btn btn-white"
              style={{ flex: 1 }}
              disabled={firing !== null}
              onClick={() => handleLaunch('pro')}
            >
              {firing === 'pro' ? 'Launching...' : `Deploy Pro Node ${selectedAccountId !== 'auto' ? `(@${accounts.find(a => a.id === selectedAccountId)?.username})` : ''}`}
            </button>
            <button className="btn btn-secondary" onClick={() => onNavigate('sessions')}>Inspect</button>
          </div>
        </div>

        <div className="panel" style={{ margin: 0 }}>
          <div className="panel-header">
            <div>
              <div className="panel-title">Titan Ultra 27B</div>
              <div className="panel-desc">GGUF Q4_K_M · Dual T4 · Deep reasoning</div>
            </div>
            <span className={`badge ${health.ultra ? 'badge-live' : 'badge-offline'}`}>
              {health.ultra ? 'online' : 'offline'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              className="btn btn-white"
              style={{ flex: 1 }}
              disabled={firing !== null}
              onClick={() => handleLaunch('ultra')}
            >
              {firing === 'ultra' ? 'Launching...' : `Deploy Ultra Node ${selectedAccountId !== 'auto' ? `(@${accounts.find(a => a.id === selectedAccountId)?.username})` : ''}`}
            </button>
            <button className="btn btn-secondary" onClick={() => onNavigate('sessions')}>Inspect</button>
          </div>
        </div>
      </div>

      {/* Deployments Table */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">Active Node Deployments</div>
          <button className="btn btn-secondary btn-sm" onClick={() => onNavigate('sessions')}>View all ({sessions.length})</button>
        </div>

        <div className="table-container">
          <table className="linear-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Status</th>
                <th>Tunnel Endpoint</th>
                <th>Started</th>
                <th>CAPACITY</th>
                <th>ACTION</th>
              </tr>
            </thead>
            <tbody>
              {activeSessions.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-dim)' }}>
                    No GPU nodes currently active.
                  </td>
                </tr>
              ) : (
                activeSessions.map(s => {
                  const isTerminating = s.status === 'dead';
                  return (
                    <tr key={s.id}>
                      <td style={{ fontWeight: 500, color: 'var(--text-primary)', opacity: isTerminating ? 0.6 : 1 }}>{s.model === 'pro' ? 'Titan Pro 9B' : 'Titan Ultra 27B'}</td>
                      <td>
                        <span className={`badge ${s.status === 'ready' ? 'badge-live' : (isTerminating ? 'badge-offline' : 'badge-warming')}`}>
                          {isTerminating ? 'terminating' : s.status}
                        </span>
                      </td>
                      <td style={{ fontFamily: 'Geist Mono', fontSize: 11.5, opacity: isTerminating ? 0.6 : 1 }}>
                        {s.endpoints?.[0]?.tunnel_url || 'Acquiring...'}
                      </td>
                      <td style={{ color: 'var(--text-muted)' }}>{ago(s.ready_at || s.pushed_at)}</td>
                      <td style={{ opacity: isTerminating ? 0.6 : 1 }}>{s.total_concurrent || 32} reqs</td>
                      <td>
                        {isTerminating ? (
                          <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>shutting down on Kaggle...</span>
                        ) : (
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={async () => {
                              if (confirm(`Terminate ${s.model.toUpperCase()} GPU session?`)) {
                                await apiFetch(`/api/sessions/${s.id}`, { method: 'DELETE' });
                                onRefresh();
                              }
                            }}
                          >
                            Terminate
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ════════════════════════ PLAYGROUND VIEW ════════════════════════
function PlaygroundView({ originUrl }: { originUrl: string }) {
  const [model, setModel] = useState<'pro' | 'ultra' | 'search-pro' | 'search-ultra'>('pro');
  const [prompt, setPrompt] = useState('Explain how dual GPU load-balancing works in high-throughput distributed LLM inference.');
  const [maxTokens, setMaxTokens] = useState(131072);
  const [temp, setTemp] = useState(0.7);
  const [webSearch, setWebSearch] = useState(true);
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<{ tokens: number; ms: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const publicApiKey = process.env.NEXT_PUBLIC_ZERO_API_KEY ?? '';

  const handleRun = async () => {
    if (running) {
      abortRef.current?.abort();
      setRunning(false);
      return;
    }

    setOutput('');
    setStats(null);
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const t0 = Date.now();

    try {
      const res = await fetch('/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(publicApiKey ? { 'Authorization': `Bearer ${publicApiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature: temp,
          web_search: webSearch || model.startsWith('search-'),
          stream: true,
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        setOutput(`Error HTTP ${res.status}: ${await res.text()}`);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) return;

      const dec = new TextDecoder();
      let full = '';
      let tokCount = 0;
      let sseBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += dec.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        // Retain un-delimited trailing slice across TCP chunk boundaries
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') continue;
          try {
            const parsed = JSON.parse(dataStr);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              full += delta;
              tokCount++;
              setOutput(full);
            }
          } catch { /* ignore */ }
        }
      }
      setStats({ tokens: tokCount, ms: Date.now() - t0 });
    } catch { /* abort */ }
    finally { setRunning(false); }
  };

  return (
    <>
      <div className="top-header">
        <div>
          <h2>Playground</h2>
          <p>Real-time streaming test console.</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 16, height: 'calc(100vh - 170px)' }}>
        <div className="panel" style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="panel-title">Configuration</div>

          <div>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Model</label>
            <select className="linear-input" value={model} onChange={e => setModel(e.target.value as any)}>
              <option value="pro">Titan Pro 9B</option>
              <option value="ultra">Titan Ultra 27B</option>
              <option value="search-pro">Search Pro (Titan Pro + Web Search)</option>
              <option value="search-ultra">Search Ultra (Titan Ultra + Web Search)</option>
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                Max Tokens (128K ceiling)
              </label>
              <input
                type="number"
                className="linear-input"
                min={512}
                max={131072}
                step={512}
                value={maxTokens}
                onChange={e => setMaxTokens(Math.min(Math.max(Number(e.target.value) || 512, 512), 131072))}
              />
            </div>
            <div>
              <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                Temperature
              </label>
              <input
                type="number"
                className="linear-input"
                min={0}
                max={2}
                step={0.1}
                value={temp}
                onChange={e => setTemp(parseFloat(e.target.value) || 0.7)}
              />
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0' }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Live Web Search (RAG)</span>
            <input
              type="checkbox"
              checked={webSearch || model.startsWith('search-')}
              onChange={e => setWebSearch(e.target.checked)}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Prompt</label>
            <textarea
              className="linear-input"
              style={{ flex: 1, resize: 'none', lineHeight: 1.5 }}
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
            />
          </div>

          <button className="btn btn-white" onClick={handleRun}>
            {running ? 'Stop Streaming' : 'Run Stream'}
          </button>
        </div>

        <div className="panel" style={{ margin: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="panel-header" style={{ marginBottom: 8 }}>
            <div className="panel-title">Output Stream</div>
            {stats && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'Geist Mono' }}>
                {stats.tokens} tokens · {(stats.tokens / (stats.ms / 1000 || 1)).toFixed(0)} tok/s
              </span>
            )}
          </div>
          <div className="console-box" style={{ flex: 1 }}>
            {output || <span style={{ color: 'var(--text-dim)' }}>Output will stream here...</span>}
          </div>
        </div>
      </div>
    </>
  );
}

// ════════════════════════ SESSIONS VIEW ════════════════════════
function SessionsView({ onRefresh }: { onRefresh: () => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [killing, setKilling] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      const data = await apiFetch('/api/sessions') as Session[];
      setSessions(Array.isArray(data) ? data : []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchSessions();
    const iv = setInterval(fetchSessions, 4000);
    return () => clearInterval(iv);
  }, [fetchSessions]);

  const handleKill = async (id: string) => {
    if (!confirm('Terminate this Kaggle GPU session?')) return;
    setKilling(id);
    try {
      await apiFetch(`/api/sessions/${id}`, { method: 'DELETE' });
      fetchSessions();
      onRefresh();
    } catch { /* ignore */ }
    finally { setKilling(null); }
  };

  return (
    <>
      <div className="top-header">
        <div>
          <h2>Nodes & Sessions</h2>
          <p>GPU clusters and tunnel connectivity.</p>
        </div>
      </div>

      <div className="panel">
        <div className="table-container">
          <table className="linear-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Status</th>
                <th>Account</th>
                <th>Tunnel Endpoint</th>
                <th>Expires</th>
                <th>Capacity</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map(s => {
                const isAlive = ['ready', 'warming', 'queued'].includes(s.status);
                let displayStatus = s.status;
                let isTerminating = false;
                if (s.status === 'dead' && s.updated_at) {
                  const msSinceDead = Date.now() - new Date(s.updated_at).getTime();
                  if (msSinceDead < 8 * 60000) {
                    displayStatus = 'terminating';
                    isTerminating = true;
                  }
                }
                return (
                  <tr key={s.id}>
                    <td style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{s.model === 'pro' ? 'Titan Pro 9B' : 'Titan Ultra 27B'}</td>
                    <td><span className={`badge ${s.status === 'ready' ? 'badge-live' : (isTerminating ? 'badge-offline' : 'badge-offline')}`}>{displayStatus}</span></td>
                    <td style={{ fontFamily: 'Geist Mono', fontSize: 11.5 }}>@{s.kaggle_accounts?.username || 'stealth'}</td>
                    <td style={{ fontFamily: 'Geist Mono', fontSize: 11.5 }}>{s.endpoints?.[0]?.tunnel_url || '—'}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{timeLeft(s.expires_at)}</td>
                    <td>{s.total_concurrent || 32} reqs</td>
                    <td>
                      {isAlive ? (
                        <button
                          className="btn btn-danger btn-sm"
                          disabled={killing === s.id}
                          onClick={() => handleKill(s.id)}
                        >
                          {killing === s.id ? 'Stopping...' : 'Terminate'}
                        </button>
                      ) : isTerminating ? (
                        <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>shutting down on Kaggle...</span>
                      ) : (
                        <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>dead</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ════════════════════════ ACCOUNTS VIEW ════════════════════════
function AccountsView({ onRefresh }: { onRefresh: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [username, setUsername] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [label, setLabel] = useState('');
  const [assignment, setAssignment] = useState<'pro' | 'ultra' | 'both'>('both');
  const [saving, setSaving] = useState(false);

  const fetchAccounts = useCallback(async () => {
    try {
      const data = await apiFetch('/api/accounts') as Account[];
      setAccounts(Array.isArray(data) ? data : []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchAccounts(); }, [fetchAccounts]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !apiKey.trim()) return;
    setSaving(true);
    try {
      await apiFetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, api_key: apiKey, label, model_assignment: assignment }),
      });
      setUsername('');
      setApiKey('');
      setLabel('');
      fetchAccounts();
      onRefresh();
    } catch { /* ignore */ }
    finally { setSaving(false); }
  };

  const handleDelete = async (a: Account) => {
    if (!confirm(`Delete account @${a.username}?`)) return;
    try {
      await apiFetch(`/api/accounts/${a.id}`, { method: 'DELETE' });
      fetchAccounts();
      onRefresh();
    } catch { /* ignore */ }
  };

  return (
    <>
      <div className="top-header">
        <div>
          <h2>Accounts & Quota</h2>
          <p>Encrypted Kaggle API keys and 30-hour weekly quota tracking.</p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title" style={{ marginBottom: 12 }}>Add Kaggle Credentials</div>
        <form onSubmit={handleAdd} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <input className="linear-input" placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} />
          <input className="linear-input" type="password" placeholder="API Key / Token" value={apiKey} onChange={e => setApiKey(e.target.value)} />
          <input className="linear-input" placeholder="Label (optional)" value={label} onChange={e => setLabel(e.target.value)} />
          <select className="linear-input" value={assignment} onChange={e => setAssignment(e.target.value as any)}>
            <option value="both">Both (Pro & Ultra)</option>
            <option value="pro">Pro Only</option>
            <option value="ultra">Ultra Only</option>
          </select>
          <button className="btn btn-white" type="submit" disabled={saving} style={{ alignSelf: 'center' }}>
            {saving ? 'Verifying...' : 'Save Account'}
          </button>
        </form>
      </div>

      <div className="panel">
        <div className="panel-title" style={{ marginBottom: 12 }}>Configured Accounts ({accounts.length})</div>
        <div className="table-container">
          <table className="linear-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Label</th>
                <th>Assignment</th>
                <th>Weekly Usage</th>
                <th>Rotations</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map(a => (
                <tr key={a.id}>
                  <td style={{ fontFamily: 'Geist Mono', color: 'var(--text-primary)' }}>@{a.username}</td>
                  <td>{a.label || '—'}</td>
                  <td><span className="badge badge-offline">{a.model_assignment}</span></td>
                  <td>
                    <div>{a.weekly_hours_used.toFixed(1)}h / 30h</div>
                    <div className="quota-track">
                      <div className="quota-fill" style={{ width: `${Math.min(100, (a.weekly_hours_used / 30) * 100)}%` }} />
                    </div>
                  </td>
                  <td>{a.rotation_count}</td>
                  <td>
                    <button className="btn btn-danger btn-sm" onClick={() => handleDelete(a)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ════════════════════════ SEARCH VIEW ════════════════════════
function SearchView() {
  const [query, setQuery] = useState('latest AI model breakthroughs');
  const [results, setResults] = useState<SearchSource[]>([]);
  const [loading, setLoading] = useState(false);

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    try {
      const data = await apiFetch(`/api/search?q=${encodeURIComponent(query)}&limit=5`) as { results: SearchSource[] };
      setResults(Array.isArray(data.results) ? data.results : []);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };

  return (
    <>
      <div className="top-header">
        <div>
          <h2>Search Engine (RAG)</h2>
          <p>Real-time web retrieval for search-augmented generation.</p>
        </div>
      </div>

      <div className="panel">
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <input
            className="linear-input"
            style={{ flex: 1 }}
            placeholder="Search query..."
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <button className="btn btn-white" type="submit" disabled={loading}>
            {loading ? 'Searching...' : 'Search'}
          </button>
        </form>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {results.map((r, i) => (
            <div key={i} style={{ background: '#050505', border: '1px solid var(--border)', padding: 12, borderRadius: 6 }}>
              <a href={r.url} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                [{i + 1}] {r.title}
              </a>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{r.url}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5 }}>
                {r.snippet}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ════════════════════════ STEALTH VIEW ════════════════════════
function StealthView() {
  const [accounts, setAccounts] = useState<StealthAccount[]>([]);

  useEffect(() => {
    apiFetch('/api/stealth').then(d => {
      if (Array.isArray(d)) setAccounts(d);
    }).catch(() => { });
  }, []);

  return (
    <>
      <div className="top-header">
        <div>
          <h2>Rotation Engine</h2>
          <p>Stealth account rotation scoring.</p>
        </div>
      </div>

      <div className="panel">
        <div className="table-container">
          <table className="linear-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Username</th>
                <th>Hours Used</th>
                <th>Hours Remaining</th>
                <th>Rotations</th>
                <th>Last Used</th>
                <th>Stealth Score</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a, i) => (
                <tr key={a.id}>
                  <td style={{ color: 'var(--text-dim)' }}>#{i + 1}</td>
                  <td style={{ fontFamily: 'Geist Mono', color: 'var(--text-primary)' }}>@{a.username}</td>
                  <td>{a.weekly_hours_used.toFixed(1)}h</td>
                  <td>{a.hours_remaining.toFixed(1)}h</td>
                  <td>{a.rotation_count}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{ago(a.last_used_at)}</td>
                  <td><span className="badge badge-offline">{a.stealth_score.toFixed(1)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ════════════════════════ CONFIG VIEW ════════════════════════
function ConfigView() {
  const [config, setConfig] = useState<ConfigRow[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});

  useEffect(() => {
    apiFetch('/api/config').then(d => {
      if (Array.isArray(d)) {
        setConfig(d);
        const map: Record<string, string> = {};
        d.forEach(r => { map[r.key] = r.value; });
        setEdits(map);
      }
    }).catch(() => { });
  }, []);

  const handleSave = async (key: string) => {
    try {
      await apiFetch(`/api/config/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: edits[key] }),
      });
    } catch { /* ignore */ }
  };

  return (
    <>
      <div className="top-header">
        <div>
          <h2>Settings</h2>
          <p>Global system configuration.</p>
        </div>
      </div>

      <div className="panel">
        {config.map(r => (
          <div key={r.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
            <div>
              <div style={{ fontFamily: 'Geist Mono', fontSize: 12, color: 'var(--text-primary)' }}>{r.key}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.description}</div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="linear-input"
                style={{ width: 220 }}
                value={edits[r.key] ?? r.value}
                onChange={e => setEdits({ ...edits, [r.key]: e.target.value })}
              />
              <button className="btn btn-secondary btn-sm" onClick={() => handleSave(r.key)}>Save</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
