/* 3.1 Data audit — Present / Partial / Missing per item, the Customer.io
   name we found it under, and notes. Feeds readiness and the Swifty list. */
import { AUDIT_ITEMS } from '../lib/model';
import type { AuditItem, AuditStatus, Snapshot } from '../lib/model';
import { dataRequests, requestsText, setupGaps } from '../lib/calc';
import { CopyButton, Section } from '../components/ui';

const GROUPS: { key: AuditItem['group']; title: string; sub: string }[] = [
  { key: 'profile', title: 'Profile attributes', sub: 'What sits on each person in Customer.io' },
  { key: 'event', title: 'Events (the activity log)', sub: 'What Swifty sends as it happens' },
  { key: 'setup', title: 'Set-up checks', sub: 'Workspace plumbing' },
];
const STATUSES: { v: AuditStatus; l: string }[] = [
  { v: 'present', l: 'Present' }, { v: 'partial', l: 'Partial' }, { v: 'missing', l: 'Missing' },
];

export function Audit({ snap, update }: { snap: Snapshot; update: (fn: (s: Snapshot) => Snapshot) => void }) {
  const set = (id: string, patch: Partial<Snapshot['audit'][string]>) => update((s) => { s.audit[id] = { ...s.audit[id], ...patch }; return s; });
  const counts = { present: 0, partial: 0, missing: 0, unchecked: 0 };
  AUDIT_ITEMS.forEach((i) => { const st = snap.audit[i.id]?.status; if (st) counts[st]++; else counts.unchecked++; });
  const reqs = dataRequests(snap);
  const setup = setupGaps(snap);

  return (
    <>
      <div className="row" style={{ gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <span className="pill pass">{counts.present} present</span>
        <span className="pill warn">{counts.partial} partial</span>
        <span className="pill fail">{counts.missing} missing</span>
        <span className="pill">{counts.unchecked} not checked</span>
      </div>

      {GROUPS.map((g) => (
        <Section key={g.key} title={g.title} sub={g.sub}>
          <div className="tscroll">
            <table className="t audit">
              <thead><tr><th style={{ width: '30%' }}>Item</th><th>Status</th><th>Customer.io name</th><th>Notes</th></tr></thead>
              <tbody>
                {AUDIT_ITEMS.filter((i) => i.group === g.key).map((i) => {
                  const e = snap.audit[i.id];
                  return (
                    <tr key={i.id}>
                      <td>
                        <div className={g.key === 'event' ? 'mono' : ''} style={{ color: 'var(--ink)', fontWeight: 500 }}>{i.label}</div>
                        <div className="small fade">{i.why}</div>
                      </td>
                      <td>
                        <div className="seg3">
                          {STATUSES.map((s) => (
                            <button key={s.v} className={`st-${s.v} ${e.status === s.v ? 'on' : ''}`} onClick={() => set(i.id, { status: e.status === s.v ? '' : s.v })}>{s.l}</button>
                          ))}
                        </div>
                      </td>
                      <td>
                        {i.options ? (
                          <select className="inp" value={e.value || ''} onChange={(ev) => set(i.id, { value: ev.target.value })}>
                            <option value="">Select…</option>
                            {i.options.map((o) => <option key={o} value={o}>{o}</option>)}
                          </select>
                        ) : g.key === 'setup' ? <span className="fade small">n/a</span> : (
                          <input className="inp mono" value={e.cioName} placeholder={i.hint ? `e.g. ${i.hint}` : ''} onChange={(ev) => set(i.id, { cioName: ev.target.value })} />
                        )}
                      </td>
                      <td><input className="inp" value={e.notes} onChange={(ev) => set(i.id, { notes: ev.target.value })} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      ))}

      <Section
        title="Data requests for Swifty Global"
        sub="Every Missing or Partial profile attribute and event, plus abuse signals we want but can't see. Updates as you audit."
        right={<CopyButton text={() => requestsText(snap)} />}
      >
        {reqs.length === 0 ? <div className="fade">Nothing outstanding. Mark items Missing or Partial above to build the list.</div> : (
          <ol className="reqlist">
            {reqs.map((r) => (
              <li key={r.id}>
                <span style={{ color: 'var(--ink)', fontWeight: 500 }}>{r.label}</span>
                {r.status === 'partial' && <span className="pill warn" style={{ marginLeft: 8 }}>partial</span>}
                <div className="small fade">Why: {r.why}{snap.audit[r.id]?.notes ? ` · Note: ${snap.audit[r.id].notes}` : ''}</div>
              </li>
            ))}
          </ol>
        )}
        {setup.length > 0 && (
          <div className="note-strip" style={{ marginTop: 12 }}>
            <b>Set-up gaps for us / the client</b> (not Swifty): {setup.map((i) => i.label).join('; ')}
          </div>
        )}
      </Section>
    </>
  );
}
