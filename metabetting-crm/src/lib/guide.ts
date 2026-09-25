/* guide.ts — the plain-English "how this page works" notes for every room,
   plus the glossary. Written for whoever sits in the meeting, not for devs. */

export interface PageGuide {
  /** One line: what this page is. */
  what: string;
  /** Why it matters to Meta Betting (the business reason). */
  why: string;
  /** What to do, in order. */
  how: string[];
  /** What you get out, and what to do with it. */
  output: string;
  /** Watch-outs. */
  tips?: string[];
}

export const PAGE_GUIDES: Record<string, PageGuide> = {
  audit: {
    what: 'A checklist of every piece of player data a good CRM programme needs, and whether Meta Betting’s Customer.io actually has it.',
    why: 'Every segment and journey is built from these fields. If the data isn’t there, the journey can’t be built, so this page decides what we can do now and what has to wait for Swifty Global (the platform provider that feeds Customer.io).',
    how: [
      'Open Customer.io → People → pick any real player profile. Look at the attributes list on the right.',
      'For each row here, mark Present (it’s there and filled in), Partial (it exists but is patchy, e.g. has a status but no date) or Missing.',
      'Type the exact name Customer.io uses into “Customer.io name” (e.g. deposit_count). This gets copied into the build specs, so spelling matters.',
      'Then open Activity Logs / Events and do the same for the events list.',
      'Finish with the set-up checks (Settings → Sending domains, SMS, Push; Campaigns list; ask how often Swifty syncs data).',
    ],
    output: 'The “Data requests for Swifty Global” box at the bottom builds itself from everything marked Missing or Partial. Press Copy as text and paste it into an email to Swifty.',
    tips: [
      'If you are unsure, mark Partial and add a note. Partial still counts as not ready, which is the safe default.',
      'Nothing here touches Customer.io. You are only recording what you see.',
    ],
  },
  inputs: {
    what: 'The headline player counts: how many people are at each stage from sign-up to regular depositor.',
    why: 'These numbers show where players are dropping out. That tells us which journey to build first and gives a starting point to measure every future month against.',
    how: [
      'In Customer.io, build a quick segment for each stage (or ask the client for the numbers) and type in the count. Total is the must-have; sportsbook and casino splits are a bonus.',
      'Exclusions: the number of self-excluded / GAMSTOP players, and the number of suspected bonus abusers. Say where the abuser figure came from: a system flag, a rule, or someone’s estimate.',
      'Marketing opt-ins: how many players have said yes to betting emails, betting SMS, casino emails, casino SMS and push. These are separate by law.',
      'Money (optional, ask the client): average deposit and average monthly revenue (NGR) per active player. Only used for the revenue range.',
    ],
    output: 'Nothing to copy here. Everything on Overview, Segments, Opportunity and the Summary is worked out from these numbers.',
    tips: [
      'Leave anything blank you don’t have. Blanks show as “—” and never break a calculation.',
      'Type plain numbers; commas are fine (30,000).',
    ],
  },
  overview: {
    what: 'The numbers from Funnel inputs turned into a picture: conversion rates, the biggest leak, and who we are legally allowed to market to.',
    why: 'This is the “here’s what we found” moment for the client. The biggest drop-off is where CRM can make the most difference fastest.',
    how: [
      'Read the four headline tiles, then the red Biggest drop-off box. That’s the lead story.',
      'Compare the two funnels. “Genuine players” removes suspected bonus abusers, which often changes the story (e.g. a poor second-deposit rate looks much healthier once abusers are removed).',
      'Check the Marketable audience table: this is how many people we can actually send to, per product and channel.',
      'Switch between Total / Sportsbook / Casino to see if one product leaks more than the other.',
    ],
    output: 'The drop-off sentence and the marketable audience go straight into the client summary.',
    tips: [
      'If the abuser figure is an estimate, a yellow warning shows. Treat the genuine funnel as indicative until the figure is confirmed.',
      'Offer sends exclude suspected abusers; service and content sends don’t. Self-excluded players are removed from everything.',
    ],
  },
  segments: {
    what: 'The list of player groups (segments) to build in Customer.io, in priority order, with whether we have the data to build each one.',
    why: 'Segments are who a journey is sent to. Exclusion segments (X) keep us compliant and stop offers going to abusers, so they come first. Lifecycle segments (S) are where the revenue comes from.',
    how: [
      'Build every X segment first. They are filters applied to every campaign.',
      'Work down the S list. Green “Ready” means every field it needs is Present in the Data audit. Red “Blocked” lists exactly what’s missing.',
      'Click “Details & spec” to adjust the day windows (e.g. lapsed = 14–30 days), enter a real size from Customer.io, and copy the build spec.',
      'Give the spec to whoever builds in Customer.io. It uses the field names you typed in the audit.',
      'Use ▲▼ to change the order if the client’s priorities differ, and update the Status as you build.',
    ],
    output: 'A copyable Customer.io build spec per segment, and a status you can track (Not started / Building / Live).',
    tips: [
      'Sizes marked “calculated” are rough (they ignore the day windows). Replace them with real counts when you can.',
      'Each S segment has a matching journey on the Suggested journeys page.',
    ],
  },
  journeys: {
    what: 'A ready-to-build journey (the series of messages) for each lifecycle segment: trigger, timing, channel, what each message says, and when someone leaves.',
    why: 'A segment on its own does nothing. The journey is the actual CRM work the client will see and that moves the numbers.',
    how: [
      'Pick a segment on the left. Start with the ones marked Ready and top priority (usually S1, S2, S3).',
      'Read the goal and the exit rule first: that’s how we will measure it.',
      'Check the steps, then adjust timings and wording for Meta Betting’s brand and offers.',
      'Press Copy journey and paste it into the brief for the copywriter / Customer.io builder.',
    ],
    output: 'A plain-text journey brief per segment.',
    tips: [
      'Every journey is single-product: never mix betting and casino in one message.',
      'Every journey runs with X1 (self-excluded) and X5 (safer gambling hold) excluded. Offers also exclude X4 (abusers).',
      'Offers shown are placeholders: use only what the client’s promotions team approves.',
    ],
  },
  abuse: {
    what: 'A worksheet to agree how we spot likely bonus abusers, so they stop getting offers.',
    why: 'The client thinks a big share of players are bonus abusers. If true, every offer to them is wasted money, and they distort every conversion rate. We need a fair, data-based flag, not a guess.',
    how: [
      'Go through each signal with the client. Keep the ones they agree are fair; switch off any they don’t.',
      'Set the weight: how strongly each signal suggests abuse (higher = stronger).',
      'Mark “Data available?” Yes only if we can actually see that data today. Anything marked No is added to the Swifty requests.',
      'Adjust the medium / high bands if needed.',
    ],
    output: 'A suggested abuse_risk rule (low / medium / high) to copy to Swifty or build as a Customer.io segment. High = in segment X4 (no offers).',
    tips: [
      'The client’s risk team makes the final call on abuse. Our flag only controls who gets offers; flagged players still get service and safer gambling messages.',
    ],
  },
  opportunity: {
    what: 'A “what if” calculator: what small improvements in conversion could be worth.',
    why: 'It turns the plan into a number the client cares about, and sets targets we can report against each month.',
    how: [
      'Move the sliders to small, believable improvements (a few percentage points). Agree them with the client rather than picking big numbers.',
      'Read the extra players at each stage. Each stage feeds the next, so gains compound.',
      'If the money inputs are filled, a low / mid / high monthly revenue range appears.',
      'Fill in the Target column with the client: these become the KPIs in the monthly report.',
    ],
    output: 'Extra players and a revenue range for the summary, plus agreed KPI targets.',
    tips: [
      'Always “estimate for discussion, not a forecast”. It uses genuine players only, so it won’t count abusers as upside.',
      'Percentage points, not percent: 70% → 73% is +3 points.',
    ],
  },
  roadmap: {
    what: 'The build order, generated automatically from what’s ready and what’s a priority.',
    why: 'It shows the client a clear week-by-week plan and makes it obvious that some work is waiting on their data provider, not on us.',
    how: [
      'Nothing to fill in. It updates whenever the audit, priorities or statuses change.',
      'Phase 0 is the data fixes. Anything blocked drops into “After data fix” with the missing fields named.',
      'Update statuses on the Segments page as work progresses; they show here.',
    ],
    output: 'A phase plan for the summary and for the client meeting.',
  },
  summary: {
    what: 'One page with everything the client needs to see, ready to print or paste.',
    why: 'This is the document we leave with the client after each meeting and the baseline for next month.',
    how: [
      'Check the headline numbers look right. If not, fix the inputs.',
      'Print / save as PDF for a one-page handout, or Copy Markdown to paste into an email or doc.',
      'Next month: press “Compare with earlier snapshot…” and pick last month’s exported JSON to show what changed.',
    ],
    output: 'A one-page PDF and a Markdown version.',
    tips: ['Always Export JSON (top bar) after a meeting so there’s something to compare against next time.'],
  },
};

export const GLOSSARY: { term: string; means: string }[] = [
  { term: 'CRM', means: 'Customer relationship marketing: the emails, SMS and push messages sent to existing players based on what they do (or don’t do).' },
  { term: 'Customer.io', means: 'The tool Meta Betting already uses to send those messages. It holds a profile per player.' },
  { term: 'Swifty Global', means: 'Meta Betting’s platform provider. Their system sends player data into Customer.io, so missing data has to be requested from them.' },
  { term: 'Attribute', means: 'A fact stored on a player profile, e.g. deposit_count = 3.' },
  { term: 'Event', means: 'Something a player did, with a time stamp, e.g. deposit at 14:02. Journeys are often triggered by events.' },
  { term: 'Segment', means: 'A group of players matching a rule, e.g. “one deposit, more than 7 days ago”. Updates automatically.' },
  { term: 'Journey (workflow)', means: 'A series of messages sent to a segment over time, with rules for when people leave it.' },
  { term: 'KYC / verification', means: 'Identity checks a player must pass before they can deposit.' },
  { term: 'FTD', means: 'First-time deposit: the first time a player puts money in.' },
  { term: 'One and done', means: 'Players who deposited once and never again. Usually the biggest value opportunity.' },
  { term: 'Lapsed', means: 'Players who used to be active but haven’t bet or played for a while.' },
  { term: 'NGR', means: 'Net gaming revenue: what the operator keeps after winnings and bonuses.' },
  { term: 'Bonus abuser', means: 'Someone who signs up mainly to take the welcome offer or free bets, with no intention of playing normally.' },
  { term: 'Genuine players', means: 'All players minus suspected bonus abusers. The fair base for measuring CRM.' },
  { term: 'Marketable audience', means: 'Players we are legally allowed to message: opted in for that product and channel, not self-excluded (and not an abuser, for offers).' },
  { term: 'GAMSTOP / self-exclusion', means: 'A player has asked to be blocked from gambling. They must never receive marketing.' },
  { term: 'Consent (UKGC)', means: 'UK rules require separate opt-ins per product (betting / casino) and per channel (email / SMS / phone). Consent for one doesn’t cover another.' },
  { term: 'Ready / Blocked', means: 'Ready = every field a segment needs is Present in the audit. Blocked = something is missing or partial.' },
  { term: 'Percentage points', means: 'The difference between two percentages: 70% to 73% is +3 points.' },
];
