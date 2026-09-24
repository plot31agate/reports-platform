/* time.ts — the Time room's data layer: types, the /agency/api/time bridge,
   and the pure maths (durations, money, weeks, roll-ups, CSV). Time is
   server-only — it lives in reporting.db, so there's no offline overlay; the
   room says so when the core isn't reachable. */

const API = `${import.meta.env.BASE_URL}api/time`;

export const INTERNAL = '__internal__';

export type Role = 'admin' | 'manager' | 'member';

export interface Me { role: Role; admin: boolean; label: string; member_id: number | null }
export interface Member {
  id: number; name: string; email: string | null; role: 'member' | 'manager';
  bill_rate: number | null; cost_rate?: number | null; capacity_hours: number;
  color: string | null; active: boolean; last_login_at: string | null; invite_url?: string | null;
}
export interface Category { id: number; name: string; billable: boolean; active: boolean; sort: number }
export interface TimeClient {
  slug: string; name: string; roster: boolean; removed_from_roster?: boolean;
  bill_rate: number | null; budget_hours: number | null; tracking: boolean; notes?: string | null;
}
export interface Entry {
  id: number; member_id: number; client_slug: string | null; category_id: number | null;
  date: string; minutes: number; description: string; billable: boolean;
  bill_rate: number | null; running: boolean; started_at: string | null;
  created_by: string | null; updated_at: string;
}
export interface TimeSettings { currency: string; round_minutes: string; week_hours_target: string; require_description: string }
export interface Boot {
  me: Me; settings: TimeSettings; members: Member[]; categories: Category[];
  clients: TimeClient[]; running: Entry[]; locks: string[]; server_now: string;
}

export class TimeApiError extends Error { status = 0; }

async function req<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch { /* ignore */ }
    const e = new TimeApiError(detail); e.status = res.status; throw e;
  }
  return (await res.json()) as T;
}

export interface EntryInput {
  member_id?: number; client_slug?: string; category_id?: number | null; date?: string;
  minutes?: number; description?: string; billable?: boolean; bill_rate?: number | null;
}

export const timeApi = {
  boot: () => req<Boot>('/bootstrap'),
  entries: (start: string, end: string) => req<{ entries: Entry[] }>(`/entries?start=${start}&end=${end}`).then((r) => r.entries),
  addEntry: (e: EntryInput) => req<{ entry: Entry }>('/entries', 'POST', e),
  updateEntry: (id: number, e: EntryInput) => req<{ entry: Entry }>(`/entries/${id}`, 'PATCH', e),
  deleteEntry: (id: number) => req<{ ok: boolean }>(`/entries/${id}`, 'DELETE'),
  start: (e: EntryInput & { resume_id?: number }) => req<{ entry: Entry; stopped: Entry | null }>('/timer/start', 'POST', e),
  stop: (member_id?: number) => req<{ entry: Entry }>('/timer/stop', 'POST', { member_id }),
  addMember: (m: Partial<Member>) => req<{ id: number }>('/members', 'POST', m),
  updateMember: (id: number, m: Partial<Member>) => req<{ ok: boolean }>(`/members/${id}`, 'PATCH', m),
  deleteMember: (id: number) => req<{ ok: boolean }>(`/members/${id}`, 'DELETE'),
  newInvite: (id: number) => req<{ invite_url: string }>(`/members/${id}/invite`, 'POST', {}),
  addClient: (c: { name: string; bill_rate?: number | null; budget_hours?: number | null; notes?: string }) =>
    req<{ slug: string }>('/clients', 'POST', c),
  updateClient: (slug: string, c: Partial<TimeClient>) => req<{ ok: boolean }>(`/clients/${slug}`, 'PATCH', c),
  deleteClient: (slug: string) => req<{ ok: boolean }>(`/clients/${slug}`, 'DELETE'),
  addCategory: (c: { name: string; billable: boolean }) => req<{ id: number }>('/categories', 'POST', c),
  updateCategory: (id: number, c: Partial<Category>) => req<{ ok: boolean }>(`/categories/${id}`, 'PATCH', c),
  deleteCategory: (id: number) => req<{ ok: boolean }>(`/categories/${id}`, 'DELETE'),
  lock: (week_start: string) => req<{ ok: boolean }>('/locks', 'POST', { week_start }),
  unlock: (week_start: string) => req<{ ok: boolean }>(`/locks/${week_start}`, 'DELETE'),
  saveSettings: (s: Partial<TimeSettings>) => req<{ settings: TimeSettings }>('/settings', 'PATCH', s),
  logout: () => req<{ ok: boolean }>('/logout', 'POST', {}),
};

/* ---- durations ---- */

/** Accepts 1:30, 1.5, 1.5h, 90m, 1h30, 1h 30m. A bare number is hours. */
export function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d+):(\d{1,2})$/))) return +m[1] * 60 + +m[2];
  if ((m = s.match(/^(\d+(?:\.\d+)?)m(?:in|ins)?$/))) return Math.round(+m[1]);
  if ((m = s.match(/^(\d+(?:\.\d+)?)h(?:rs?|ours?)?(?:(\d+)m?(?:in|ins)?)?$/))) return Math.round(+m[1] * 60 + (m[2] ? +m[2] : 0));
  if ((m = s.match(/^(\d*(?:\.\d+)?)$/)) && m[1]) return Math.round(+m[1] * 60);
  return null;
}

/** 90 → "1:30" */
export const hm = (min: number) => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`;
/** 90 → "1.50" — decimal hours, what invoices and spreadsheets want. */
export const dec = (min: number) => (min / 60).toFixed(2);

export function liveMinutes(e: Entry, now: number): number {
  if (!e.running || !e.started_at) return e.minutes;
  const start = Date.parse(e.started_at);
  return e.minutes + Math.max(0, Math.floor((now - start) / 60000));
}
export function liveClock(e: Entry, now: number): string {
  const secs = e.minutes * 60 + (e.running && e.started_at ? Math.max(0, Math.floor((now - Date.parse(e.started_at)) / 1000)) : 0);
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/* ---- money ---- */
export function money(n: number, currency: string, pennies = false): string {
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency', currency: currency || 'GBP',
      minimumFractionDigits: pennies ? 2 : 0, maximumFractionDigits: pennies ? 2 : 0,
    }).format(n);
  } catch { return `${currency} ${n.toFixed(pennies ? 2 : 0)}`; }
}
export const entryValue = (e: Entry) => (e.billable && e.bill_rate ? (e.minutes / 60) * e.bill_rate : 0);

/* ---- dates (local calendar days, ISO strings) ---- */
export const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const today = () => iso(new Date());
export const parseIso = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s: string, n: number) => { const d = parseIso(s); d.setDate(d.getDate() + n); return iso(d); };
export const mondayOf = (s: string) => { const d = parseIso(s); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return iso(d); };
export const weekDays = (monday: string) => Array.from({ length: 7 }, (_, i) => addDays(monday, i));
export const dayLabel = (s: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  parseIso(s).toLocaleDateString('en-GB', opts);

export type RangeKey = 'this-week' | 'last-week' | 'this-month' | 'last-month' | 'this-quarter' | 'this-year' | 'custom';
export const RANGE_LABEL: Record<RangeKey, string> = {
  'this-week': 'This week', 'last-week': 'Last week', 'this-month': 'This month',
  'last-month': 'Last month', 'this-quarter': 'This quarter', 'this-year': 'This year', custom: 'Custom',
};
export function rangeFor(k: RangeKey, ref = new Date()): [string, string] {
  const t = iso(ref);
  const y = ref.getFullYear(), m = ref.getMonth();
  switch (k) {
    case 'this-week': { const mo = mondayOf(t); return [mo, addDays(mo, 6)]; }
    case 'last-week': { const mo = addDays(mondayOf(t), -7); return [mo, addDays(mo, 6)]; }
    case 'this-month': return [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))];
    case 'last-month': return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
    case 'this-quarter': { const q = Math.floor(m / 3) * 3; return [iso(new Date(y, q, 1)), iso(new Date(y, q + 3, 0))]; }
    case 'this-year': return [iso(new Date(y, 0, 1)), iso(new Date(y, 11, 31))];
    default: return [t, t];
  }
}
/** Whole weeks (for utilisation capacity) — counted as days/7. */
export const spanWeeks = (start: string, end: string) =>
  Math.max(1, (parseIso(end).getTime() - parseIso(start).getTime()) / 86400000 + 1) / 7;

/* ---- roll-ups ---- */
export interface Roll { key: string; label: string; minutes: number; billable: number; value: number; cost: number; count: number }
export function rollUp(entries: Entry[], keyOf: (e: Entry) => string, labelOf: (k: string) => string, costOf?: (e: Entry) => number): Roll[] {
  const map = new Map<string, Roll>();
  for (const e of entries) {
    const k = keyOf(e);
    const r = map.get(k) ?? { key: k, label: labelOf(k), minutes: 0, billable: 0, value: 0, cost: 0, count: 0 };
    r.minutes += e.minutes;
    if (e.billable) r.billable += e.minutes;
    r.value += entryValue(e);
    r.cost += costOf ? costOf(e) : 0;
    r.count += 1;
    map.set(k, r);
  }
  return [...map.values()].sort((a, b) => b.minutes - a.minutes);
}

/* ---- CSV ---- */
const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}
export function download(filename: string, text: string, type = 'text/csv;charset=utf-8') {
  // BOM so Excel opens £ and accents correctly.
  const blob = new Blob(['﻿', text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const MEMBER_COLORS = ['#3d63b8', '#1e7e4e', '#b45309', '#c53a55', '#7c3aed', '#0e7490', '#be185d', '#4d7c0f'];
