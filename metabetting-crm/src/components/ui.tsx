/* ui.tsx — small shared pieces: blank-friendly number input, toast, copy button. */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Num } from '../lib/model';
import { copyText } from '../lib/store';

/** Number field that can be left blank (→ null). Accepts "30,000" and "30000". */
export function NumInput({ value, onChange, placeholder = '—', prefix, suffix, width, step }: {
  value: Num; onChange: (v: Num) => void; placeholder?: string; prefix?: string; suffix?: string; width?: number; step?: number;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => {
    const parsed = parse(text);
    if (parsed !== value) setText(value === null ? '' : String(value));
    // Only resync when the value changes from outside (import, reset, example).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <span className="numwrap" style={width ? { width } : undefined}>
      {prefix && <span className="affix">{prefix}</span>}
      <input
        className="inp num"
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        step={step}
        onChange={(e) => { setText(e.target.value); onChange(parse(e.target.value)); }}
      />
      {suffix && <span className="affix">{suffix}</span>}
    </span>
  );
}
function parse(t: string): Num {
  const c = t.replace(/[,£%\s]/g, '');
  if (c === '' || c === '-' || c === '.') return null;
  const n = Number(c);
  return isFinite(n) ? n : null;
}

let toastSet: ((m: string) => void) | null = null;
export function toast(m: string) { toastSet?.(m); }
export function Toaster() {
  const [msg, setMsg] = useState('');
  useEffect(() => { toastSet = setMsg; return () => { toastSet = null; }; }, []);
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(''), 2400); return () => clearTimeout(t); }, [msg]);
  return msg ? <div className="toast no-print">{msg}</div> : null;
}

export function CopyButton({ text, label = 'Copy as text', small = true }: { text: string | (() => string); label?: string; small?: boolean }) {
  return (
    <button className={`btn ghost ${small ? 'sm' : ''}`} onClick={async () => {
      const ok = await copyText(typeof text === 'function' ? text() : text);
      toast(ok ? 'Copied to clipboard' : 'Copy failed: select the text and copy manually');
    }}>{label}</button>
  );
}

export function Section({ title, sub, right, children }: { title: string; sub?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="card sec">
      <div className="spread" style={{ alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <h3>{title}</h3>
          {sub && <div className="small fade" style={{ marginTop: 3 }}>{sub}</div>}
        </div>
        {right && <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>{right}</div>}
      </div>
      {children}
    </div>
  );
}

export function Stat({ n, l, hint }: { n: string; l: string; hint?: string }) {
  return (
    <div className="card stat">
      <div className="n">{n}</div>
      <div className="l">{l}</div>
      {hint && <div className="kpi-note">{hint}</div>}
    </div>
  );
}

export function ReadyPill({ ready }: { ready: boolean }) {
  return <span className={`pill ${ready ? 'pass' : 'fail'}`}>{ready ? 'Ready' : 'Blocked'}</span>;
}
