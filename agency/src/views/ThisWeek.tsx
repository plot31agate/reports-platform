/* ThisWeek — every task across every client. Two ways to read it: a triage LIST
   bucketed by urgency (the digest the reminders are built from), or a CALENDAR
   that lays the same tasks out on their due dates so the month's shape is
   visible at a glance. Both drill into the client sheet on click. */
import { useMemo, useState } from 'react';
import type { ClientState, Task } from '../lib/agency';
import { fmtDate } from '../lib/agency';
import { TaskGlyph, Empty } from '../components/ui';

function bucketOf(t: Task): 'overdue' | 'week' | 'later' {
  if (t.overdueDays > 0) return 'overdue';
  const days = Math.round((new Date(t.due).getTime() - Date.now()) / 86400000);
  return days <= 7 ? 'week' : 'later';
}

const SEV_VAR: Record<Task['severity'], string> = { blocked: 'var(--fail)', attention: 'var(--warn)', ok: 'var(--pass)' };
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const lsGet = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

type Mode = 'list' | 'calendar';

export function ThisWeek({ states, onOpen }: { states: ClientState[]; onOpen: (slug: string) => void }) {
  const [mode, setMode] = useState<Mode>(lsGet('agency.week.view', 'list') as Mode);
  const setModeP = (m: Mode) => { setMode(m); lsSet('agency.week.view', m); };
  const all = useMemo(() => states.flatMap((s) => s.tasks), [states]);

  return (
    <>
      <div className="controls" style={{ marginBottom: 14 }}>
        <div className="small" style={{ color: 'var(--muted)' }}>
          {all.length} task{all.length === 1 ? '' : 's'} across {states.length} client{states.length === 1 ? '' : 's'}
        </div>
        <div style={{ flex: 1 }} />
        <div className="seg">
          <button className={mode === 'list' ? 'on' : ''} onClick={() => setModeP('list')}>List</button>
          <button className={mode === 'calendar' ? 'on' : ''} onClick={() => setModeP('calendar')}>Calendar</button>
        </div>
      </div>

      {mode === 'list' ? <ListView all={all} onOpen={onOpen} /> : <CalendarView all={all} onOpen={onOpen} />}
    </>
  );
}

/* ---- list (unchanged triage buckets) ---- */
function ListView({ all, onOpen }: { all: Task[]; onOpen: (slug: string) => void }) {
  const buckets: Record<'overdue' | 'week' | 'later', Task[]> = { overdue: [], week: [], later: [] };
  for (const t of all) buckets[bucketOf(t)].push(t);
  for (const k of Object.keys(buckets) as (keyof typeof buckets)[]) {
    buckets[k].sort((a, b) => a.due.localeCompare(b.due));
  }
  const Section = ({ title, tasks, tone }: { title: string; tasks: Task[]; tone: string }) => (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="eyebrow" style={{ marginBottom: 10, color: tone }}>{title} · {tasks.length}</div>
      {tasks.length === 0 ? <Empty>Nothing here.</Empty> : (
        <table className="t clickable">
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} onClick={() => onOpen(t.clientSlug)} style={{ cursor: 'pointer' }}>
                <td style={{ width: 24 }}><TaskGlyph k={t.kind} /></td>
                <td style={{ width: 150, fontWeight: 600, color: 'var(--ink)' }}>{t.clientName}</td>
                <td style={{ color: t.severity === 'blocked' ? 'var(--fail)' : 'var(--body)' }}>{t.label}</td>
                <td style={{ width: 120, textAlign: 'right' }}>
                  {t.overdueDays > 0
                    ? <span className="pill fail">{t.overdueDays}d late</span>
                    : <span className="small" style={{ color: 'var(--muted)' }}>{fmtDate(t.due)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
  return (
    <>
      <Section title="Overdue" tasks={buckets.overdue} tone="var(--fail)" />
      <Section title="Due this week" tasks={buckets.week} tone="var(--warn)" />
      <Section title="Coming up" tasks={buckets.later} tone="var(--muted)" />
    </>
  );
}

/* ---- calendar (month grid, tasks on their due dates) ---- */
const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function CalendarView({ all, onOpen }: { all: Task[]; onOpen: (slug: string) => void }) {
  const today = new Date();
  const [cursor, setCursor] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const y = cursor.getFullYear();
  const m = cursor.getMonth();

  const byDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of all) {
      const list = map.get(t.due) ?? [];
      list.push(t);
      map.set(t.due, list);
    }
    for (const list of map.values()) list.sort((a, b) => (b.severity === 'blocked' ? 1 : 0) - (a.severity === 'blocked' ? 1 : 0));
    return map;
  }, [all]);

  // Monday-first grid; pad to whole weeks.
  const first = new Date(y, m, 1);
  const startOffset = (first.getDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(y, m, d));
  while (cells.length % 7 !== 0) cells.push(null);

  const monthTasks = all.filter((t) => { const d = new Date(t.due); return d.getFullYear() === y && d.getMonth() === m; });
  const offscreenOverdue = all.filter((t) => t.overdueDays > 0 && new Date(t.due) < first);
  const todayIso = isoOf(today);
  const step = (delta: number) => setCursor(new Date(y, m + delta, 1));

  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="cal-head">
        <div className="cal-title">{MONTHS_FULL[m]} {y}</div>
        <div className="cal-nav">
          <button className="chiptoggle" onClick={() => step(-1)} aria-label="Previous month">‹</button>
          <button className="chiptoggle" onClick={() => setCursor(new Date(today.getFullYear(), today.getMonth(), 1))}>Today</button>
          <button className="chiptoggle" onClick={() => step(1)} aria-label="Next month">›</button>
        </div>
      </div>

      {offscreenOverdue.length > 0 && (
        <div className="cal-overdue">
          <span className="pill fail">{offscreenOverdue.length} overdue</span>
          <span className="small" style={{ color: 'var(--muted)' }}>from before this month — switch to List to clear them.</span>
        </div>
      )}

      <div className="cal-grid cal-dow">
        {WEEKDAYS.map((w) => <div key={w} className="cal-dowcell">{w}</div>)}
      </div>
      <div className="cal-grid">
        {cells.map((d, i) => {
          if (!d) return <div key={`x${i}`} className="cal-cell empty" />;
          const iso = isoOf(d);
          const tasks = byDay.get(iso) ?? [];
          const isToday = iso === todayIso;
          const shown = tasks.slice(0, 3);
          const extra = tasks.length - shown.length;
          return (
            <div key={iso} className={`cal-cell ${isToday ? 'today' : ''}`}>
              <div className="cal-daynum">{d.getDate()}</div>
              <div className="cal-tasks">
                {shown.map((t) => (
                  <button
                    key={t.id}
                    className="cal-chip"
                    style={{ borderLeftColor: SEV_VAR[t.severity] }}
                    onClick={() => onOpen(t.clientSlug)}
                    title={`${t.clientName} — ${t.label}${t.overdueDays > 0 ? ` (${t.overdueDays}d late)` : ''}`}
                  >
                    <TaskGlyph k={t.kind} />
                    <span className="cal-chip-name">{t.clientName}</span>
                  </button>
                ))}
                {extra > 0 && <div className="cal-more">+{extra} more</div>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="small" style={{ color: 'var(--faint)', marginTop: 12 }}>
        {monthTasks.length} task{monthTasks.length === 1 ? '' : 's'} due in {MONTHS_FULL[m]} · click any to open the client
      </div>
    </div>
  );
}
