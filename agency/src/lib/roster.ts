/* roster.ts — the unified client roster.

   Agency HQ sits above two worlds: the reporting core (clients living in
   reporting.db — their report state arrives via snapshot.json) and the Client
   HQ brands that live only in the field (Aera House, Vivo, Mindway — not in the
   DB). This file is the one place that lists EVERY client and the things the
   core can't know yet: who leads it, its delivery cadence, and its strategy
   plan. Task derivation (agency.ts) combines this with live report data.

   Everything here is editable config — this is the layer a future "add client"
   flow would write to. The `live` block is deliberately explicit: it's the seam
   where real Client HQ health/approval data plugs in later. */

export type ClientKind = 'client-hq' | 'reporting';

export interface Cadence {
  /** How often a report is owed. 'none' = this client isn't on reporting. */
  report: 'monthly' | 'quarterly' | 'none';
  /** Articles owed per week (content cadence). 0 = none. */
  articlesPerWeek: number;
  /** Strategy plan should be reviewed every N months. */
  reviewMonths: number;
}

export interface StrategyState {
  /** ISO date the strategy plan was last set/reviewed, or null if none on file. */
  updated: string | null;
  /** One-line summary of the current strategic focus. */
  focus?: string;
}

export interface LiveState {
  siteHealth?: 'ok' | 'warn' | 'down';
  /** Client-facing plan/share links awaiting the client's sign-off. */
  pendingApprovals?: number;
  /** Articles planned for this week that aren't drafted yet. */
  contentDueThisWeek?: number;
  note?: string;
}

/** Where a client's Client HQ portal is in its lifecycle. */
export type PortalStatus = 'none' | 'planned' | 'building' | 'live';

export interface RosterClient {
  slug: string;
  name: string;
  kind: ClientKind;
  /** Who at DF leads the account. */
  owner: string;
  /** The client's own website (canonical URL). */
  website?: string;
  cadence: Cadence;
  strategy: StrategyState;
  /** Field state for brands the core can't see yet. */
  live?: LiveState;
  /** Link down into this client's own Client HQ portal, when it has one. */
  portalUrl?: string;
  /** Portal lifecycle — drives the Create-portal button's state. */
  portalStatus?: PortalStatus;
}

/* Today's roster. Reporting-core slugs (sportingtech, northwind-gaming,
   ym-predictions) match reporting.db so their live report state merges in.
   The Client HQ brands are added on top. */
export const ROSTER: RosterClient[] = [
  {
    slug: 'aera-house',
    name: 'Aera House',
    kind: 'client-hq',
    owner: 'Steve',
    cadence: { report: 'monthly', articlesPerWeek: 1, reviewMonths: 3 },
    strategy: { updated: '2026-08-14', focus: 'Local authority + interiors content, grow branded search' },
    live: { siteHealth: 'ok', pendingApprovals: 0, contentDueThisWeek: 1 },
    // Real Client HQ portal — deploys to /public_html/portal/ (see the-aera-house repo).
    portalUrl: 'https://theaerahouse.com/portal/',
  },
  {
    slug: 'vivo',
    name: 'Vivo',
    kind: 'client-hq',
    owner: 'Steve',
    cadence: { report: 'monthly', articlesPerWeek: 1, reviewMonths: 3 },
    strategy: { updated: '2026-07-30', focus: 'At-a-glance leads narrative; lift qualified enquiries' },
    live: { siteHealth: 'ok', pendingApprovals: 1, contentDueThisWeek: 0 },
    // No portal deployed yet (WP theme build) — leave unset so no dead button shows.
  },
  {
    slug: 'mindway',
    name: 'Mindway',
    kind: 'client-hq',
    owner: 'Steve',
    cadence: { report: 'monthly', articlesPerWeek: 2, reviewMonths: 3 },
    strategy: { updated: '2026-05-02', focus: 'Daily-trends story; consolidate top landing pages' },
    live: { siteHealth: 'warn', pendingApprovals: 0, contentDueThisWeek: 2, note: 'GA4 daily export 6 days stale' },
    // No portal deployed yet (WP theme build) — leave unset so no dead button shows.
  },
  {
    slug: 'sportingtech',
    name: 'Sportingtech',
    kind: 'reporting',
    owner: 'Steve',
    cadence: { report: 'monthly', articlesPerWeek: 0, reviewMonths: 6 },
    strategy: { updated: '2026-06-20', focus: 'Winning Edge messaging; B2B expansion keywords' },
  },
  {
    slug: 'northwind-gaming',
    name: 'Northwind Gaming',
    kind: 'reporting',
    owner: 'Steve',
    cadence: { report: 'monthly', articlesPerWeek: 0, reviewMonths: 6 },
    strategy: { updated: null, focus: undefined },
  },
  {
    slug: 'ym-predictions',
    name: 'YM Predictions',
    kind: 'reporting',
    owner: 'Steve',
    cadence: { report: 'monthly', articlesPerWeek: 0, reviewMonths: 6 },
    strategy: { updated: null, focus: undefined },
  },
];

export const rosterBySlug = (slug: string) => ROSTER.find((c) => c.slug === slug);
