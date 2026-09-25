/* calc.ts — every derived figure. Pure functions of the Snapshot.
   Rule: any null input makes the output null ("—"), never zero, never NaN. */
import {
  AUDIT_BY_ID, AUDIT_ITEMS, ABUSE_RULES, CONSENT_KEYS, FUNNEL_STAGES, SEGMENTS, SEGMENT_BY_ID,
} from './model';
import type { FunnelRow, Num, Product, SegmentDef, Snapshot, UpliftKey } from './model';

// ---------- safe arithmetic ----------
export const isNum = (v: unknown): v is number => typeof v === 'number' && isFinite(v);
export const ratio = (a: Num, b: Num): Num => (isNum(a) && isNum(b) && b > 0 ? a / b : null);
export const sub = (a: Num, b: Num): Num => (isNum(a) && isNum(b) ? Math.max(0, a - b) : null);
export const mul = (...xs: Num[]): Num => (xs.every(isNum) ? (xs as number[]).reduce((p, x) => p * x, 1) : null);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export const fmtN = (v: Num) => (isNum(v) ? Math.round(v).toLocaleString('en-GB') : '—');
export const fmtPct = (v: Num, dp = 1) => (isNum(v) ? `${(v * 100).toFixed(dp)}%` : '—');
export const fmtGBP = (v: Num) => (isNum(v) ? `£${Math.round(v).toLocaleString('en-GB')}` : '—');
export const fmtPP = (v: Num) => (isNum(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} pts` : '—');

// ---------- conversion steps ----------
export interface Step { key: string; label: string; from: keyof FunnelRow; to: keyof FunnelRow; explain: (lost: string, pct: string) => string; }
export const STEPS: Step[] = [
  { key: 'verify', label: 'Verify rate', from: 'registered', to: 'verified', explain: (l, p) => `${l} registered players (${p}) never complete verification, so they can never deposit. Fix KYC friction and reminders first.` },
  { key: 'ftd', label: 'FTD rate', from: 'verified', to: 'ftd', explain: (l, p) => `${l} verified players (${p}) never make a first deposit. A welcome and first-deposit nudge journey is the lever.` },
  { key: 'second', label: 'Second-deposit rate', from: 'ftd', to: 'dep2', explain: (l, p) => `${l} depositors (${p}) are "one and done". A second-deposit journey is the biggest value lever.` },
  { key: 'third', label: '3+ deposit rate', from: 'dep2', to: 'dep3', explain: (l, p) => `${l} repeat depositors (${p}) stop at two deposits. Product-matched content and habit-forming broadcasts help here.` },
];
export const RATE_LABELS: Record<string, string> = {
  verify: 'Verify rate', ftd: 'FTD rate', second: 'Second-deposit rate', third: '3+ deposit rate', active30: '30-day active rate (of depositors)', reactivation: '30-day reactivation of lapsed',
};

export function rates(row: FunnelRow): Record<string, Num> {
  const out: Record<string, Num> = {};
  for (const s of STEPS) out[s.key] = ratio(row[s.to], row[s.from]);
  out.active30 = ratio(row.active30, row.ftd);
  out.active7 = ratio(row.active7, row.ftd);
  return out;
}

export interface DropOff { step: Step; rate: number; lost: number; text: string; }
/** Biggest proportional loss between consecutive stages that both have figures. */
export function biggestDrop(row: FunnelRow): DropOff | null {
  let best: DropOff | null = null;
  for (const s of STEPS) {
    const a = row[s.from], b = row[s.to];
    if (!isNum(a) || !isNum(b) || a <= 0) continue;
    const rate = b / a, lostShare = 1 - rate, lost = Math.max(0, a - b);
    if (!best || lostShare > 1 - best.rate) best = { step: s, rate, lost, text: s.explain(fmtN(lost), fmtPct(lostShare, 0)) };
  }
  return best;
}

// ---------- genuine players ----------
/** Abusers are assumed to reach FTD (they deposit to claim), so they come off
    registered, verified and FTD. Beyond FTD only the "abusers with 2+ deposits"
    figure is removed (0 if blank). Each stage is capped at zero. */
export function genuineFunnel(snap: Snapshot): FunnelRow {
  const row = snap.funnel.total;
  const ab = snap.exclusions.abusers;
  const past = isNum(snap.exclusions.abusersPastFtd) ? snap.exclusions.abusersPastFtd : 0;
  const out = { ...row };
  for (const st of FUNNEL_STAGES) {
    const early = st.key === 'registered' || st.key === 'verified' || st.key === 'ftd';
    const minus = early ? ab : isNum(ab) ? Math.min(ab, past) : null;
    // Without an abuser figure there is no genuine funnel to show.
    out[st.key] = isNum(ab) ? sub(row[st.key], minus) : null;
  }
  return out;
}

// ---------- audience ----------
export const selfExRate = (s: Snapshot) => ratio(s.exclusions.selfExcluded, s.funnel.total.registered);
export const abuserRate = (s: Snapshot) => ratio(s.exclusions.abusers, s.funnel.total.registered);

export interface AudienceRow { key: string; label: string; channel: string; product: string; optedIn: Num; nonOffer: Num; offer: Num; }
/** Opted-in minus self-excluded (for any send) and minus abusers (for offer sends).
    We only have totals, so both are removed pro rata to their share of the base. */
export function audience(s: Snapshot): AudienceRow[] {
  const se = selfExRate(s), ab = abuserRate(s);
  return CONSENT_KEYS.map((c) => {
    const opt = s.consent[c.key];
    const nonOffer = isNum(opt) && isNum(se) ? opt * (1 - clamp01(se)) : null;
    const offer = isNum(nonOffer) && isNum(ab) ? nonOffer * (1 - clamp01(ab)) : null;
    return { key: c.key, label: c.label, channel: c.channel, product: c.product, optedIn: opt, nonOffer, offer };
  });
}

/** Share of the registered base reachable for a product on its best channel. */
export function consentShare(s: Snapshot, product: Product): Num {
  const reg = s.funnel.total.registered;
  const best = (p: 'betting' | 'casino'): Num => {
    const e = s.consent[`${p}_email` as const], m = s.consent[`${p}_sms` as const];
    const vals = [e, m].filter(isNum);
    return vals.length ? Math.max(...vals) : null;
  };
  if (product === 'both') {
    const b = best('betting'), c = best('casino');
    const vals = [b, c].filter(isNum);
    return vals.length ? ratio(Math.max(...vals), reg) : null;
  }
  return ratio(best(product), reg);
}

// ---------- readiness ----------
export interface Readiness { ready: boolean; missing: { id: string; label: string; status: string }[]; }
export function readiness(s: Snapshot, def: SegmentDef): Readiness {
  const missing = def.requiredFields
    .filter((f) => s.audit[f]?.status !== 'present')
    .map((f) => ({ id: f, label: AUDIT_BY_ID[f]?.label ?? f, status: s.audit[f]?.status || 'not checked' }));
  return { ready: missing.length === 0, missing };
}

// ---------- segment sizes ----------
export interface SizeInfo { size: Num; source: 'entered' | 'calculated' | 'none'; basis?: string; marketable: Num; }
export function segmentSize(s: Snapshot, id: string): SizeInfo {
  const st = s.segments.find((x) => x.id === id);
  const def = SEGMENT_BY_ID[id];
  const f = s.funnel.total;
  let size: Num = null, basis: string | undefined;
  let source: SizeInfo['source'] = 'none';
  if (st && isNum(st.size)) { size = st.size; source = 'entered'; }
  else {
    const calc: Record<string, [Num, string]> = {
      X1: [s.exclusions.selfExcluded, 'Self-excluded count'],
      X2: [sub(f.registered, s.consent.betting_email), 'Registered − betting email opt-ins'],
      X3: [sub(f.registered, s.consent.casino_email), 'Registered − casino email opt-ins'],
      X4: [s.exclusions.abusers, 'Suspected abusers'],
      S1: [sub(f.registered, f.verified), 'Registered − verified (ignores day window)'],
      S2: [sub(f.verified, f.ftd), 'Verified − FTD (ignores day window)'],
      S3: isNum(s.exclusions.abusers)
        ? [sub(sub(f.ftd, f.dep2), Math.max(0, s.exclusions.abusers - (s.exclusions.abusersPastFtd ?? 0))), 'FTD − 2+ deposits − one-deposit abusers']
        : [sub(f.ftd, f.dep2), 'FTD − 2+ deposits (abusers not removed: no abuser figure)'],
      S5c: [s.funnel.casino.active30, 'Casino active last 30 days'],
      S6: [sub(f.ftd, f.active30), 'Depositors not active in 30 days (wider than 60–90)'],
    };
    const c = calc[id];
    if (c && isNum(c[0])) { size = c[0]; basis = c[1]; source = 'calculated'; }
  }
  let marketable: Num = null;
  if (def.kind === 'lifecycle' && isNum(size)) {
    const se = selfExRate(s) ?? null, ab = abuserRate(s) ?? null, cs = consentShare(s, def.product);
    // S3 already has abusers removed in its calculated size.
    const abuseCut = def.offer && !(id === 'S3' && source === 'calculated') ? ab : 0;
    marketable = isNum(se) && isNum(cs) && isNum(abuseCut) ? size * (1 - clamp01(se)) * clamp01(cs) * (1 - clamp01(abuseCut)) : null;
  }
  return { size, source, basis, marketable };
}

// ---------- data requests ----------
export interface DataRequest { id: string; label: string; why: string; status: string; group: string; }
export function dataRequests(s: Snapshot): DataRequest[] {
  const out: DataRequest[] = AUDIT_ITEMS
    .filter((i) => i.group !== 'setup' && (s.audit[i.id]?.status === 'missing' || s.audit[i.id]?.status === 'partial'))
    .map((i) => ({ id: i.id, label: i.group === 'event' ? `Event: ${i.label}` : i.label, why: i.why, status: s.audit[i.id].status, group: i.group }));
  // Abuse signals we want to use but can't yet see.
  for (const r of s.abuseRules) {
    const def = ABUSE_RULES.find((d) => d.id === r.id)!;
    if (r.enabled && !r.dataAvailable) out.push({ id: `abuse_${r.id}`, label: `Abuse signal data: ${def.data}`, why: `So we can score "${def.label.toLowerCase()}"`, status: 'missing', group: 'abuse' });
  }
  return out;
}
export const setupGaps = (s: Snapshot) => AUDIT_ITEMS.filter((i) => i.group === 'setup' && (s.audit[i.id]?.status === 'missing' || s.audit[i.id]?.status === 'partial'));

export function requestsText(s: Snapshot): string {
  const reqs = dataRequests(s);
  if (!reqs.length) return 'No outstanding data requests.';
  const lines = [`Data requests for Swifty Global: ${s.meta.client} (${s.meta.snapshotDate})`, ''];
  reqs.forEach((r, i) => lines.push(`${i + 1}. ${r.label}${r.status === 'partial' ? ' (partial: please complete)' : ''}\n   Why we need it: ${r.why}${s.audit[r.id]?.notes ? `\n   Note: ${s.audit[r.id].notes}` : ''}`));
  return lines.join('\n');
}

// ---------- Customer.io build spec ----------
const nm = (s: Snapshot, id: string) => `\`${s.audit[id]?.cioName || AUDIT_BY_ID[id]?.hint || id}\``;
export function buildSpec(s: Snapshot, id: string): string {
  const def = SEGMENT_BY_ID[id];
  const t = s.segments.find((x) => x.id === id)?.thresholds || {};
  const d = (k: string) => (isNum(t[k]) ? String(t[k]) : '[set threshold]');
  const notX4 = 'NOT in segment X4 (Suspected bonus abuser)';
  const base = 'NOT in segment X1 (Self-excluded / GAMSTOP / time-out)';
  const consent = (p: Product) => p === 'both'
    ? `per product sent: ${nm(s, 'consent_betting')} is true for betting sends OR ${nm(s, 'consent_casino')} is true for casino sends (never both in one send)`
    : `${nm(s, p === 'betting' ? 'consent_betting' : 'consent_casino')} is true for the channel used`;
  const c: string[] = [];
  switch (id) {
    case 'X1': c.push(`Attribute ${nm(s, 'self_exclusion')} is true`, s.audit.sg_flags?.status === 'present'
      ? `OR attribute ${nm(s, 'sg_flags')} indicates an active time-out / self-exclusion`
      : `(add: OR time-out / cool-off flag active, once Swifty supplies it; build X1 on the GAMSTOP flag now)`); break;
    case 'X2': c.push(`Attribute ${nm(s, 'consent_betting')} is false or does not exist (one segment per channel: email / SMS / phone)`); break;
    case 'X3': c.push(`Attribute ${nm(s, 'consent_casino')} is false or does not exist (one segment per channel: email / SMS / phone)`); break;
    case 'X4': c.push(`Attribute ${nm(s, 'abuse_flag')} equals "high" (or "medium", per risk team) OR is true`); break;
    case 'X5': c.push(`Attribute ${nm(s, 'sg_flags')} (limit hit / cool-off) changed in the last ${d('holdDays')} days`); break;
    case 'S1': c.push(`Attribute ${nm(s, 'signup_date')} more than ${d('minDays')} days ago`, `AND attribute ${nm(s, 'kyc_status')} does not equal "verified"`); break;
    case 'S2': c.push(`Attribute ${nm(s, 'kyc_status')} equals "verified"`, `AND verified date between ${d('minDays')} and ${d('maxDays')} days ago`, `AND attribute ${nm(s, 'deposit_count')} equals 0`); break;
    case 'S3': c.push(`Attribute ${nm(s, 'deposit_count')} equals 1`, `AND attribute ${nm(s, 'first_deposit_date')} more than ${d('minDays')} days ago`, `AND ${notX4}`); break;
    case 'S4a': c.push(`Attribute ${nm(s, 'last_bet_sb')} between ${d('minDays')} and ${d('maxDays')} days ago`); break;
    case 'S4b': c.push(`Attribute ${nm(s, 'last_play_casino')} between ${d('minDays')} and ${d('maxDays')} days ago`); break;
    case 'S5a': c.push(`Performed event ${nm(s, 'ev_bet_placed')} where sport = "football" at least once in the last ${d('windowDays')} days`, `(or attribute ${nm(s, 'preferred_sport')} equals "football")`); break;
    case 'S5b': c.push(`Performed event ${nm(s, 'ev_bet_placed')} where sport = "horse racing" at least once in the last ${d('windowDays')} days`, `(or attribute ${nm(s, 'preferred_sport')} equals "horse racing")`); break;
    case 'S5c': c.push(`Performed event ${nm(s, 'ev_casino_round')} at least once in the last ${d('windowDays')} days`, `(or attribute ${nm(s, 'last_play_casino')} within the last ${d('windowDays')} days)`); break;
    case 'S6': c.push(`Attribute ${nm(s, 'last_bet_sb')} more than ${d('minDays')} days ago (or does not exist)`, `AND attribute ${nm(s, 'last_play_casino')} more than ${d('minDays')} days ago (or does not exist)`, `AND attribute ${nm(s, 'last_deposit_date')} more than ${d('minDays')} days ago`, `Sunset after ${d('maxDays')} days with no response`); break;
    case 'S7': c.push(`Attribute ${nm(s, 'ltv')} greater than or equal to ${isNum(t.minValue) ? `£${t.minValue}` : '[set threshold]'}`); break;
  }
  if (def.kind === 'lifecycle') {
    c.push(`AND ${base}`, `AND NOT in segment X5 (Safer gambling watch)`);
    if (def.offer && id !== 'S3') c.push(`AND ${notX4} (for any send containing an offer)`);
    c.push(`Channel filter: ${consent(def.product)}`);
  }
  const r = readiness(s, def);
  return [
    `Segment ${def.id}: ${def.name}`,
    `Type: ${def.kind === 'exclusion' ? 'Exclusion (use as a filter on every campaign)' : `Lifecycle · ${def.product === 'both' ? 'single-product sends, product-matched' : def.product}`}`,
    '',
    'Conditions:',
    ...c.map((x) => `  ${x}`),
    '',
    `Workflow: ${def.workflow}`,
    r.ready ? 'Readiness: Ready' : `Readiness: BLOCKED. Missing data: ${r.missing.map((m) => m.label).join('; ')}`,
  ].join('\n');
}

// ---------- abuse rule ----------
export function abuseRuleText(s: Snapshot): { text: string; max: number; usable: number } {
  const on = s.abuseRules.filter((r) => r.enabled);
  const max = on.reduce((p, r) => p + (isNum(r.weight) ? r.weight : 0), 0);
  const usable = on.filter((r) => r.dataAvailable).reduce((p, r) => p + (isNum(r.weight) ? r.weight : 0), 0);
  const medAt = Math.ceil((max * s.abuseBands.medium) / 100), highAt = Math.ceil((max * s.abuseBands.high) / 100);
  const lines = on.map((r) => {
    const def = ABUSE_RULES.find((d) => d.id === r.id)!;
    const label = def.param ? def.label.replace('X days', `${isNum(r.param) ? r.param : 'X'} days`) : def.label;
    return `  +${r.weight}  ${label}${r.dataAvailable ? '' : '  [data not yet available]'}`;
  });
  const text = [
    '`abuse_risk` score = sum of the weights of every signal the player matches:',
    ...lines,
    '',
    `Bands (max score ${max}):`,
    `  low     score < ${medAt}`,
    `  medium  score ${medAt}–${Math.max(medAt, highAt - 1)}`,
    `  high    score ≥ ${highAt}`,
    '',
    'Set `abuse_risk` = "high" → in segment X4 (no offers).',
    'Medium: review with the client risk team before suppressing.',
    usable < max ? `Only ${usable} of ${max} points can be scored from data we have today; request the rest from Swifty, or build a Customer.io segment from what exists.` : 'All enabled signals have data: this can be built as a Customer.io segment today.',
  ].join('\n');
  return { text, max, usable };
}

// ---------- opportunity ----------
export interface Opportunity {
  base: FunnelRow;
  extraVerified: Num; extraDepositors: Num; extraRepeat: Num; extraReactivated: Num;
  lapsedPool: Num;
  revenue: { low: Num; mid: Num; high: Num; firstDepositValue: Num };
  /** The extra monthly-active players the revenue is built from, by source. */
  activeParts: { newDepositors: Num; activeRate: Num; repeat: Num; reactivated: Num; total: Num };
}
export function opportunity(s: Snapshot): Opportunity {
  const g = genuineFunnel(s);
  const r = rates(g);
  const u = (k: UpliftKey) => (isNum(s.uplifts[k]) ? s.uplifts[k] / 100 : 0);
  const extraVerified = mul(g.registered, u('verify'));
  const newVerified = isNum(g.verified) && isNum(extraVerified) ? g.verified + extraVerified : null;
  const newFtdRate = isNum(r.ftd) ? clamp01(r.ftd + u('ftd')) : null;
  const newFtd = mul(newVerified, newFtdRate);
  const extraDepositors = isNum(newFtd) && isNum(g.ftd) ? Math.max(0, newFtd - g.ftd) : null;
  const newSecondRate = isNum(r.second) ? clamp01(r.second + u('second')) : null;
  const newDep2 = mul(newFtd, newSecondRate);
  const extraRepeat = isNum(newDep2) && isNum(g.dep2) ? Math.max(0, newDep2 - g.dep2) : null;
  const lapsedPool = sub(g.ftd, g.active30);
  const extraReactivated = mul(lapsedPool, u('reactivation'));
  const ngr = s.money.ngrPerActive;
  // Extra monthly-active players, from three sources that don't overlap:
  //  - new depositors (from verify + FTD uplift), active at today's genuine
  //    30-day active rate of depositors;
  //  - existing depositors making a repeat deposit (second-deposit uplift on
  //    today's base only; new depositors are already counted above);
  //  - lapsed depositors reactivated.
  const activeRate = isNum(r.active30) ? clamp01(r.active30) : null;
  const fromNew = mul(extraDepositors, activeRate);
  const repeat = isNum(r.second) ? mul(g.ftd, Math.min(u('second'), 1 - r.second)) : null;
  const parts = [fromNew, repeat, extraReactivated].filter(isNum);
  const activeGain = parts.length ? parts.reduce((p, x) => p + x, 0) : null;
  const mid = mul(activeGain, ngr);
  return {
    base: g, extraVerified, extraDepositors, extraRepeat, extraReactivated, lapsedPool,
    revenue: { low: mul(mid, 0.5), mid, high: mul(mid, 1.5), firstDepositValue: mul(extraDepositors, s.money.avgDeposit) },
    activeParts: { newDepositors: fromNew, activeRate, repeat, reactivated: extraReactivated, total: activeGain },
  };
}

// ---------- KPIs vs targets ----------
export function kpis(s: Snapshot) {
  const g = genuineFunnel(s);
  const hasG = isNum(s.exclusions.abusers);
  const r = rates(hasG ? g : s.funnel.total);
  return (['verify', 'ftd', 'second', 'third', 'active30'] as const).map((k) => {
    const t = s.targets[k];
    const target = isNum(t) ? t / 100 : null;
    return { key: k, label: RATE_LABELS[k], current: r[k], target, gap: isNum(target) && isNum(r[k]) ? target - (r[k] as number) : null };
  });
}

// ---------- roadmap ----------
export interface RoadItem { id: string; name: string; ready: boolean; missing: string[]; status: string; }
export interface Phase { key: string; title: string; when: string; items: RoadItem[]; extras: string[]; }
export function roadmap(s: Snapshot): { phases: Phase[]; blocked: RoadItem[] } {
  const item = (def: SegmentDef): RoadItem => {
    const r = readiness(s, def);
    return { id: def.id, name: def.name, ready: r.ready, missing: r.missing.map((m) => m.label), status: s.segments.find((x) => x.id === def.id)?.status || 'not_started' };
  };
  const bySeg = (ids: string[]) => ids.map((id) => item(SEGMENT_BY_ID[id]));
  const sorted = (ids: string[]) => ids.sort((a, b) => (s.segments.find((x) => x.id === a)?.priority ?? 0) - (s.segments.find((x) => x.id === b)?.priority ?? 0));
  const blocked: RoadItem[] = [];
  const phaseItems = (ids: string[], alwaysShow = false) => {
    const all = bySeg(sorted(ids));
    // Exclusions stay in Phase 1 even when blocked (they're mandatory), flagged.
    if (alwaysShow) return all;
    all.filter((i) => !i.ready).forEach((i) => blocked.push(i));
    return all.filter((i) => i.ready);
  };
  const reqs = dataRequests(s);
  const setup = setupGaps(s);
  const phases: Phase[] = [
    { key: 'p0', title: 'Phase 0: data fixes', when: 'Now', items: [], extras: [...reqs.map((r) => `Swifty: ${r.label}`), ...setup.map((i) => `Set-up: ${i.label}`)] },
    { key: 'p1', title: 'Phase 1', when: 'Weeks 1–2', items: [...phaseItems(['X1', 'X2', 'X3', 'X4', 'X5'], true), ...phaseItems(['S1', 'S2'])], extras: [] },
    { key: 'p2', title: 'Phase 2', when: 'Weeks 3–4', items: phaseItems(['S3', 'S4a', 'S4b']), extras: [] },
    { key: 'p3', title: 'Phase 3', when: 'Weeks 5–6', items: phaseItems(['S5a', 'S5b', 'S5c']), extras: ['Sporting-calendar broadcasts (single-product)'] },
    { key: 'p4', title: 'Phase 4', when: 'Ongoing', items: phaseItems(['S6', 'S7']), extras: ['A/B testing programme', 'Monthly reporting'] },
  ];
  if (!phases[0].extras.length) phases[0].extras.push('No outstanding data requests');
  return { phases, blocked };
}

/** Lifecycle segments ranked by priority, for the summary's top 5. */
export function topSegments(s: Snapshot, n = 5) {
  return SEGMENTS.filter((d) => d.kind === 'lifecycle')
    .map((d) => ({ def: d, st: s.segments.find((x) => x.id === d.id)!, size: segmentSize(s, d.id), ready: readiness(s, d) }))
    .sort((a, b) => a.st.priority - b.st.priority)
    .slice(0, n);
}
