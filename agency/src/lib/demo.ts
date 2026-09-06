/* demo.ts — scale preview only. With ?demo=N in the URL we pad the roster up to
   N synthetic clients so the triage UX can be judged at 25+. These run through
   the REAL engine (deriveClient) with fabricated inputs, so their tasks and
   statuses behave exactly like live ones — nothing here touches real data or
   ships in normal use. */
import { deriveClient } from './agency';
import type { ClientState } from './agency';
import type { RosterClient } from './roster';

const NAMES = [
  'Harbour Dental', 'Peak Fitness', 'Verde Landscapes', 'Copper & Oak', 'Nimbus Software',
  'Tidewater Legal', 'Bright Lane Nursery', 'Ferro Cycles', 'Aurora Skincare', 'Maple & Main',
  'Kestrel Security', 'Onyx Interiors', 'Saffron Kitchens', 'North Pier Hotel', 'Lumen Optics',
  'Granite Roofing', 'Willow Vet', 'Cobalt Recruitment', 'Meridian Travel', 'Sable Menswear',
  'Fathom Diving', 'Cedar Accountants', 'Vertex Climbing', 'Halcyon Spa', 'Ridgeline Estates',
  'Amber Bakery', 'Slate Architects', 'Drift Surf Co', 'Quill Publishing', 'Bramble Florist',
];
const OWNERS = ['Steve', 'Priya', 'Tom', 'Léa'];

/* Deterministic tiny PRNG so the demo roster is stable across renders. */
function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

export function demoStates(n: number, today: Date): ClientState[] {
  const rand = rng(42);
  const out: ClientState[] = [];
  for (let i = 0; i < Math.min(n, NAMES.length); i++) {
    const r = rand();
    const kind: RosterClient['kind'] = r < 0.4 ? 'client-hq' : 'reporting';
    // spread of health: ~15% missing strategy (blocked), ~35% needs input, rest ok
    const missingStrategy = rand() < 0.15;
    const monthsAgo = Math.floor(rand() * 8);
    const strategyDate = missingStrategy ? null : isoMonthsAgo(today, monthsAgo);
    const behindReport = rand() < 0.4;
    const pending = rand() < 0.25 ? 1 : 0;
    const contentDue = kind === 'client-hq' && rand() < 0.5 ? 1 : 0;
    const health = rand() < 0.1 ? 'warn' : 'ok';

    const client: RosterClient = {
      slug: `demo-${i}`,
      name: NAMES[i],
      kind,
      owner: OWNERS[Math.floor(rand() * OWNERS.length)],
      cadence: { report: 'monthly', articlesPerWeek: kind === 'client-hq' ? 1 : 0, reviewMonths: kind === 'client-hq' ? 3 : 6 },
      strategy: { updated: strategyDate, focus: missingStrategy ? undefined : 'Growth programme — search + content' },
      live: { siteHealth: health, pendingApprovals: pending, contentDueThisWeek: contentDue },
      portalUrl: kind === 'client-hq' ? '#' : undefined,
    };

    // A synthetic snapshot: a report either up to date or a couple of months behind.
    const snap = {
      slug: client.slug, display_name: client.name, source: 'demo', created_at: '', tagline: '',
      reports: behindReport ? [{ period: periodMonthsAgo(today, 2), status: 'published', updated_at: '' }] : [{ period: periodMonthsAgo(today, 1), status: 'published', updated_at: '' }],
      latest_report: null as null | { period: string; status: string; updated_at: string },
      connections: [] as { provider: string; status: string; detail: string | null; last_synced_at: string | null }[],
    };
    snap.latest_report = snap.reports[0];
    out.push(deriveClient(client, snap, today));
  }
  return out;
}

function isoMonthsAgo(today: Date, m: number): string {
  const d = new Date(today.getFullYear(), today.getMonth() - m, Math.min(14, today.getDate()));
  return d.toISOString().slice(0, 10);
}
function periodMonthsAgo(today: Date, m: number): string {
  const d = new Date(today.getFullYear(), today.getMonth() - m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
