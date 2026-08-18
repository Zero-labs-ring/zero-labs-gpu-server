'use client';
import { useState, useEffect } from 'react';

export default function SidebarLayout({ children }: { children: React.ReactNode }) {
    const [health, setHealth] = useState<{ pro: boolean; ultra: boolean } | null>(null);

    useEffect(() => {
        const poll = async () => {
            try {
                const r = await fetch('/api/endpoints');
                const d = await r.json();
                setHealth(d.healthy);
            } catch { }
        };
        poll();
        const t = setInterval(poll, 15000);
        return () => clearInterval(t);
    }, []);

    return (
        <div className="layout">
            <aside className="sidebar">
                <div className="sidebar-logo">
                    Zero <span>Labs</span>
                    <small>Admin & API Gateway</small>
                </div>

                <div className="sidebar-nav">
                    <div style={{ padding: '8px 4px 4px', fontSize: 10, fontWeight: 700, color: 'var(--text3)', letterSpacing: '0.07em', textTransform: 'uppercase' }}>
                        Live Health
                    </div>
                    <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '10px 12px' }}>
                        {['pro', 'ultra'].map(m => (
                            <div key={m} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                                <span style={{ textTransform: 'capitalize', color: 'var(--text2)', fontWeight: 500, fontSize: 13 }}>{m}</span>
                                <span className={`badge badge-${health?.[m as 'pro' | 'ultra'] ? 'ready' : 'dead'}`} style={{ fontSize: 10, padding: '1px 7px' }}>
                                    {health?.[m as 'pro' | 'ultra'] ? '🟢 Live' : '🔴 Down'}
                                </span>
                            </div>
                        ))}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <span style={{ color: 'var(--text2)', fontWeight: 500, fontSize: 13 }}>Search</span>
                            <span className="badge badge-ready" style={{ fontSize: 10, padding: '1px 7px' }}>
                                🟢 Ready
                            </span>
                        </div>
                    </div>

                    <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text3)', lineHeight: 1.7 }}>
                        Use the <strong style={{ color: 'var(--cyan)' }}>tabs</strong> to manage GPU Sessions, Accounts, Config, Stealth, Playground, and Search Server.
                    </div>
                </div>

                <div className="sidebar-footer">
                    <div className="sidebar-footer-label">Infrastructure</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text3)', lineHeight: 1.8 }}>
                        <div>☁️ Supabase — Database</div>
                        <div>🤖 Kaggle — GPU Sessions</div>
                        <div>🔍 Search Server — Web RAG</div>
                        <div>⚡ Vercel — Gateway & Crons</div>
                    </div>
                    <div style={{ marginTop: 10, fontSize: 10, color: 'var(--border2)' }}>
                        Zero Labs v2 · {new Date().getFullYear()}
                    </div>
                </div>
            </aside>

            <main className="main">{children}</main>
        </div>
    );
}
