/* ClientSheet — the drill-down overlay for one client. Everything the roster
   row summarised, expanded: the task list, report history from the core, the
   strategy plan, connections, and the link down into its own Client HQ. */
import type { ClientState } from '../lib/agency';
import { fmtDate, periodLabel } from '../lib/agency';
import { StatusPill, TaskGlyph } from '../components/ui';

export function ClientSheet({ state, onClose }: { state: ClientState; onClose: () => void }) {
  const { client, snap, tasks } = state;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div>
            <div className="eyebrow">{client.kind === 'client-hq' ? 'Client HQ' : 'Reporting'} · {client.owner}</div>
            <div style={{ fontWeight: 650, fontSize: 18, marginTop: 3 }}>{client.name}</div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <StatusPill s={state.status} />
            <button className="pc-x" onClick={onClose}>×</button>
          </div>
        </div>
        <div className="sheet-body">
          <div className="grid g2" style={{ alignItems: 'start' }}>
            {/* Left: the tasks */}
            <div className="card">
              <div className="eyebrow" style={{ marginBottom: 10 }}>Outstanding · {tasks.length}</div>
              {tasks.length === 0 ? (
                <div className="small" style={{ color: 'var(--pass)' }}>Nothing outstanding — this client is on track.</div>
              ) : tasks.map((t) => (
                <div key={t.id} className="checkrow">
                  <TaskGlyph k={t.kind} />
                  <span className="name" style={{ color: t.severity === 'blocked' ? 'var(--fail)' : 'var(--ink)' }}>{t.label}</span>
                  {t.overdueDays > 0
                    ? <span className="pill fail">{t.overdueDays}d late</span>
                    : <span className="detail">{fmtDate(t.due)}</span>}
                </div>
              ))}
            </div>

            {/* Right: plan + facts */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="card">
                <div className="eyebrow" style={{ marginBottom: 8 }}>Strategy plan</div>
                {client.strategy.updated ? (
                  <>
                    <p style={{ margin: 0, color: 'var(--ink)', fontWeight: 500 }}>{client.strategy.focus}</p>
                    <div className="small" style={{ color: 'var(--muted)', marginTop: 8 }}>
                      Last set {fmtDate(client.strategy.updated)} · reviewed every {client.cadence.reviewMonths} months
                    </div>
                  </>
                ) : <p style={{ margin: 0, color: 'var(--fail)' }}>No strategy plan on file — add one to start tracking.</p>}
              </div>

              <div className="card">
                <div className="eyebrow" style={{ marginBottom: 8 }}>Report history</div>
                {snap && snap.reports.length > 0 ? (
                  <table className="t compact">
                    <tbody>
                      {snap.reports.slice(0, 6).map((r) => (
                        <tr key={r.period}>
                          <td style={{ fontWeight: 500 }}>{periodLabel(r.period)}</td>
                          <td style={{ textAlign: 'right' }}>
                            <span className={`pill ${r.status === 'published' ? 'pass' : 'warn'}`}>{r.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <div className="small" style={{ color: 'var(--faint)' }}>No reports in the core yet.</div>}
              </div>

              {snap && snap.connections.length > 0 && (
                <div className="card">
                  <div className="eyebrow" style={{ marginBottom: 8 }}>Data connections</div>
                  {snap.connections.map((c) => (
                    <div key={c.provider} className="checkrow" style={{ padding: '6px 0' }}>
                      <span className="name">{c.provider}</span>
                      <span className={`pill ${c.status === 'ok' ? 'pass' : c.status === 'error' ? 'fail' : 'warn'}`}>{c.status}</span>
                    </div>
                  ))}
                </div>
              )}

              {client.portalUrl && (
                <a className="btn" href={client.portalUrl} target="_blank" rel="noreferrer">Open {client.name} Client HQ →</a>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
