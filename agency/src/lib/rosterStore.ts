/* rosterStore.ts — the write layer over the config roster.

   ROSTER (roster.ts) is the shipped baseline. Agency HQ is the hub now, so it
   needs to add clients and edit plans without a backend. This keeps a small
   localStorage overlay — per-client field edits + UI-added clients — and merges
   it over the config to produce the EFFECTIVE roster every view derives from.

   Deliberately the same seam roster.ts describes: a future "add client" flow
   swaps this localStorage overlay for a write to reporting.db / roster config
   and nothing above changes. Edits are shallow patches, so a patched sub-object
   (strategy, cadence, live) must be passed whole. */
import { ROSTER } from './roster';
import type { RosterClient } from './roster';

const KEY = 'agency.roster.v1';

interface Overlay {
  /** Per-slug field patches applied over the config client. */
  edits: Record<string, Partial<RosterClient>>;
  /** Clients created in the UI (not in config). */
  added: RosterClient[];
}

function read(): Overlay {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const o = JSON.parse(raw) as Partial<Overlay>;
      return { edits: o.edits ?? {}, added: o.added ?? [] };
    }
  } catch { /* ignore */ }
  return { edits: {}, added: [] };
}
function write(o: Overlay) {
  try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* ignore */ }
}

/** Config roster + overlay = what the whole app runs on. */
export function effectiveRoster(): RosterClient[] {
  const o = read();
  const base = ROSTER.map((c) => (o.edits[c.slug] ? { ...c, ...o.edits[c.slug] } : c));
  return [...base, ...o.added];
}

/** True for clients created in the UI (removable); config clients are not. */
export function isAdded(slug: string): boolean {
  return read().added.some((c) => c.slug === slug);
}

/** Shallow-merge a patch onto a client (added client mutated in place, else an edit). */
export function patchClient(slug: string, patch: Partial<RosterClient>) {
  const o = read();
  const a = o.added.find((c) => c.slug === slug);
  if (a) Object.assign(a, patch);
  else o.edits[slug] = { ...o.edits[slug], ...patch };
  write(o);
}

export function addClient(c: RosterClient) {
  const o = read();
  o.added.push(c);
  write(o);
}

/** Only UI-added clients can be removed (config clients live in roster.ts). */
export function removeAdded(slug: string) {
  const o = read();
  o.added = o.added.filter((c) => c.slug !== slug);
  delete o.edits[slug];
  write(o);
}

/** How many config clients have local edits + how many were added — for the reset affordance. */
export function overlayStats(): { edited: number; added: number } {
  const o = read();
  return { edited: Object.keys(o.edits).length, added: o.added.length };
}

/** Wipe every local change back to the shipped config roster. */
export function resetOverlay() {
  write({ edits: {}, added: [] });
}

export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'client';
}

/** A slug not already used by config or overlay (adds -2, -3… on collision). */
export function uniqueSlug(name: string): string {
  const taken = new Set(effectiveRoster().map((c) => c.slug));
  const base = slugify(name);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
