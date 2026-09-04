/* ui.tsx — shared pieces for Finance HQ: toasts, stat tiles, the working
   pulse, and the inline SVG charts (no chart library, same spirit as the
   portal's Spark). Everything is theme-token driven. */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { moneyShort } from '../lib/finance';
import type { Delta } from '../lib/finance';

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
  return <div className="fade small" style={{ padding: '18px 0' }}>{children}</div>;
}

/* ---- Stat tile with an optional MoM delta chip ---- */
export function Stat({ n, label, delta, neg, note }: {
  n: ReactNode; label: string; delta?: DeltaChipProps; neg?: boolean; note?: string;
}) {
  return (
    <div className="card stat">
      <div className={`n${neg ? ' neg' : ''}`}>{n}</div>
      <div className="l">{label}</div>
      {(delta || note) && (
        <div className="foot">
          {delta && <DeltaChip {...delta} />}
          {note && <span className="kpi-note">{note}</span>}
        </div>
      )}
    </div>
  );
}

/* ---- Delta chip. `good` is decided by the caller because a falling cost is
   good and a falling revenue is bad — direction alone can't tell. ---- */
export interface DeltaChipProps { d: Delta; label: string; good: boolean | null; }
export function DeltaChip({ d, label, good }: DeltaChipProps) {
  const cls = good === null || d.dir === 'flat' ? 'flat' : good ? 'good' : 'bad';
  const arw = d.dir === 'up' ? '▲' : d.dir === 'down' ? '▼' : '■';
  return <span className={`delta ${cls}`}><span className="arw">{arw}</span>{label}</span>;
}

/* ---- The working pulse (shared with the ask/report generation states) ---- */
export function Working({ label }: { label?: string }) {
  return (
    <div className="working">
      <div className="bar" />
      <div className="fade small">{label ?? 'Working…'}</div>
    </div>
  );
}

/** Shown when the AI features are asked for but claude-config.php isn't on the
    server yet. Explains the one-file fix without leaking that it's about keys. */
export function NeedsKey() {
  return (
    <div className="card accent">
      <div className="eyebrow">Claude isn’t connected yet</div>
      <p style={{ margin: '10px 0 0', maxWidth: 560 }}>
        The AI features (Ask the data, scenario planning) need the Anthropic API key
        installed on the server. Copy <code>api/claude-config.example.php</code> to
        <code>api/claude-config.php</code> and add the key from platform.claude.com.
        Everything else in Finance HQ works without it.
      </p>
    </div>
  );
}

export function OfflineNote() {
  return (
    <div className="card accent">
      <div className="eyebrow">No connection</div>
      <p className="small fade" style={{ margin: '8px 0 0' }}>
        The Finance HQ API is not reachable here. Live data (imported figures,
        budgets, Claude answers) connects once deployed to the server, or in dev
        with the PHP server running behind the Vite proxy.
      </p>
    </div>
  );
}

/* ============================================================
   Charts — inline SVG, viewBox-scaled so they're responsive.
   ============================================================ */

export interface MonthPoint { key: string; label: string; income: number; cost: number; profit: number; }

/** Income vs cost columns with the net-profit line over the top. */
export function IncomeCostChart({ points, h = 240, labels }: { points: MonthPoint[]; h?: number; labels?: [string, string, string] }) {
  const [inLbl, costLbl, netLbl] = labels ?? ['Income', 'Costs', 'Net profit'];
  if (points.length === 0) return <Empty>No periods imported yet.</Empty>;
  const w = 720;
  const padL = 8, padR = 8, padT = 16, padB = 26;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const maxBar = Math.max(1, ...points.map((p) => Math.max(p.income, p.cost)));
  const profits = points.map((p) => p.profit);
  const maxP = Math.max(0, ...profits), minP = Math.min(0, ...profits);
  const pRange = Math.max(1, maxP - minP);

  const groupW = innerW / points.length;
  const barW = Math.min(26, groupW * 0.28);
  const yBar = (v: number) => padT + innerH - (v / maxBar) * innerH;
  const yProfit = (v: number) => padT + innerH - ((v - minP) / pRange) * innerH;

  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(padL + groupW * (i + 0.5)).toFixed(1)},${yProfit(p.profit).toFixed(1)}`)
    .join(' ');

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label="Income, cost and net profit by month">
        <defs>
          <linearGradient id="profitfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--magenta)" />
            <stop offset="100%" stopColor="var(--magenta)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* zero baseline for the bars */}
        <line className="axis" x1={padL} y1={padT + innerH} x2={w - padR} y2={padT + innerH} />
        {points.map((p, i) => {
          const cx = padL + groupW * (i + 0.5);
          return (
            <g key={p.key}>
              <rect className="col-income" x={cx - barW - 2} y={yBar(p.income)} width={barW} height={padT + innerH - yBar(p.income)} rx="3" />
              <rect className="col-cost" x={cx + 2} y={yBar(p.cost)} width={barW} height={padT + innerH - yBar(p.cost)} rx="3" />
              <text className="lbl" x={cx} y={h - 8} textAnchor="middle">{p.label.replace(/ \d{4}$/, '')}</text>
            </g>
          );
        })}
        <path className="line-profit" d={line} />
        {points.map((p, i) => (
          <circle key={p.key} className="dot-profit" cx={padL + groupW * (i + 0.5)} cy={yProfit(p.profit)} r="3" />
        ))}
      </svg>
      <div className="legend">
        <span className="k"><span className="sw" style={{ background: 'var(--chart-in)' }} />{inLbl}</span>
        <span className="k"><span className="sw" style={{ background: 'var(--chart-out)' }} />{costLbl}</span>
        <span className="k"><span className="sw" style={{ background: 'var(--chart-net)' }} />{netLbl}</span>
      </div>
    </div>
  );
}

/** A single projected cash line (runway / forecast). */
export function CashLine({ series, h = 200 }: { series: { label: string; value: number }[]; h?: number }) {
  if (series.length < 2) return <Empty>Not enough data to project.</Empty>;
  const w = 720;
  const padL = 8, padR = 8, padT = 16, padB = 26;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const vals = series.map((s) => s.value);
  const max = Math.max(1, ...vals), min = Math.min(0, ...vals);
  const range = Math.max(1, max - min);
  const step = innerW / (series.length - 1);
  const x = (i: number) => padL + step * i;
  const y = (v: number) => padT + innerH - ((v - min) / range) * innerH;
  const line = series.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(s.value).toFixed(1)}`).join(' ');
  const zeroY = y(0);
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label="Projected cash">
        {min < 0 && <line className="axis" x1={padL} y1={zeroY} x2={w - padR} y2={zeroY} strokeDasharray="4 4" />}
        <path className="line-profit" d={line} />
        {series.map((s, i) => (
          <g key={i}>
            <circle className="dot-profit" cx={x(i)} cy={y(s.value)} r="3" />
            {(i === 0 || i === series.length - 1 || i % 3 === 0) && (
              <text className="lbl" x={x(i)} y={h - 8} textAnchor="middle">{s.label}</text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

/** Two projected cash lines over the 13-week window: the committed floor
    (solid navy) and committed + selected pipeline (dashed cyan). A dashed zero
    line shows where the balance would cross into overdraft. */
export interface CashWeekPoint { label: string; committed: number; scenario: number; }
export function CashFlowChart({ weeks, hasScenario, h = 220 }: { weeks: CashWeekPoint[]; hasScenario: boolean; h?: number }) {
  if (weeks.length < 2) return <Empty>Not enough weeks to project.</Empty>;
  const w = 720;
  const padL = 8, padR = 8, padT = 16, padB = 26;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const vals = weeks.flatMap((p) => hasScenario ? [p.committed, p.scenario] : [p.committed]);
  const max = Math.max(1, ...vals), min = Math.min(0, ...vals);
  const range = Math.max(1, max - min);
  const step = innerW / (weeks.length - 1);
  const x = (i: number) => padL + step * i;
  const y = (v: number) => padT + innerH - ((v - min) / range) * innerH;
  const path = (key: 'committed' | 'scenario') =>
    weeks.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  const zeroY = y(0);

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label="Projected cash over 13 weeks">
        {min < 0 && <line x1={padL} y1={zeroY} x2={w - padR} y2={zeroY} stroke="var(--fail)" strokeWidth="1" strokeDasharray="4 4" opacity="0.6" />}
        {hasScenario && <path d={path('scenario')} fill="none" stroke="var(--cyan)" strokeWidth="2.5" strokeDasharray="5 4" />}
        <path d={path('committed')} fill="none" stroke="var(--navy)" strokeWidth="2.5" />
        {weeks.map((p, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(p.committed)} r="2.5" fill="var(--navy)" />
            {(i === 0 || i === weeks.length - 1 || i % 2 === 0) && (
              <text className="lbl" x={x(i)} y={h - 8} textAnchor="middle">{p.label}</text>
            )}
          </g>
        ))}
      </svg>
      <div className="legend">
        <span className="k"><span className="sw" style={{ background: 'var(--navy)' }} />Committed (floor)</span>
        {hasScenario && <span className="k"><span className="sw" style={{ background: 'var(--cyan)' }} />With selected pipeline</span>}
      </div>
    </div>
  );
}

/** Horizontal spend breakdown: one labelled bar per category. */
export function SpendBars({ rows, max }: { rows: { cap: string; amount: number }[]; max?: number }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.amount));
  if (rows.length === 0) return <Empty>No spend lines for this period.</Empty>;
  return (
    <div>
      {rows.map((r, i) => (
        <div className="barrow" key={i}>
          <span className="cap">{r.cap}</span>
          <span className="amt">{moneyShort(r.amount)}</span>
          <span className="bar"><span style={{ width: `${Math.max(2, (r.amount / top) * 100)}%` }} /></span>
        </div>
      ))}
    </div>
  );
}
