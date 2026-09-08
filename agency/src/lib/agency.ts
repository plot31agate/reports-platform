/* agency.ts — the "what's due" brain.

   It merges the reporting-core snapshot (real report + connection state, from
   reporting.db via snapshot.json) with the roster config (cadence, strategy,
   live field state) and DERIVES the task list and status roll-up. Almost
   nothing here is a hand-kept to-do: tasks fall out of state you already track.
   Swap the snapshot source for a live endpoint and the same logic runs. */
import { ROSTER } from './roster';
import type { RosterClient } from './roster';

/* ---------- snapshot shape (matches scripts/agency_snapshot.py) ---------- */
export interface SnapReport { period: string; status: string; updated_at: string; }
export interface SnapConnection { provider: string; status: string; detail: string | null; last_synced_at: string | null; }
export interface SnapClient {
  slug: string; display_name: string; source: string; created_at: string;
  tagline: string; reports: SnapReport[]; latest_report: SnapReport | null;
  connections: SnapConnection[];
}
export interface Snapshot { generated_at: string; source: string; clients: SnapClient[]; }

/* ---------- derived model ---------- */
export type Severity = 'ok' | 'attention' | 'blocked' | 'idle';
export type TaskKind = 'report' | 'article' | 'approval' | 'health' | 'connection' | 'strategy';

export interface Task {
  id: string;
  clientSlug: string;
  clientName: string;
  kind: TaskKind;
  label: string;
  due: string;                 // ISO date (yyyy-mm-dd)
  severity: Exclude<Severity, 'idle'>;
  overdueDays: number;         // >0 = past due
  source: 'core' | 'cadence' | 'live';
}

export interface ClientState {
  client: RosterClient;
  snap: SnapClient | null;
  tasks: Task[];
  status: Severity;            // worst of the tasks
  health: 'ok' | 'warn' | 'down' | 'unknown';
  latestReport: SnapReport | null;
  nextReportPeriod: string;    // the period currently owed
  strategyLabel: string;       // 'Current' | 'Review due' | 'Missing'
}

const SEV_RANK: Record<Severity, number> = { blocked: 3, attention: 2, ok: 1, idle: 0 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ---------- date helpers ---------- */
const iso = (d: Date) => d.toISOString().slice(0, 10);
function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}
export function fmtDate(d: string): string {
  const dt = new Date(d);
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]}`;
}
export function periodLabel(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
/** The month currently owed = the last fully-completed month before `today`. */
function owedPeriod(today: Date): string {
  const d = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
/** Friday of the current week, as the default content due date. */
function endOfWeek(today: Date): string {
  const d = new Date(today);
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7));
  return iso(d);
}
/** Report is due by the 10th of the month after the period. */
function reportDue(period: string): string {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m, 10); // m (1-based) → next month index in 0-based
  return iso(d);
}

/* ---------- the engine ---------- */
export function deriveClient(client: RosterClient, snap: SnapClient | null, today: Date): ClientState {
  const tasks: Task[] = [];
  const todayIso = iso(today);
  const owed = owedPeriod(today);

  const push = (t: Omit<Task, 'clientSlug' | 'clientName' | 'overdueDays'>) => {
    const overdueDays = Math.max(0, daysBetween(t.due, todayIso));
    tasks.push({ ...t, clientSlug: client.slug, clientName: client.name, overdueDays });
  };

  // --- Reports: owed monthly, compared against real latest report ---
  const latest = snap?.latest_report ?? null;
  if (client.cadence.report === 'monthly') {
    const behind = !latest || latest.period < owed;
    if (behind) {
      const due = reportDue(owed);
      const late = new Date(todayIso) > new Date(due);
      push({
        id: `${client.slug}-report-${owed}`,
        kind: 'report',
        label: `${periodLabel(owed)} report — ${latest ? 'not started' : 'never reported'}`,
        due,
        severity: late ? 'blocked' : 'attention',
        source: 'core',
      });
    }
  }

  // --- Content: weekly article cadence ---
  const dueCount = client.live?.contentDueThisWeek ?? (client.cadence.articlesPerWeek || 0);
  if (client.cadence.articlesPerWeek > 0 && dueCount > 0) {
    push({
      id: `${client.slug}-article`,
      kind: 'article',
      label: dueCount > 1 ? `Write ${dueCount} articles this week` : 'Write article this week',
      due: endOfWeek(today),
      severity: 'attention',
      source: 'live',
    });
  }

  // --- Client approvals pending ---
  if (client.live?.pendingApprovals) {
    push({
      id: `${client.slug}-approval`,
      kind: 'approval',
      label: `${client.live.pendingApprovals} plan/approval awaiting client`,
      due: todayIso,
      severity: 'attention',
      source: 'live',
    });
  }

  // --- Connections in trouble (real, from the core) ---
  for (const conn of snap?.connections ?? []) {
    if (conn.status === 'error') {
      push({
        id: `${client.slug}-conn-${conn.provider}`,
        kind: 'connection',
        label: `${conn.provider} connection error${conn.detail ? ` — ${conn.detail}` : ''}`,
        due: todayIso,
        severity: 'blocked',
        source: 'core',
      });
    } else if (conn.status === 'untested') {
      push({
        id: `${client.slug}-conn-${conn.provider}`,
        kind: 'connection',
        label: `${conn.provider} connection untested`,
        due: todayIso,
        severity: 'attention',
        source: 'core',
      });
    }
  }

  // --- Site health ---
  if (client.live?.siteHealth === 'down') {
    push({ id: `${client.slug}-health`, kind: 'health', label: `Site down${client.live.note ? ` — ${client.live.note}` : ''}`, due: todayIso, severity: 'blocked', source: 'live' });
  } else if (client.live?.siteHealth === 'warn') {
    push({ id: `${client.slug}-health`, kind: 'health', label: `Site health warning${client.live.note ? ` — ${client.live.note}` : ''}`, due: todayIso, severity: 'attention', source: 'live' });
  }

  // --- Strategy plan on file & fresh ---
  let strategyLabel = 'Current';
  if (!client.strategy.updated) {
    strategyLabel = 'Missing';
    push({ id: `${client.slug}-strategy`, kind: 'strategy', label: 'No strategy plan on file', due: todayIso, severity: 'blocked', source: 'cadence' });
  } else {
    const ageDays = daysBetween(client.strategy.updated, todayIso);
    if (ageDays > client.cadence.reviewMonths * 30) {
      strategyLabel = 'Review due';
      push({ id: `${client.slug}-strategy`, kind: 'strategy', label: `Strategy review due (last set ${fmtDate(client.strategy.updated)})`, due: todayIso, severity: 'attention', source: 'cadence' });
    }
  }

  // roll-up
  let status: Severity = tasks.length ? 'ok' : 'ok';
  for (const t of tasks) if (SEV_RANK[t.severity] > SEV_RANK[status]) status = t.severity;

  const health: ClientState['health'] = client.live?.siteHealth
    ? client.live.siteHealth
    : snap?.connections.some((c) => c.status === 'error')
      ? 'down'
      : snap ? 'ok' : 'unknown';

  // sort tasks worst + most overdue first
  tasks.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.overdueDays - a.overdueDays);

  return { client, snap, tasks, status, health, latestReport: latest, nextReportPeriod: owed, strategyLabel };
}

export function deriveAll(snapshot: Snapshot | null, roster: RosterClient[] = ROSTER, today = new Date()): ClientState[] {
  const bySlug = new Map((snapshot?.clients ?? []).map((c) => [c.slug, c]));
  return roster.map((c) => deriveClient(c, bySlug.get(c.slug) ?? null, today));
}

/* ---------- portfolio-level tallies for the header ---------- */
export interface Totals { clients: number; blocked: number; attention: number; onTrack: number; dueThisWeek: number; overdue: number; }
export function totals(states: ClientState[]): Totals {
  const all = states.flatMap((s) => s.tasks);
  return {
    clients: states.length,
    blocked: states.filter((s) => s.status === 'blocked').length,
    attention: states.filter((s) => s.status === 'attention').length,
    onTrack: states.filter((s) => s.status === 'ok').length,
    dueThisWeek: all.filter((t) => t.overdueDays > 0 || daysBetween(iso(new Date()), t.due) <= 7).length,
    overdue: all.filter((t) => t.overdueDays > 0).length,
  };
}

export const sevRank = SEV_RANK;
