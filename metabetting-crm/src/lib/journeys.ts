/* journeys.ts — a suggested journey per lifecycle segment. Starting points to
   adapt with the client, not final copy. Every journey is single-product and
   always runs with X1 + X5 excluded (and X4 on anything carrying an offer). */
import { SEGMENT_BY_ID } from './model';
import type { Snapshot } from './model';
import { isNum, readiness } from './calc';

export interface JourneyStep { when: string; channel: 'Email' | 'SMS' | 'Push' | 'On-site' | 'Wait / check'; purpose: string; content: string; offer?: boolean; }
export interface Journey {
  segment: string;
  name: string;
  goal: string;
  measure: string;
  trigger: string;
  exit: string;
  steps: JourneyStep[];
  notes: string[];
}

export const JOURNEYS: Journey[] = [
  {
    segment: 'S1', name: 'Finish your verification',
    goal: 'Get registered players through KYC so they are able to deposit.',
    measure: 'Verify rate: % of players entering the journey who verify within 7 days.',
    trigger: 'Player enters S1 (registered, not verified after {minDays} day).',
    exit: 'Leaves immediately when verified. Otherwise ends after the last step.',
    steps: [
      { when: 'Day 1', channel: 'Email', purpose: 'Remind and reassure', content: 'You’re nearly set up. What verification is, why it’s required by law, and a one-click link back to upload documents.' },
      { when: 'Day 3', channel: 'SMS', purpose: 'Nudge', content: 'Short: “Your Meta Betting account is waiting: finish verification in 2 minutes” + link. Only if SMS consent exists.' },
      { when: 'Day 5', channel: 'Email', purpose: 'Remove friction', content: 'Help-led: accepted documents, photo tips, common reasons uploads fail, and how to contact support.' },
      { when: 'Day 7', channel: 'Email', purpose: 'Last help', content: 'Offer live-chat help. No pressure, no offer. Then the journey ends.' },
    ],
    notes: ['This is a service message about the account, so it can go to all registered players (still excluding X1).', 'Find out from support what the most common KYC failure is and address it in step 3.'],
  },
  {
    segment: 'S2', name: 'Welcome and first deposit',
    goal: 'Turn verified players into first-time depositors.',
    measure: 'FTD rate: % of journey entrants who make a first deposit within 14 days.',
    trigger: 'Player verifies (verified event), with 0 deposits.',
    exit: 'Leaves on first deposit. Ends at day {maxDays}.',
    steps: [
      { when: 'Immediately', channel: 'Email', purpose: 'Welcome', content: 'You’re verified. What you can do now, matched to the product they signed up for (sportsbook OR casino), plus how deposit limits work.' },
      { when: 'Day 2', channel: 'Push', purpose: 'Timely hook', content: 'Sportsbook: a big fixture this week. Casino: a popular game. Only if push is on.' },
      { when: 'Day 4', channel: 'Email', purpose: 'Welcome offer reminder', content: 'Reminder of the welcome offer they are eligible for, with clear significant terms.', offer: true },
      { when: 'Day 8', channel: 'SMS', purpose: 'Last nudge', content: 'Short reminder with deposit link. Consent for that product’s SMS required.', offer: true },
      { when: 'Day 12', channel: 'Email', purpose: 'Soft close', content: 'No offer. What’s on this week in their product. Journey ends.' },
    ],
    notes: ['Needs a fast data sync: if Swifty only syncs daily, the “immediately” step lands a day late.', 'Offer steps skip anyone in X4.'],
  },
  {
    segment: 'S3', name: 'Second deposit (one and done)',
    goal: 'Get first-time depositors to deposit a second time. Usually the biggest value lever.',
    measure: 'Second-deposit rate: % of entrants making a 2nd deposit within 21 days.',
    trigger: 'Player has exactly 1 deposit and it was {minDays}+ days ago.',
    exit: 'Leaves on second deposit, or entry into X4 / X5. Ends after day 21.',
    steps: [
      { when: 'Day 0 (entry)', channel: 'Email', purpose: 'Product-matched content', content: 'Based on what they did with the first deposit: sportsbook → this weekend’s key fixtures and markets; casino → games like the one they played.' },
      { when: 'Day 3', channel: 'Push', purpose: 'Moment', content: 'A live, timely moment (match starting, new game released) in their product.' },
      { when: 'Day 7', channel: 'Email', purpose: 'Reason to return', content: 'Reload / free bet offer if the client approves one for this group, otherwise a feature they haven’t tried (cash out, bet builder, new slots).', offer: true },
      { when: 'Day 10', channel: 'Wait / check', purpose: 'Split', content: 'Opened or clicked but no deposit → step 5. No engagement → step 6.' },
      { when: 'Day 12', channel: 'SMS', purpose: 'Warm nudge', content: 'Short reminder of the offer or the upcoming big event. Product-specific SMS consent needed.', offer: true },
      { when: 'Day 18', channel: 'Email', purpose: 'Content, no offer', content: 'Useful content (tips, previews, new games). Journey ends; they fall into lapsed segments later if still inactive.' },
    ],
    notes: ['Must exclude X4: many abusers are “one and done” on purpose. This is why the abuser flag matters.', 'Never send a casino offer to a sportsbook-only player, or vice versa.'],
  },
  {
    segment: 'S4a', name: 'What’s on this weekend (sportsbook lapsed)',
    goal: 'Bring back sportsbook players who stopped betting recently.',
    measure: '% of entrants placing a bet within 14 days.',
    trigger: 'No bet for {minDays}–{maxDays} days.',
    exit: 'Leaves on any bet. Moves to S6 if still inactive.',
    steps: [
      { when: 'Thursday / Friday after entry', channel: 'Email', purpose: 'Weekend preview', content: 'This weekend’s biggest fixtures, preferred sport first if known.' },
      { when: 'Saturday midday', channel: 'Push', purpose: 'Live moment', content: 'Match about to start in their preferred sport / team.' },
      { when: 'Next week', channel: 'Email', purpose: 'Offer (optional)', content: 'Free bet or boosted odds if approved.', offer: true },
    ],
    notes: ['Time sends to the sporting calendar, not a fixed day count.'],
  },
  {
    segment: 'S4b', name: 'New games and favourites (casino lapsed)',
    goal: 'Bring back casino players who stopped playing recently.',
    measure: '% of entrants playing within 14 days.',
    trigger: 'No casino play for {minDays}–{maxDays} days.',
    exit: 'Leaves on any play. Moves to S6 if still inactive.',
    steps: [
      { when: 'Day 0', channel: 'Email', purpose: 'Favourites', content: 'Games they played most, plus similar ones.' },
      { when: 'Day 3', channel: 'Email', purpose: 'New releases', content: 'This week’s new games.' },
      { when: 'Day 6', channel: 'SMS', purpose: 'Offer (optional)', content: 'Free spins on a named game if approved. Casino SMS consent required.', offer: true },
    ],
    notes: ['Needs casino play data (last play date, games played) which may be missing today.'],
  },
  {
    segment: 'S5a', name: 'Weekly football fixtures',
    goal: 'Keep active football bettors engaged week to week.',
    measure: 'Bets per active player per week; open and click rates.',
    trigger: 'Recurring broadcast to S5a, every week.',
    exit: 'Drops out when they stop betting on football for {windowDays} days.',
    steps: [
      { when: 'Every Thursday / Friday', channel: 'Email', purpose: 'Fixtures', content: 'Weekend fixtures, featured markets, team news. Content-led.' },
      { when: 'Big midweek games', channel: 'Push', purpose: 'Moment', content: 'Kick-off reminders for big matches.' },
    ],
    notes: ['Content, not offers, by default: these players are already active.'],
  },
  {
    segment: 'S5b', name: 'Big races and festivals',
    goal: 'Keep active racing bettors engaged around the racing calendar.',
    measure: 'Bets per active player around key meetings.',
    trigger: 'Broadcasts around big meetings (Cheltenham, Grand National, Royal Ascot, etc.).',
    exit: 'Drops out when they stop betting on racing for {windowDays} days.',
    steps: [
      { when: 'Week before a festival', channel: 'Email', purpose: 'Preview', content: 'Festival guide, key races, tipster content.' },
      { when: 'Each festival morning', channel: 'Push', purpose: 'Day card', content: 'Today’s feature race and time.' },
    ],
    notes: ['Plan these on the sporting calendar a quarter ahead.'],
  },
  {
    segment: 'S5c', name: 'New casino releases',
    goal: 'Keep active casino players engaged with new content.',
    measure: 'Sessions per active player; new-game take-up.',
    trigger: 'Weekly broadcast to S5c.',
    exit: 'Drops out when they stop playing for {windowDays} days.',
    steps: [
      { when: 'Weekly', channel: 'Email', purpose: 'New releases', content: 'New games this week, jackpots, tournaments.' },
    ],
    notes: ['Watch frequency: active casino players can be over-mailed.'],
  },
  {
    segment: 'S6', name: 'Win-back then sunset',
    goal: 'Recover long-lapsed players, then stop mailing those who don’t respond (protects deliverability).',
    measure: '% reactivated; unsubscribes; email deliverability.',
    trigger: 'No activity for {minDays} days.',
    exit: 'Leaves on any bet, play or deposit. Otherwise sunset at {maxDays} days.',
    steps: [
      { when: 'Day 0', channel: 'Email', purpose: 'We’ve missed you', content: 'What’s new since they last played, in their product.' },
      { when: 'Day 10', channel: 'Email', purpose: 'Win-back offer', content: 'Single-product win-back offer if approved.', offer: true },
      { when: 'Day 20', channel: 'Email', purpose: 'Last chance / preferences', content: 'Ask if they still want to hear from us, with an easy preferences link.' },
      { when: 'After', channel: 'Wait / check', purpose: 'Sunset', content: 'No response → stop marketing email (suppress), keep service messages.' },
    ],
    notes: ['Sunsetting protects inbox placement for everyone else.'],
  },
  {
    segment: 'S7', name: 'High-value handover',
    goal: 'Look after the highest-value players properly, with affordability checks.',
    measure: 'Retention of high-value players; completed affordability checks.',
    trigger: 'Lifetime deposits reach {minValue}.',
    exit: 'Handed to the client’s VIP / account manager team.',
    steps: [
      { when: 'On entry', channel: 'Wait / check', purpose: 'Affordability first', content: 'Alert the client’s team to run affordability / safer gambling checks BEFORE any VIP treatment.' },
      { when: 'After checks pass', channel: 'Email', purpose: 'Personal welcome', content: 'Intro to their account manager. No automated offers.' },
    ],
    notes: ['Handled by people, not automation. Safer gambling rules apply most strongly here.'],
  },
];
export const JOURNEY_BY_SEG: Record<string, Journey> = Object.fromEntries(JOURNEYS.map((j) => [j.segment, j]));

/** Fill {threshold} placeholders with the snapshot's current values. */
export function fill(s: Snapshot, segId: string, text: string): string {
  const t = s.segments.find((x) => x.id === segId)?.thresholds || {};
  return text.replace(/\{(\w+)\}/g, (_, k) => {
    const v = t[k];
    if (!isNum(v)) return `[${k}]`;
    return k === 'minValue' ? `£${v.toLocaleString('en-GB')}` : String(v);
  });
}

export function journeyText(s: Snapshot, segId: string): string {
  const j = JOURNEY_BY_SEG[segId];
  const def = SEGMENT_BY_ID[segId];
  const r = readiness(s, def);
  const L = [
    `Journey: ${j.name} (segment ${def.id} ${def.name})`,
    `Product: ${def.product === 'both' ? 'single-product sends, matched to the player’s product' : def.product}`,
    `Goal: ${j.goal}`,
    `Measure: ${j.measure}`,
    `Trigger: ${fill(s, segId, j.trigger)}`,
    `Exit: ${fill(s, segId, j.exit)}`,
    'Always excluded: X1 self-excluded / GAMSTOP, X5 safer gambling hold. Offer steps also exclude X4 suspected abusers.',
    '',
    'Steps:',
    ...j.steps.map((st, i) => `  ${i + 1}. ${st.when} · ${st.channel}${st.offer ? ' · OFFER' : ''}: ${st.purpose}. ${st.content}`),
    '',
    'Notes:',
    ...j.notes.map((n) => `  - ${n}`),
    '',
    r.ready ? 'Readiness: Ready to build' : `Readiness: BLOCKED until we have: ${r.missing.map((m) => m.label).join('; ')}`,
  ];
  return L.join('\n');
}
