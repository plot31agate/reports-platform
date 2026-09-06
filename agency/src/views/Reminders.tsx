/* Reminders — a preview of the morning digest the scheduled job would send,
   built live from the same task engine, plus the automation rules that generate
   the nudges. Shows the vision: you don't chase the portal, it chases you. */
import type { ClientState } from '../lib/agency';
import { fmtDate } from '../lib/agency';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function Reminders({ states }: { states: ClientState[] }) {
  const all = states.flatMap((s) => s.tasks);
  const overdue = all.filter((t) => t.overdueDays > 0);
  const dueSoon = all.filter((t) => t.overdueDays === 0);
  const today = new Date();

  return (
    <div className="grid g2">
      {/* The digest as it would land in the inbox / Slack */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ background: 'var(--navy)', color: '#fff', padding: '14px 18px' }}>
          <div className="eyebrow" style={{ color: 'rgba(255,255,255,0.5)' }}>Morning digest · preview</div>
          <div style={{ fontWeight: 650, fontSize: 15, marginTop: 4 }}>
            {today.getDate()} {MONTHS[today.getMonth()]} — {overdue.length} overdue, {dueSoon.length} for today
          </div>
        </div>
        <div style={{ padding: '16px 18px' }}>
          {overdue.length > 0 && (
            <>
              <div className="eyebrow" style={{ color: 'var(--fail)', marginBottom: 8 }}>Needs attention now</div>
              {overdue.slice(0, 6).map((t) => (
                <div key={t.id} className="checkrow">
                  <span className="name">{t.clientName}</span>
                  <span className="detail">{t.label}</span>
                  <span className="pill fail">{t.overdueDays}d</span>
                </div>
              ))}
            </>
          )}
          <div className="eyebrow" style={{ color: 'var(--warn)', margin: '14px 0 8px' }}>On the radar</div>
          {dueSoon.slice(0, 5).map((t) => (
            <div key={t.id} className="checkrow">
              <span className="name">{t.clientName}</span>
              <span className="detail">{t.label}</span>
              <span className="small" style={{ color: 'var(--muted)' }}>{fmtDate(t.due)}</span>
            </div>
          ))}
          <div className="small" style={{ color: 'var(--faint)', marginTop: 14 }}>
            Sent 8am each weekday to the team, and a nudge the moment anything tips overdue.
          </div>
        </div>
      </div>

      {/* The rules that generate the nudges */}
      <div className="card">
        <div className="eyebrow" style={{ marginBottom: 12 }}>Automation rules</div>
        {[
          ['Report owed', 'When the last report for a client is older than their cadence, raise it — escalate to blocked after the 10th.'],
          ['Content cadence', 'Each Monday, open an article task per client from their weekly plan.'],
          ['Approval waiting', 'If a client plan/share link is unopened for 3 days, nudge the account lead.'],
          ['Connection health', 'A GSC/GA4/Serper error or stale sync flags the client amber and lists the fix.'],
          ['Strategy freshness', 'A plan past its review window surfaces on the Strategy board and in the digest.'],
        ].map(([h, d]) => (
          <div key={h} className="checkrow">
            <span className="name" style={{ flex: 'none', width: 150 }}>{h}</span>
            <span className="detail" style={{ flex: 1 }}>{d}</span>
          </div>
        ))}
        <div className="wt-get" style={{ marginTop: 16 }}>
          <span className="eyebrow">Later</span>
          Timesheets logged against these tasks feed the Finance DB — effort vs. fee per client.
        </div>
      </div>
    </div>
  );
}
