/* checklist.ts — the "do this first, then this" path through the tool.
   Steps with `auto` tick themselves from the snapshot; the rest are ticked by
   hand (stored in snapshot.checklist so they travel with the JSON). */
import { AUDIT_ITEMS } from './model';
import type { Snapshot } from './model';
import { isNum } from './calc';

export interface CheckStep {
  id: string;
  title: string;
  detail: string;
  /** Room to jump to. */
  go: string;
  /** Returns [done, progress label] when the tool can tell by itself. */
  auto?: (s: Snapshot) => [boolean, string];
  optional?: boolean;
}
export interface CheckStage { key: string; title: string; when: string; why: string; steps: CheckStep[]; }

const auditDone = (s: Snapshot, group: 'profile' | 'event' | 'setup'): [boolean, string] => {
  const items = AUDIT_ITEMS.filter((i) => i.group === group);
  const done = items.filter((i) => s.audit[i.id]?.status).length;
  return [done === items.length, `${done}/${items.length} checked`];
};
const statusAtLeast = (s: Snapshot, ids: string[], ok: string[]): [boolean, string] => {
  const n = ids.filter((id) => ok.includes(s.segments.find((g) => g.id === id)?.status || '')).length;
  return [n === ids.length, `${n}/${ids.length}`];
};

export const STAGES: CheckStage[] = [
  {
    key: 'prep', title: '1. Get ready', when: 'Before the session',
    why: 'Know what the tool does and have access to what you need.',
    steps: [
      { id: 'demo', title: 'Try it with example data', detail: 'Press “Load example data (dummy)” in the top bar, click through each page, then press Reset. Takes 10 minutes and shows what you’re aiming for.', go: 'start' },
      { id: 'access', title: 'Get Customer.io access', detail: 'A login to Meta Betting’s Customer.io workspace (read-only is enough). Or book time with someone on the client side who can share their screen.', go: 'start' },
      { id: 'date', title: 'Set the snapshot date', detail: 'The date box in the top bar. Use the date you’re looking at the data, so later snapshots compare cleanly.', go: 'audit', auto: (s) => [!!s.meta.snapshotDate && !s.meta.isExample, s.meta.isExample ? 'example data loaded: reset first' : s.meta.snapshotDate] },
    ],
  },
  {
    key: 'capture', title: '2. Capture what’s there', when: 'In Customer.io, ~1–2 hours',
    why: 'Everything else in the tool is worked out from this. Accurate here = right plan later.',
    steps: [
      { id: 'a_profile', title: 'Audit the profile attributes', detail: 'Present / Partial / Missing for each, plus the Customer.io name.', go: 'audit', auto: (s) => auditDone(s, 'profile') },
      { id: 'a_events', title: 'Audit the events', detail: 'Check the activity log for each event and whether it carries the detail we need (sport, odds, game).', go: 'audit', auto: (s) => auditDone(s, 'event') },
      { id: 'a_setup', title: 'Do the set-up checks', detail: 'Sending domain, SMS, push, existing campaigns, data sync speed.', go: 'audit', auto: (s) => auditDone(s, 'setup') },
      { id: 'names', title: 'Record Customer.io field names', detail: 'For everything Present or Partial, type the exact name. These go into the build specs.', go: 'audit', auto: (s) => {
        const need = AUDIT_ITEMS.filter((i) => i.group !== 'setup' && (s.audit[i.id]?.status === 'present' || s.audit[i.id]?.status === 'partial'));
        const has = need.filter((i) => s.audit[i.id].cioName.trim()).length;
        return [need.length > 0 && has === need.length, need.length ? `${has}/${need.length} named` : 'audit first'];
      } },
      { id: 'funnel', title: 'Enter the funnel counts', detail: 'At least Total: registered, verified, first deposit, 2+ deposits. Add active 7/30 days and product splits if you can.', go: 'inputs', auto: (s) => {
        const f = s.funnel.total; const keys = ['registered', 'verified', 'ftd', 'dep2'] as const;
        const n = keys.filter((k) => isNum(f[k])).length; return [n === keys.length, `${n}/4 core counts`];
      } },
      { id: 'excl', title: 'Enter exclusions and opt-ins', detail: 'Self-excluded count, suspected abusers (and where that figure came from), and opt-ins per product and channel.', go: 'inputs', auto: (s) => {
        const n = [s.exclusions.selfExcluded, s.exclusions.abusers, s.consent.betting_email, s.consent.casino_email].filter(isNum).length;
        return [n === 4, `${n}/4 key figures`];
      } },
      { id: 'money', title: 'Ask the client for the money inputs', detail: 'Average deposit and monthly NGR per active player. Optional, but needed for a revenue range.', go: 'inputs', optional: true, auto: (s) => [isNum(s.money.avgDeposit) && isNum(s.money.ngrPerActive), isNum(s.money.ngrPerActive) ? 'NGR entered' : 'not yet'] },
    ],
  },
  {
    key: 'analyse', title: '3. Make sense of it', when: 'After capture, ~30 minutes',
    why: 'Turn numbers into a story and a priority list.',
    steps: [
      { id: 'read_overview', title: 'Read the Overview', detail: 'Note the biggest drop-off and how the genuine-players funnel differs. This is the headline for the client.', go: 'overview' },
      { id: 'abuser_check', title: 'Question the abuser figure', detail: 'If it’s an estimate, agree with the client how it will be confirmed. Everything “genuine” depends on it.', go: 'overview', auto: (s) => [s.exclusions.abuserSource === 'system' && isNum(s.exclusions.abusers), s.exclusions.abuserSource === 'system' ? 'system-backed' : 'estimate: tick when agreed'] },
      { id: 'abuse_rules', title: 'Agree the abuse rules', detail: 'Go through the signals with the client; mark which data exists.', go: 'abuse' },
      { id: 'seg_review', title: 'Review segment priorities', detail: 'Check the order suits the client, adjust day windows, add real sizes where you have them.', go: 'segments' },
      { id: 'targets', title: 'Agree uplift and targets', detail: 'Set believable uplifts and fill at least three KPI targets with the client.', go: 'opportunity', auto: (s) => { const n = Object.values(s.targets).filter(isNum).length; return [n >= 3, `${n} targets set`]; } },
    ],
  },
  {
    key: 'share', title: '4. Share and save', when: 'End of the session',
    why: 'Leave the client with a clear page and give Swifty their to-do list.',
    steps: [
      { id: 'export', title: 'Export the JSON snapshot', detail: 'Top bar → Export JSON. Save it in the client folder. Next month you’ll compare against it.', go: 'summary', auto: (s) => [!!s.meta.lastExported, s.meta.lastExported ? `exported ${s.meta.lastExported}` : 'not yet'] },
      { id: 'swifty', title: 'Send the Swifty data requests', detail: 'Data audit → Copy as text → email to Swifty Global (via the client).', go: 'audit' },
      { id: 'summary', title: 'Share the client summary', detail: 'Print to PDF or copy Markdown. Walk the client through drop-off, audience, top 5 segments and the roadmap.', go: 'summary' },
    ],
  },
  {
    key: 'build', title: '5. Build in Customer.io', when: 'Weeks 1–6, following the roadmap',
    why: 'This is the actual CRM work. Update statuses as you go so the roadmap stays true.',
    steps: [
      { id: 'b_excl', title: 'Build exclusion segments X1–X5', detail: 'Copy each spec from Segments. Set status to Live when done. Nothing else goes out until these exist.', go: 'segments', auto: (s) => statusAtLeast(s, ['X1', 'X2', 'X3', 'X4', 'X5'], ['live']) },
      { id: 'b_p1', title: 'Launch S1 and S2 journeys', detail: 'Verification reminders and the first-deposit welcome. Copy the journey briefs from Suggested journeys.', go: 'journeys', auto: (s) => statusAtLeast(s, ['S1', 'S2'], ['live']) },
      { id: 'b_p2', title: 'Launch S3, S4a, S4b', detail: 'Second deposit and recently lapsed journeys.', go: 'journeys', auto: (s) => statusAtLeast(s, ['S3', 'S4a', 'S4b'], ['live']) },
      { id: 'b_p3', title: 'Start content broadcasts S5a–c', detail: 'Weekly football, racing calendar, casino new releases.', go: 'journeys', auto: (s) => statusAtLeast(s, ['S5a', 'S5b', 'S5c'], ['live']) },
      { id: 'b_next', title: 'Next month: new snapshot and compare', detail: 'Re-enter the counts, then Client summary → Compare with earlier snapshot.', go: 'summary' },
    ],
  },
];

export function stepDone(s: Snapshot, st: CheckStep): { done: boolean; note?: string; manual: boolean } {
  // A manual tick always wins (e.g. "abuser figure agreed" while still an estimate).
  if (s.checklist[st.id]) return { done: true, manual: true, note: st.auto ? st.auto(s)[1] : undefined };
  if (st.auto) { const [d, note] = st.auto(s); return { done: d, note, manual: false }; }
  return { done: false, manual: true };
}

export function progress(s: Snapshot) {
  const all = STAGES.flatMap((g) => g.steps).filter((x) => !x.optional);
  const done = all.filter((x) => stepDone(s, x).done).length;
  const next = STAGES.flatMap((g) => g.steps).find((x) => !x.optional && !stepDone(s, x).done) || null;
  return { done, total: all.length, next };
}
