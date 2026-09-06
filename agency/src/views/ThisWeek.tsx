/* ThisWeek — every task across every client, bucketed by urgency. This is the
   "do these things" list the reminder digest is built from. */
import type { ClientState, Task } from '../lib/agency';
import { fmtDate } from '../lib/agency';
import { TaskGlyph, Empty } from '../components/ui';

function bucketOf(t: Task): 'overdue' | 'week' | 'later' {
  if (t.overdueDays > 0) return 'overdue';
  const days = Math.round((new Date(t.due).getTime() - Date.now()) / 86400000);
  return days <= 7 ? 'week' : 'later';
}

export function ThisWeek({ states, onOpen }: { states: ClientState[]; onOpen: (slug: string) => void }) {
  const all = states.flatMap((s) => s.tasks);
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
