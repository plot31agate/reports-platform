/* Plain SVG horizontal bar funnel. Blank stages draw an empty track and "—". */
import { FUNNEL_STAGES } from '../lib/model';
import type { FunnelRow } from '../lib/model';
import { fmtN, fmtPct, isNum, ratio } from '../lib/calc';

export function FunnelChart({ row, compare, highlight, compact }: { row: FunnelRow; compare?: FunnelRow | null; highlight?: string | null; compact?: boolean }) {
  const vals = FUNNEL_STAGES.map((s) => row[s.key]).concat(compare ? FUNNEL_STAGES.map((s) => compare[s.key]) : []).filter(isNum);
  const max = vals.length ? Math.max(...vals) : 0;
  // Compact (the one-page summary) draws in a narrower box so text prints larger.
  const W = compact ? 400 : 640, labelW = compact ? 118 : 150, valW = compact ? 112 : 150, barW = W - labelW - valW, rowH = compare ? 34 : compact ? 22 : 28;
  const H = FUNNEL_STAGES.length * rowH + 6;
  const reg = row.registered;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Funnel chart">
      {FUNNEL_STAGES.map((s, i) => {
        const v = row[s.key], c = compare?.[s.key] ?? null;
        const y = i * rowH + 4;
        const w = isNum(v) && max > 0 ? Math.max(2, (v / max) * barW) : 0;
        const wc = isNum(c) && max > 0 ? Math.max(2, (c / max) * barW) : 0;
        const hot = highlight === s.key;
        return (
          <g key={s.key}>
            <text x={0} y={y + 14} fontSize="12" fill="var(--body)" fontWeight={hot ? 700 : 500}>{s.label}</text>
            <rect x={labelW} y={y + 3} width={barW} height={compare ? 12 : 16} rx="3" fill="var(--line-soft)" />
            {w > 0 && <rect x={labelW} y={y + 3} width={w} height={compare ? 12 : 16} rx="3" fill={hot ? 'var(--fail)' : 'var(--chart-in)'} />}
            {compare && <>
              <rect x={labelW} y={y + 17} width={barW} height={8} rx="2" fill="var(--line-soft)" />
              {wc > 0 && <rect x={labelW} y={y + 17} width={wc} height={8} rx="2" fill="var(--chart-out)" />}
            </>}
            <text x={labelW + barW + 10} y={y + 14} fontSize="12" fill="var(--ink)" fontWeight="600" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {fmtN(v)}
              <tspan fill="var(--muted)" fontWeight="500">{i > 0 && isNum(v) && isNum(reg) ? `  ${fmtPct(ratio(v, reg), 0)}${compact ? '' : ' of reg.'}` : ''}</tspan>
            </text>
          </g>
        );
      })}
    </svg>
  );
}
