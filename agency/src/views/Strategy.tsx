/* Strategy — every client's plan in one place, with freshness. The portal
   tracks the review cadence so a stale plan surfaces itself instead of being
   forgotten. */
import type { ClientState } from '../lib/agency';
import { fmtDate } from '../lib/agency';
import { Empty } from '../components/ui';

export function Strategy({ states, onOpen }: { states: ClientState[]; onOpen: (slug: string) => void }) {
  return (
    <div className="card" style={{ padding: '6px 8px' }}>
      <table className="t clickable">
        <thead>
          <tr>
            <th>Client</th>
            <th>Strategic focus</th>
            <th style={{ width: 120 }}>Last set</th>
            <th style={{ width: 120 }}>Plan</th>
          </tr>
        </thead>
        <tbody>
          {states.map((s) => (
            <tr key={s.client.slug} onClick={() => onOpen(s.client.slug)} style={{ cursor: 'pointer' }}>
              <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{s.client.name}</td>
              <td style={{ color: s.client.strategy.focus ? 'var(--body)' : 'var(--faint)' }}>
                {s.client.strategy.focus || 'No focus captured'}
              </td>
              <td className="small" style={{ color: 'var(--muted)' }}>
                {s.client.strategy.updated ? fmtDate(s.client.strategy.updated) : '—'}
              </td>
              <td>
                {s.strategyLabel === 'Current' && <span className="pill pass">Current</span>}
                {s.strategyLabel === 'Review due' && <span className="pill warn">Review due</span>}
                {s.strategyLabel === 'Missing' && <span className="pill fail">Missing</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {states.length === 0 && <Empty>No clients.</Empty>}
    </div>
  );
}
