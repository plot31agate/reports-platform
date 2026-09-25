/* model.ts — the snapshot's shape, the fixed vocabulary (audit checklist,
   segments, abuse signals) and the blank + example states.

   Everything a person types is optional: numbers are `number | null` and every
   calculation downstream treats null as "unknown", never as zero. */

export type AuditStatus = 'present' | 'partial' | 'missing' | '';
export type Product = 'betting' | 'casino' | 'both';
export type SegStatus = 'not_started' | 'building' | 'live';
export type AbuserSource = 'system' | 'estimate' | 'rules';
export type Num = number | null;

export interface AuditEntry { status: AuditStatus; cioName: string; notes: string; value?: string; }

export interface AuditItem {
  id: string;
  group: 'profile' | 'event' | 'setup';
  label: string;
  why: string;
  /** Suggested Customer.io name, shown as a placeholder only. */
  hint?: string;
  /** Setup items with a pick-list value (e.g. sync speed). */
  options?: string[];
}

export const AUDIT_ITEMS: AuditItem[] = [
  // ---- Profile attributes ----
  { id: 'signup_date', group: 'profile', label: 'Sign-up date', why: 'Every time-based segment', hint: 'created_at' },
  { id: 'kyc_status', group: 'profile', label: 'Verification (KYC) status + date', why: '"Not verified" workflow', hint: 'kyc_status' },
  { id: 'first_deposit_date', group: 'profile', label: 'First deposit date', why: 'FTD segments', hint: 'first_deposit_date' },
  { id: 'deposit_count', group: 'profile', label: 'Deposit count', why: 'One-and-done, repeat depositors', hint: 'deposit_count' },
  { id: 'last_deposit_date', group: 'profile', label: 'Last deposit date', why: 'Lapse logic', hint: 'last_deposit_date' },
  { id: 'ltv', group: 'profile', label: 'Total deposit value / lifetime value', why: 'Value tiers, VIP', hint: 'total_deposits' },
  { id: 'last_bet_sb', group: 'profile', label: 'Last bet date: sportsbook', why: 'Sportsbook lapse', hint: 'last_bet_date' },
  { id: 'last_play_casino', group: 'profile', label: 'Last play date: casino', why: 'Casino lapse', hint: 'last_casino_play_date' },
  { id: 'product_played', group: 'profile', label: 'Product played (sportsbook / casino / both)', why: 'Product split', hint: 'product_played' },
  { id: 'preferred_sport', group: 'profile', label: 'Preferred sport (football, racing etc.)', why: 'Content personalisation', hint: 'preferred_sport' },
  { id: 'consent_betting', group: 'profile', label: 'Marketing consent: betting × email / SMS / phone', why: 'Legal audience', hint: 'consent_betting_email' },
  { id: 'consent_casino', group: 'profile', label: 'Marketing consent: casino × email / SMS / phone', why: 'Legal audience', hint: 'consent_casino_email' },
  { id: 'push_optin', group: 'profile', label: 'Push opt-in', why: 'Push channel', hint: 'push_opt_in' },
  { id: 'self_exclusion', group: 'profile', label: 'Self-exclusion / GAMSTOP flag', why: 'Mandatory suppression', hint: 'self_excluded' },
  { id: 'sg_flags', group: 'profile', label: 'Deposit limit / time-out / cool-off flags', why: 'Safer gambling suppression', hint: 'sg_cool_off' },
  { id: 'abuse_flag', group: 'profile', label: 'Bonus abuse flag or risk score', why: 'Offer suppression', hint: 'abuse_risk' },
  { id: 'acq_source', group: 'profile', label: 'Acquisition source / affiliate', why: 'Abuse by source, quality by source', hint: 'affiliate_id' },
  { id: 'welcome_offer', group: 'profile', label: 'Welcome offer claimed (Y/N, date)', why: 'Offer journeys', hint: 'welcome_offer_claimed' },
  // ---- Events ----
  { id: 'ev_registered', group: 'event', label: 'registered', why: 'Triggers the welcome and verification journeys', hint: 'registered' },
  { id: 'ev_verified', group: 'event', label: 'verified', why: 'Triggers the first-deposit nudge the moment KYC clears', hint: 'verified' },
  { id: 'ev_deposit', group: 'event', label: 'deposit', why: 'FTD and second-deposit triggers; deposit counting', hint: 'deposit' },
  { id: 'ev_withdrawal', group: 'event', label: 'withdrawal', why: 'Bonus abuse signals (withdraw straight after bonus)', hint: 'withdrawal' },
  { id: 'ev_bet_placed', group: 'event', label: 'bet_placed (with sport / market / odds)', why: 'Sport-based content segments and min-odds abuse signal', hint: 'bet_placed' },
  { id: 'ev_casino_round', group: 'event', label: 'casino_round / game_played (with game)', why: 'Casino activity, favourite games, new-release targeting', hint: 'game_played' },
  { id: 'ev_bonus_claimed', group: 'event', label: 'bonus_claimed', why: 'Offer journeys and abuse signals', hint: 'bonus_claimed' },
  { id: 'ev_bonus_completed', group: 'event', label: 'bonus_completed', why: 'Withdraw-after-bonus abuse signal', hint: 'bonus_completed' },
  { id: 'ev_login', group: 'event', label: 'login', why: 'Activity and lapse definitions beyond betting/playing', hint: 'login' },
  // ---- Set-up checks ----
  { id: 'setup_domain', group: 'setup', label: 'Sending domain authenticated (SPF / DKIM / DMARC)', why: 'Email deliverability; unauthenticated mail lands in spam' },
  { id: 'setup_sms', group: 'setup', label: 'SMS provider connected', why: 'SMS channel for reminders and reactivation' },
  { id: 'setup_push', group: 'setup', label: 'Push set up', why: 'Push channel for live sporting moments' },
  { id: 'setup_campaigns', group: 'setup', label: 'Existing campaigns listed', why: 'Avoid double-sending and know what is already live' },
  { id: 'setup_sync', group: 'setup', label: 'Data sync speed', why: 'Real-time triggers (e.g. verified → deposit nudge) need a fast sync', options: ['real-time', 'hourly', 'daily', 'unknown'] },
];

export const AUDIT_BY_ID: Record<string, AuditItem> = Object.fromEntries(AUDIT_ITEMS.map((i) => [i.id, i]));

// ---- Funnel ----
export type FunnelKey = 'registered' | 'verified' | 'ftd' | 'dep2' | 'dep3' | 'active7' | 'active30';
export const FUNNEL_STAGES: { key: FunnelKey; label: string }[] = [
  { key: 'registered', label: 'Registered' },
  { key: 'verified', label: 'Verified' },
  { key: 'ftd', label: 'First deposit (FTD)' },
  { key: 'dep2', label: '2+ deposits' },
  { key: 'dep3', label: '3+ deposits' },
  { key: 'active7', label: 'Active last 7 days' },
  { key: 'active30', label: 'Active last 30 days' },
];
export type FunnelRow = Record<FunnelKey, Num>;
export type Scope = 'total' | 'sportsbook' | 'casino';
export const SCOPES: { key: Scope; label: string }[] = [
  { key: 'total', label: 'Total' },
  { key: 'sportsbook', label: 'Sportsbook' },
  { key: 'casino', label: 'Casino' },
];

export type ConsentKey = 'betting_email' | 'betting_sms' | 'casino_email' | 'casino_sms' | 'push';
export const CONSENT_KEYS: { key: ConsentKey; label: string; product: Product | 'all'; channel: string }[] = [
  { key: 'betting_email', label: 'Betting × email', product: 'betting', channel: 'Email' },
  { key: 'betting_sms', label: 'Betting × SMS', product: 'betting', channel: 'SMS' },
  { key: 'casino_email', label: 'Casino × email', product: 'casino', channel: 'Email' },
  { key: 'casino_sms', label: 'Casino × SMS', product: 'casino', channel: 'SMS' },
  { key: 'push', label: 'Push (device-level)', product: 'all', channel: 'Push' },
];

// ---- Segments ----
export interface Threshold { key: string; label: string; unit: 'days' | '£'; def: number | null; }
export interface SegmentDef {
  id: string;
  kind: 'exclusion' | 'lifecycle';
  name: string;
  rule: string;
  workflow: string;
  quickWin: string;
  product: Product;
  requiredFields: string[];
  thresholds: Threshold[];
  /** Offer-based sends drop suspected abusers from the marketable count. */
  offer: boolean;
  phase: 1 | 2 | 3 | 4;
  priority: number;
}

export const SEGMENTS: SegmentDef[] = [
  { id: 'X1', kind: 'exclusion', name: 'Self-excluded / GAMSTOP / time-out', rule: 'flag = true. Never market', workflow: 'Global suppression on every campaign', quickWin: 'Build first', product: 'both', requiredFields: ['self_exclusion', 'sg_flags'], thresholds: [], offer: false, phase: 1, priority: 1 },
  { id: 'X2', kind: 'exclusion', name: 'No consent: betting', rule: 'Exclude from betting marketing, per channel', workflow: 'Channel filter on all betting campaigns', quickWin: 'Build first', product: 'betting', requiredFields: ['consent_betting'], thresholds: [], offer: false, phase: 1, priority: 2 },
  { id: 'X3', kind: 'exclusion', name: 'No consent: casino', rule: 'Exclude from casino marketing, per channel', workflow: 'Channel filter on all casino campaigns', quickWin: 'Build first', product: 'casino', requiredFields: ['consent_casino'], thresholds: [], offer: false, phase: 1, priority: 3 },
  { id: 'X4', kind: 'exclusion', name: 'Suspected bonus abuser', rule: 'Exclude from all offers; service and safer gambling messages OK', workflow: 'Offer suppression', quickWin: 'Build first', product: 'both', requiredFields: ['abuse_flag'], thresholds: [], offer: false, phase: 1, priority: 4 },
  { id: 'X5', kind: 'exclusion', name: 'Safer gambling watch', rule: 'Recent limit hit / cool-off: hold promotional sends', workflow: 'Promotional hold', quickWin: 'Build first', product: 'both', requiredFields: ['sg_flags'], thresholds: [{ key: 'holdDays', label: 'Hold for', unit: 'days', def: 30 }], offer: false, phase: 1, priority: 5 },

  { id: 'S1', kind: 'lifecycle', name: 'Not verified', rule: 'Registered ≥ N days, KYC incomplete', workflow: 'Verification reminders + help (3 steps over 7 days)', quickWin: 'Yes', product: 'both', requiredFields: ['signup_date', 'kyc_status'], thresholds: [{ key: 'minDays', label: 'Registered at least', unit: 'days', def: 1 }], offer: false, phase: 1, priority: 6 },
  { id: 'S2', kind: 'lifecycle', name: 'Verified, no deposit', rule: 'Verified, deposits = 0, within day window', workflow: 'Welcome and first-deposit nudge', quickWin: 'Yes', product: 'both', requiredFields: ['kyc_status', 'deposit_count'], thresholds: [{ key: 'minDays', label: 'Verified from', unit: 'days', def: 1 }, { key: 'maxDays', label: 'to', unit: 'days', def: 14 }], offer: true, phase: 1, priority: 7 },
  { id: 'S3', kind: 'lifecycle', name: 'One and done', rule: 'Deposits = 1, ≥ N days since FTD, not X4', workflow: 'Second-deposit journey, product-matched content', quickWin: 'Yes: biggest value lever', product: 'both', requiredFields: ['deposit_count', 'first_deposit_date', 'abuse_flag'], thresholds: [{ key: 'minDays', label: 'Days since FTD at least', unit: 'days', def: 7 }], offer: true, phase: 2, priority: 8 },
  { id: 'S4a', kind: 'lifecycle', name: 'Sportsbook recently lapsed', rule: 'No bet within day window', workflow: '"What\'s on this weekend"', quickWin: 'Yes', product: 'betting', requiredFields: ['last_bet_sb'], thresholds: [{ key: 'minDays', label: 'No bet from', unit: 'days', def: 14 }, { key: 'maxDays', label: 'to', unit: 'days', def: 30 }], offer: true, phase: 2, priority: 9 },
  { id: 'S4b', kind: 'lifecycle', name: 'Casino recently lapsed', rule: 'No play within day window', workflow: 'New games / favourites', quickWin: 'Yes', product: 'casino', requiredFields: ['last_play_casino'], thresholds: [{ key: 'minDays', label: 'No play from', unit: 'days', def: 7 }, { key: 'maxDays', label: 'to', unit: 'days', def: 14 }], offer: true, phase: 2, priority: 10 },
  { id: 'S5a', kind: 'lifecycle', name: 'Active: football', rule: 'Bet on football in the window', workflow: 'Weekly fixtures content', quickWin: 'Medium', product: 'betting', requiredFields: ['ev_bet_placed', 'preferred_sport'], thresholds: [{ key: 'windowDays', label: 'Bet within last', unit: 'days', def: 30 }], offer: false, phase: 3, priority: 11 },
  { id: 'S5b', kind: 'lifecycle', name: 'Active: racing', rule: 'Bet on racing in the window', workflow: 'Big races / festival content', quickWin: 'Medium', product: 'betting', requiredFields: ['ev_bet_placed', 'preferred_sport'], thresholds: [{ key: 'windowDays', label: 'Bet within last', unit: 'days', def: 30 }], offer: false, phase: 3, priority: 12 },
  { id: 'S5c', kind: 'lifecycle', name: 'Active: casino', rule: 'Played in the window', workflow: 'New releases', quickWin: 'Medium', product: 'casino', requiredFields: ['ev_casino_round', 'last_play_casino'], thresholds: [{ key: 'windowDays', label: 'Played within last', unit: 'days', def: 30 }], offer: false, phase: 3, priority: 13 },
  { id: 'S6', kind: 'lifecycle', name: 'Long lapsed', rule: 'No activity within day window', workflow: '3-step win-back, then sunset', quickWin: 'Later', product: 'both', requiredFields: ['last_bet_sb', 'last_play_casino', 'last_deposit_date'], thresholds: [{ key: 'minDays', label: 'No activity from', unit: 'days', def: 60 }, { key: 'maxDays', label: 'to', unit: 'days', def: 90 }], offer: true, phase: 4, priority: 14 },
  { id: 'S7', kind: 'lifecycle', name: 'High value', rule: 'Top deposit or stake band', workflow: 'VIP handover with affordability checks', quickWin: 'Later', product: 'both', requiredFields: ['ltv'], thresholds: [{ key: 'minValue', label: 'Lifetime deposits at least', unit: '£', def: 1000 }], offer: false, phase: 4, priority: 15 },
];
export const SEGMENT_BY_ID: Record<string, SegmentDef> = Object.fromEntries(SEGMENTS.map((s) => [s.id, s]));

export interface SegmentState { id: string; size: Num; thresholds: Record<string, Num>; status: SegStatus; priority: number; }

// ---- Abuse rules ----
export interface AbuseRuleDef { id: string; label: string; data: string; param?: { label: string; def: number }; defWeight: number; }
export const ABUSE_RULES: AbuseRuleDef[] = [
  { id: 'fast_withdraw', label: 'Withdrew within X days of bonus completion', data: 'bonus_completed + withdrawal events', param: { label: 'X days', def: 3 }, defWeight: 3 },
  { id: 'welcome_only', label: 'Only ever deposited to claim the welcome offer (1 deposit + bonus claimed)', data: 'deposit_count + welcome offer claimed', defWeight: 2 },
  { id: 'min_odds', label: 'Bets placed only at the minimum qualifying odds', data: 'bet_placed with odds', defWeight: 2 },
  { id: 'shared_identity', label: 'Shares a device / IP / address / payment method with other accounts', data: 'Platform-side (Swifty) linkage data', defWeight: 4 },
  { id: 'dormant_after_free_bet', label: 'No activity after the free bet was used', data: 'bonus_completed + last bet/play date', defWeight: 1 },
  { id: 'risky_source', label: 'Acquired from a known matched-betting / affiliate source', data: 'Acquisition source / affiliate', defWeight: 2 },
];
export interface AbuseRuleState { id: string; enabled: boolean; weight: number; dataAvailable: boolean; param: Num; }

// ---- Opportunity ----
export type UpliftKey = 'verify' | 'ftd' | 'second' | 'reactivation';
export const UPLIFTS: { key: UpliftKey; label: string }[] = [
  { key: 'verify', label: 'Verify rate' },
  { key: 'ftd', label: 'FTD rate' },
  { key: 'second', label: 'Second-deposit rate' },
  { key: 'reactivation', label: '30-day reactivation of lapsed' },
];
export type KpiKey = 'verify' | 'ftd' | 'second' | 'third' | 'active30' | 'reactivation';

export interface Snapshot {
  version: 1;
  meta: { client: string; snapshotDate: string; notes: string; isExample: boolean; lastExported: string };
  /** Manual ticks on the Start-here checklist (auto steps are computed). */
  checklist: Record<string, boolean>;
  audit: Record<string, AuditEntry>;
  funnel: Record<Scope, FunnelRow>;
  consent: Record<ConsentKey, Num>;
  exclusions: { selfExcluded: Num; abusers: Num; abuserSource: AbuserSource; abusersPastFtd: Num };
  money: { avgDeposit: Num; ngrPerActive: Num };
  segments: SegmentState[];
  abuseRules: AbuseRuleState[];
  abuseBands: { medium: number; high: number };
  uplifts: Record<UpliftKey, number>;
  targets: Partial<Record<KpiKey, Num>>;
}

const emptyRow = (): FunnelRow => ({ registered: null, verified: null, ftd: null, dep2: null, dep3: null, active7: null, active30: null });

export function blankSnapshot(): Snapshot {
  return {
    version: 1,
    meta: { client: 'Meta Betting', snapshotDate: new Date().toISOString().slice(0, 10), notes: '', isExample: false, lastExported: '' },
    checklist: {},
    audit: Object.fromEntries(AUDIT_ITEMS.map((i) => [i.id, { status: '', cioName: '', notes: '', ...(i.options ? { value: '' } : {}) }])),
    funnel: { total: emptyRow(), sportsbook: emptyRow(), casino: emptyRow() },
    consent: { betting_email: null, betting_sms: null, casino_email: null, casino_sms: null, push: null },
    exclusions: { selfExcluded: null, abusers: null, abuserSource: 'estimate', abusersPastFtd: null },
    money: { avgDeposit: null, ngrPerActive: null },
    segments: SEGMENTS.map((s) => ({
      id: s.id, size: null, status: 'not_started', priority: s.priority,
      thresholds: Object.fromEntries(s.thresholds.map((t) => [t.key, t.def])),
    })),
    abuseRules: ABUSE_RULES.map((r) => ({ id: r.id, enabled: true, weight: r.defWeight, dataAvailable: false, param: r.param?.def ?? null })),
    abuseBands: { medium: 35, high: 60 },
    uplifts: { verify: 0, ftd: 0, second: 0, reactivation: 0 },
    targets: {},
  };
}

/** Merge an imported / stored object onto a blank snapshot so older or partial
    files still load, and every known key exists. Unknown keys are dropped. */
export function normalise(raw: unknown): Snapshot {
  const b = blankSnapshot();
  if (!raw || typeof raw !== 'object') return b;
  const r = raw as Partial<Snapshot>;
  const num = (v: unknown): Num => (typeof v === 'number' && isFinite(v) ? v : null);
  const out: Snapshot = { ...b };
  out.meta = { ...b.meta, ...(r.meta || {}) };
  out.checklist = Object.fromEntries(Object.entries(r.checklist || {}).filter(([, v]) => typeof v === 'boolean'));
  out.audit = Object.fromEntries(AUDIT_ITEMS.map((i) => [i.id, { ...b.audit[i.id], ...((r.audit || {})[i.id] || {}) }]));
  for (const sc of SCOPES) {
    const src = (r.funnel || ({} as Snapshot['funnel']))[sc.key] || {};
    out.funnel[sc.key] = Object.fromEntries(FUNNEL_STAGES.map((st) => [st.key, num((src as Record<string, unknown>)[st.key])])) as FunnelRow;
  }
  out.consent = Object.fromEntries(CONSENT_KEYS.map((c) => [c.key, num((r.consent || ({} as Record<string, unknown>))[c.key])])) as Snapshot['consent'];
  const ex = r.exclusions || ({} as Snapshot['exclusions']);
  out.exclusions = {
    selfExcluded: num(ex.selfExcluded), abusers: num(ex.abusers),
    abuserSource: (['system', 'estimate', 'rules'] as const).includes(ex.abuserSource) ? ex.abuserSource : 'estimate',
    abusersPastFtd: num(ex.abusersPastFtd),
  };
  out.money = { avgDeposit: num(r.money?.avgDeposit), ngrPerActive: num(r.money?.ngrPerActive) };
  out.segments = b.segments.map((s) => {
    const m = (r.segments || []).find((x) => x && x.id === s.id);
    if (!m) return s;
    return {
      ...s,
      size: num(m.size),
      status: (['not_started', 'building', 'live'] as const).includes(m.status) ? m.status : s.status,
      priority: typeof m.priority === 'number' ? m.priority : s.priority,
      thresholds: Object.fromEntries(Object.keys(s.thresholds).map((k) => [k, k in (m.thresholds || {}) ? num(m.thresholds[k]) : s.thresholds[k]])),
    };
  });
  out.abuseRules = b.abuseRules.map((a) => {
    const m = (r.abuseRules || []).find((x) => x && x.id === a.id);
    return m ? { ...a, enabled: !!m.enabled, dataAvailable: !!m.dataAvailable, weight: num(m.weight) ?? a.weight, param: m.param === null ? null : num(m.param) ?? a.param } : a;
  });
  out.abuseBands = { medium: num(r.abuseBands?.medium) ?? b.abuseBands.medium, high: num(r.abuseBands?.high) ?? b.abuseBands.high };
  out.uplifts = Object.fromEntries(UPLIFTS.map((u) => [u.key, num((r.uplifts || ({} as Record<string, unknown>))[u.key]) ?? 0])) as Snapshot['uplifts'];
  out.targets = Object.fromEntries(Object.entries(r.targets || {}).map(([k, v]) => [k, num(v)]));
  return out;
}

/** Dummy figures for demos. Clearly flagged via meta.isExample. */
export function exampleSnapshot(): Snapshot {
  const s = blankSnapshot();
  s.meta = { client: 'Meta Betting', snapshotDate: new Date().toISOString().slice(0, 10), notes: 'EXAMPLE DATA: dummy figures for demo only.', isExample: true, lastExported: '' };
  const set = (id: string, status: AuditStatus, cioName = '', notes = '', value?: string) => { s.audit[id] = { status, cioName, notes, ...(value !== undefined ? { value } : {}) }; };
  set('signup_date', 'present', 'created_at');
  set('kyc_status', 'partial', 'kyc_status', 'Status present, no verified date');
  set('first_deposit_date', 'present', 'first_deposit_date');
  set('deposit_count', 'present', 'deposit_count');
  set('last_deposit_date', 'present', 'last_deposit_date');
  set('ltv', 'missing', '', 'Not synced from Swifty');
  set('last_bet_sb', 'present', 'last_bet_date');
  set('last_play_casino', 'missing');
  set('product_played', 'partial', 'product', 'Only set at sign-up');
  set('preferred_sport', 'missing');
  set('consent_betting', 'present', 'consent_betting_email');
  set('consent_casino', 'present', 'consent_casino_email');
  set('push_optin', 'missing');
  set('self_exclusion', 'present', 'gamstop_flag');
  set('sg_flags', 'partial', 'deposit_limit_set', 'Limits only, no cool-off');
  set('abuse_flag', 'missing', '', 'Client estimate only');
  set('acq_source', 'present', 'affiliate_id');
  set('welcome_offer', 'partial', 'welcome_claimed', 'No date');
  set('ev_registered', 'present', 'registered');
  set('ev_verified', 'missing');
  set('ev_deposit', 'present', 'deposit');
  set('ev_withdrawal', 'missing');
  set('ev_bet_placed', 'partial', 'bet_placed', 'No sport attribute');
  set('ev_casino_round', 'missing');
  set('ev_bonus_claimed', 'present', 'bonus_claimed');
  set('ev_bonus_completed', 'missing');
  set('ev_login', 'present', 'login');
  set('setup_domain', 'partial', '', 'SPF + DKIM ok, no DMARC');
  set('setup_sms', 'missing');
  set('setup_push', 'missing');
  set('setup_campaigns', 'present', '', '4 broadcasts, no journeys');
  set('setup_sync', 'partial', '', 'Daily batch', 'daily');
  s.funnel.total = { registered: 30000, verified: 21000, ftd: 11500, dep2: 4300, dep3: 2600, active7: 1900, active30: 4100 };
  s.funnel.sportsbook = { registered: 19000, verified: 13600, ftd: 7600, dep2: 3000, dep3: 1850, active7: 1350, active30: 2800 };
  s.funnel.casino = { registered: 11000, verified: 7400, ftd: 3900, dep2: 1300, dep3: 750, active7: 550, active30: 1300 };
  s.consent = { betting_email: 16500, betting_sms: 9800, casino_email: 11200, casino_sms: 6400, push: null };
  s.exclusions = { selfExcluded: 900, abusers: 6000, abuserSource: 'estimate', abusersPastFtd: 600 };
  s.money = { avgDeposit: 35, ngrPerActive: 42 };
  s.abuseRules = s.abuseRules.map((r) => ({ ...r, dataAvailable: ['welcome_only', 'risky_source'].includes(r.id) }));
  s.segments = s.segments.map((g) => (g.id === 'S4a' ? { ...g, size: 1600 } : g.id === 'S6' ? { ...g, size: 5200 } : g));
  s.uplifts = { verify: 3, ftd: 4, second: 5, reactivation: 5 };
  s.targets = { verify: 75, ftd: 60, second: 45 };
  return s;
}
