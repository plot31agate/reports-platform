/* ui.tsx — shared bits for Agency HQ, theme-token driven like Finance HQ. */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Severity, TaskKind } from '../lib/agency';

/* ---- Toast ---- */
export function toast(msg: string) {
  window.dispatchEvent(new CustomEvent('df-toast', { detail: msg }));
}
export function Toaster() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let timer: number;
    const on = (e: Event) => {
      setMsg((e as CustomEvent<string>).detail);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setMsg(null), 2600);
    };
    window.addEventListener('df-toast', on);
    return () => { window.removeEventListener('df-toast', on); window.clearTimeout(timer); };
  }, []);
  if (!msg) return null;
  return <div className="toast">{msg}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="fade small" style={{ padding: '18px 0', color: 'var(--muted)' }}>{children}</div>;
}

/* ---- Status dot: the shared language across the roster ---- */
const DOT_CLASS: Record<Severity, string> = { ok: 'up', attention: 'warn', blocked: 'down', idle: 'idle' };
export function StatusDot({ s }: { s: Severity }) {
  return <span className={`dot ${DOT_CLASS[s]}`} />;
}

const STATUS_LABEL: Record<Severity, string> = { ok: 'On track', attention: 'Needs input', blocked: 'Blocked', idle: 'Idle' };
const STATUS_PILL: Record<Severity, string> = { ok: 'pass', attention: 'warn', blocked: 'fail', idle: '' };
export function StatusPill({ s }: { s: Severity }) {
  return <span className={`pill ${STATUS_PILL[s]}`}><span className={`dot ${DOT_CLASS[s]}`} style={{ marginRight: 6 }} />{STATUS_LABEL[s]}</span>;
}

/* ---- Task glyph — a quiet monospace marker per kind ---- */
const GLYPH: Record<TaskKind, string> = {
  report: '▤', article: '✎', approval: '◷', health: '♥', connection: '⇄', strategy: '◈',
};
export function TaskGlyph({ k }: { k: TaskKind }) {
  return <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--faint)', width: 16, display: 'inline-block' }}>{GLYPH[k]}</span>;
}

/* ---- Stat tile ---- */
export function Stat({ n, label, tone }: { n: ReactNode; label: string; tone?: 'pass' | 'warn' | 'fail' }) {
  const color = tone === 'fail' ? 'var(--fail)' : tone === 'warn' ? 'var(--warn)' : tone === 'pass' ? 'var(--pass)' : 'var(--ink)';
  return (
    <div className="card stat">
      <div className="n" style={{ color }}>{n}</div>
      <div className="l">{label}</div>
    </div>
  );
}

export function OfflineNote() {
  return (
    <div className="card accent" style={{ borderLeft: '3px solid var(--warn)' }}>
      <div className="eyebrow">Running on roster config only</div>
      <p className="small" style={{ margin: '8px 0 0', color: 'var(--muted)' }}>
        The reporting-core snapshot isn’t reachable, so report and connection state
        aren’t live. Run <code>npm run snapshot</code> (reads reporting.db) to wire
        it up; strategy, cadence and field state still render from config.
      </p>
    </div>
  );
}
