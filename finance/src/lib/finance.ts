/* finance.ts — money formatting and the small calculations the views share.
   Deterministic math lives here (deltas, runway, what-if); anything that needs
   judgement (narrative, scenarios, tax framing) goes to Claude via the API. */

import { BUSINESS } from './client';

const gbp0 = new Intl.NumberFormat(BUSINESS.locale, {
  style: 'currency', currency: BUSINESS.currency, maximumFractionDigits: 0,
});
const gbp2 = new Intl.NumberFormat(BUSINESS.locale, {
  style: 'currency', currency: BUSINESS.currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
});

/** £12,340 — whole pounds, for headline figures. */
export function money(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  return gbp0.format(Math.round(n));
}

/** £12,340.50 — for line items where the pennies matter. */
export function money2(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  return gbp2.format(n);
}

/** Compact £12.3k / £1.2m for tight chart labels. */
export function moneyShort(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1_000_000) return `${sign}£${(a / 1_000_000).toFixed(1)}m`;
  if (a >= 1_000) return `${sign}£${(a / 1_000).toFixed(a >= 10_000 ? 0 : 1)}k`;
  return `${sign}£${Math.round(a)}`;
}

export interface Delta { pct: number | null; abs: number; dir: 'up' | 'down' | 'flat'; }

/** Change from `prev` to `curr`. pct is null when there's no prior base. */
export function delta(curr: number, prev: number | null | undefined): Delta {
  if (prev === null || prev === undefined) return { pct: null, abs: 0, dir: 'flat' };
  const abs = curr - prev;
  const dir = abs > 0.5 ? 'up' : abs < -0.5 ? 'down' : 'flat';
  const pct = prev === 0 ? null : (abs / Math.abs(prev)) * 100;
  return { pct, abs, dir };
}

export function pctLabel(d: Delta): string {
  if (d.pct === null) return d.dir === 'flat' ? '—' : (d.abs > 0 ? '+new' : '');
  const s = d.pct > 0 ? '+' : '';
  return `${s}${d.pct.toFixed(1)}%`;
}

/** YYYY-MM -> "Jul 2025". */
export function periodLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return key;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  return d.toLocaleDateString(BUSINESS.locale, { month: 'short', year: 'numeric' });
}

/** Straight-line cash runway: months until cash hits zero at the given
    average monthly net (burn is negative net). null when cash-positive or
    when there's nothing to burn. */
export function runwayMonths(cash: number, avgNet: number): number | null {
  if (avgNet >= 0) return null;           // profitable/steady — not burning
  if (cash <= 0) return 0;
  return cash / -avgNet;
}
