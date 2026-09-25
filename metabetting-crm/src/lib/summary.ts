/* summary.ts — the client summary's content, shared by the printable page and
   the Markdown copy so the two never drift. */
import { FUNNEL_STAGES } from './model';
import type { Num, Snapshot } from './model';
import {
  audience, biggestDrop, dataRequests, fmtGBP, fmtN, fmtPP, fmtPct, genuineFunnel, isNum, opportunity, rates, roadmap, topSegments,
} from './calc';

export interface Headline { key: string; label: string; value: Num; fmt: 'n' | 'pct'; }
export function headlines(s: Snapshot): Headline[] {
  const r = rates(s.funnel.total);
  const hasG = isNum(s.exclusions.abusers);
  const gr = rates(genuineFunnel(s));
  const aud = audience(s);
  const offerBest = Math.max(...aud.filter((a) => a.key !== 'push').map((a) => (isNum(a.offer) ? a.offer : -1)));
  return [
    { key: 'registered', label: 'Registered players', value: s.funnel.total.registered, fmt: 'n' },
    { key: 'ftd', label: 'First-time depositors', value: s.funnel.total.ftd, fmt: 'n' },
    { key: 'active30', label: 'Active last 30 days', value: s.funnel.total.active30, fmt: 'n' },
    { key: 'abusers', label: 'Suspected bonus abusers', value: s.exclusions.abusers, fmt: 'n' },
    { key: 'verify', label: 'Verify rate', value: r.verify, fmt: 'pct' },
    { key: 'ftdRate', label: 'FTD rate', value: r.ftd, fmt: 'pct' },
    { key: 'second', label: 'Second-deposit rate', value: r.second, fmt: 'pct' },
    { key: 'gSecond', label: 'Second-deposit rate (genuine)', value: hasG ? gr.second : null, fmt: 'pct' },
    { key: 'marketable', label: 'Largest offer-marketable audience', value: offerBest >= 0 ? offerBest : null, fmt: 'n' },
    { key: 'requests', label: 'Open data requests', value: dataRequests(s).length, fmt: 'n' },
    { key: 'live', label: 'Segments live', value: s.segments.filter((g) => g.status === 'live').length, fmt: 'n' },
  ];
}
export const fmtH = (h: Headline) => (h.fmt === 'pct' ? fmtPct(h.value) : fmtN(h.value));
export function delta(h: Headline, prev: Headline | undefined): string {
  if (!prev || !isNum(h.value) || !isNum(prev.value)) return '—';
  const d = h.value - prev.value;
  if (h.fmt === 'pct') return fmtPP(d);
  return `${d >= 0 ? '+' : '−'}${fmtN(Math.abs(d))}`;
}

export function markdown(s: Snapshot, compare: Snapshot | null): string {
  const L: string[] = [];
  const h = headlines(s);
  const g = genuineFunnel(s);
  const hasG = isNum(s.exclusions.abusers);
  const drop = biggestDrop(s.funnel.total);
  const o = opportunity(s);
  const { phases, blocked } = roadmap(s);
  const reqs = dataRequests(s);

  L.push(`# ${s.meta.client}: CRM snapshot`, '', `**Date:** ${s.meta.snapshotDate || 'undated'}  `, `**Prepared by:** Digital Footprints`);
  if (s.meta.isExample) L.push('', '> **EXAMPLE DATA: dummy figures for demo only.**');
  if (s.meta.notes && !s.meta.isExample) L.push('', s.meta.notes);

  L.push('', '## Headline numbers', '', '| Metric | Value |', '|---|---:|');
  h.forEach((x) => L.push(`| ${x.label} | ${fmtH(x)} |`));

  L.push('', '## Funnel', '', `| Stage | All players | ${hasG ? 'Genuine players' : ''} |`, `|---|---:|${hasG ? '---:|' : ''}`);
  FUNNEL_STAGES.forEach((st) => L.push(`| ${st.label} | ${fmtN(s.funnel.total[st.key])} |${hasG ? ` ${fmtN(g[st.key])} |` : ''}`));
  if (hasG && s.exclusions.abuserSource !== 'system') L.push('', `_Abuser figure is a ${s.exclusions.abuserSource === 'estimate' ? 'manual estimate' : 'rule-based estimate'}: to be verified._`);

  L.push('', '## Biggest drop-off', '', drop ? `**${drop.step.label}:** ${drop.text}` : '—');

  L.push('', '## Marketable audience', '', '| Product × channel | Opted in | Offer sends |', '|---|---:|---:|');
  audience(s).forEach((a) => L.push(`| ${a.label} | ${fmtN(a.optedIn)} | ${fmtN(a.offer)} |`));

  L.push('', '## Top 5 priority segments', '', '| # | Segment | Size | Readiness | Workflow |', '|---|---|---:|---|---|');
  topSegments(s).forEach((t, i) => L.push(`| ${i + 1} | ${t.def.id} ${t.def.name} | ${fmtN(t.size.size)} | ${t.ready.ready ? 'Ready' : `Blocked: ${t.ready.missing.map((m) => m.label).join('; ')}`} | ${t.def.workflow} |`));

  L.push('', '## Data requests (Swifty Global)', '');
  if (!reqs.length) L.push('None outstanding.');
  reqs.forEach((r, i) => L.push(`${i + 1}. **${r.label}**${r.status === 'partial' ? ' (partial)' : ''}: ${r.why}`));

  L.push('', '## Opportunity estimate', '', '_Estimate for discussion, not a forecast. Genuine players only._', '');
  L.push(`Uplift assumed: verify ${s.uplifts.verify} pts, FTD ${s.uplifts.ftd} pts, second deposit ${s.uplifts.second} pts, reactivation ${s.uplifts.reactivation} pts.`, '');
  L.push(`- Extra verified players: ${fmtN(o.extraVerified)}`, `- Extra depositors: ${fmtN(o.extraDepositors)}`, `- Extra repeat depositors: ${fmtN(o.extraRepeat)}`, `- Extra reactivated players: ${fmtN(o.extraReactivated)}`);
  if (isNum(o.revenue.mid)) L.push(`- Estimated extra monthly revenue: ${fmtGBP(o.revenue.low)} – ${fmtGBP(o.revenue.high)} (mid ${fmtGBP(o.revenue.mid)}); money inputs to be confirmed by the client`);

  L.push('', '## Roadmap', '');
  phases.forEach((p) => {
    L.push(`**${p.title} (${p.when})**`);
    p.items.forEach((i) => L.push(`- ${i.id} ${i.name}${i.ready ? '' : ` (blocked: ${i.missing.join('; ')})`}`));
    p.extras.forEach((e) => L.push(`- ${e}`));
    L.push('');
  });
  if (blocked.length) {
    L.push('**After data fix**');
    blocked.forEach((i) => L.push(`- ${i.id} ${i.name}: needs ${i.missing.join('; ')}`));
    L.push('');
  }

  if (compare) {
    const prev = headlines(compare);
    L.push(`## Compared with previous snapshot (${compare.meta.snapshotDate || 'undated'})`, '', '| Metric | Then | Now | Change |', '|---|---:|---:|---:|');
    h.forEach((x) => { const p = prev.find((y) => y.key === x.key); L.push(`| ${x.label} | ${p ? fmtH(p) : '—'} | ${fmtH(x)} | ${delta(x, p)} |`); });
  }
  return L.join('\n');
}
