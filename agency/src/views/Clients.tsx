/* Clients — the roster management room. Agency HQ is the hub, so this is where
   clients are added and their strategy plans are set, without leaving for the
   config file. Everything writes to the localStorage overlay (rosterStore) and
   calls onChange so every other view re-derives immediately. Lightweight by
   design: config clients can be edited but not deleted here; only clients added
   in the UI can be removed. */
import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import type { ClientState } from '../lib/agency';
import type { RosterClient, ClientKind } from '../lib/roster';
import {
  patchClient, addClient, removeAdded, isAdded,
  uniqueSlug, overlayStats, resetOverlay,
} from '../lib/rosterStore';
import { toast, Empty } from '../components/ui';

const isoToday = () => new Date().toISOString().slice(0, 10);

export function Clients({ states, onOpen, onChange }: {
  states: ClientState[]; onOpen: (slug: string) => void; onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editSlug, setEditSlug] = useState<string | null>(null);
  const stats = overlayStats();
  const hasOverlay = stats.edited > 0 || stats.added > 0;

  const save = (msg: string) => { onChange(); toast(msg); };

  return (
    <>
      <div className="controls" style={{ marginBottom: 14 }}>
        <div className="small" style={{ color: 'var(--muted)' }}>
          {states.length} client{states.length === 1 ? '' : 's'} in the roster
        </div>
        <div style={{ flex: 1 }} />
        {hasOverlay && (
          <button
            className="chiptoggle"
            onClick={() => { if (confirm('Discard all local roster changes and reset to config?')) { resetOverlay(); setEditSlug(null); setAdding(false); save('Roster reset to config'); } }}
            title={`${stats.edited} edited · ${stats.added} added locally`}
          >
            Reset changes
          </button>
        )}
        <button className="btn" onClick={() => { setAdding((v) => !v); setEditSlug(null); }}>
          {adding ? 'Cancel' : '+ Add client'}
        </button>
      </div>

      {adding && <AddForm onCancel={() => setAdding(false)} onAdded={() => { setAdding(false); save('Client added'); }} />}

      {hasOverlay && (
        <div className="small" style={{ color: 'var(--faint)', margin: '0 0 12px 2px' }}>
          Local changes are stored in this browser only — {stats.added} added, {stats.edited} edited. In production this writes to the roster / reporting core.
        </div>
      )}

      <div className="card" style={{ padding: '6px 8px' }}>
        {states.length === 0 ? <Empty>No clients yet — add your first.</Empty> : (
          <table className="t">
            <thead>
              <tr>
                <th>Client</th>
                <th style={{ width: 110 }}>Type</th>
                <th style={{ width: 140 }}>Cadence</th>
                <th>Strategic focus</th>
                <th style={{ width: 110 }}>Plan</th>
                <th style={{ width: 150 }} />
              </tr>
            </thead>
            <tbody>
              {states.map((s) => {
                const c = s.client;
                const editing = editSlug === c.slug;
                return (
                  <Fragment key={c.slug}>
                    <tr>
                      <td style={{ fontWeight: 600, color: 'var(--ink)' }}>
                        <button className="linky" onClick={() => onOpen(c.slug)} style={{ fontWeight: 600 }}>{c.name}</button>
                        {isAdded(c.slug) && <span className="pill" style={{ marginLeft: 8, fontSize: 10 }}>added</span>}
                      </td>
                      <td className="small">{c.kind === 'client-hq' ? 'Client HQ' : 'Reporting'}</td>
                      <td className="small" style={{ color: 'var(--muted)' }}>{cadenceLabel(c)}</td>
                      <td style={{ color: c.strategy.focus ? 'var(--body)' : 'var(--faint)' }}>
                        {c.strategy.focus || 'No focus captured'}
                      </td>
                      <td>
                        {s.strategyLabel === 'Current' && <span className="pill pass">Current</span>}
                        {s.strategyLabel === 'Review due' && <span className="pill warn">Review due</span>}
                        {s.strategyLabel === 'Missing' && <span className="pill fail">Missing</span>}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn ghost sm" onClick={() => setEditSlug(editing ? null : c.slug)}>
                          {editing ? 'Close' : 'Set plan'}
                        </button>
                        {isAdded(c.slug) && (
                          <button
                            className="btn ghost sm"
                            style={{ marginLeft: 6, color: 'var(--fail)' }}
                            onClick={() => { if (confirm(`Remove ${c.name}?`)) { removeAdded(c.slug); setEditSlug(null); save('Client removed'); } }}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                    {editing && (
                      <tr className="expand">
                        <td colSpan={6}>
                          <PlanEditor
                            client={c}
                            onSave={(focus, updated) => { patchClient(c.slug, { strategy: { focus, updated } }); setEditSlug(null); save('Plan updated'); }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function cadenceLabel(c: RosterClient): string {
  const parts: string[] = [];
  if (c.cadence.report !== 'none') parts.push(c.cadence.report === 'monthly' ? 'Monthly report' : 'Quarterly report');
  if (c.cadence.articlesPerWeek > 0) parts.push(`${c.cadence.articlesPerWeek}/wk articles`);
  return parts.length ? parts.join(' · ') : 'No delivery';
}

/* ---- inline strategy-plan editor ---- */
function PlanEditor({ client, onSave }: { client: RosterClient; onSave: (focus: string, updated: string) => void }) {
  const [focus, setFocus] = useState(client.strategy.focus ?? '');
  const [date, setDate] = useState(client.strategy.updated ?? isoToday());
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 6px' }}>
      <div className="eyebrow">Strategy plan · reviewed every {client.cadence.reviewMonths} months</div>
      <textarea
        className="inp"
        rows={2}
        placeholder="One line on the current strategic focus…"
        value={focus}
        onChange={(e) => setFocus(e.target.value)}
        style={{ resize: 'vertical', fontFamily: 'inherit' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <label className="small" style={{ color: 'var(--muted)' }}>Last set / reviewed</label>
        <input className="inp" type="date" style={{ width: 'auto' }} value={date} onChange={(e) => setDate(e.target.value)} />
        <button className="linky" onClick={() => setDate(isoToday())}>Reviewed today</button>
        <div style={{ flex: 1 }} />
        <button className="btn" disabled={!focus.trim()} onClick={() => onSave(focus.trim(), date)}>Save plan</button>
      </div>
    </div>
  );
}

/* ---- add-client form ---- */
function AddForm({ onCancel, onAdded }: { onCancel: () => void; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ClientKind>('reporting');
  const [owner, setOwner] = useState('Steve');
  const [report, setReport] = useState<'monthly' | 'quarterly' | 'none'>('monthly');
  const [articles, setArticles] = useState(0);
  const [reviewMonths, setReviewMonths] = useState(6);
  const [portalUrl, setPortalUrl] = useState('');
  const [focus, setFocus] = useState('');

  const submit = () => {
    if (!name.trim()) return;
    const client: RosterClient = {
      slug: uniqueSlug(name),
      name: name.trim(),
      kind,
      owner: owner.trim() || 'Unassigned',
      cadence: { report, articlesPerWeek: Math.max(0, articles), reviewMonths: Math.max(1, reviewMonths) },
      strategy: { updated: focus.trim() ? isoToday() : null, focus: focus.trim() || undefined },
      ...(kind === 'client-hq' && portalUrl.trim() ? { portalUrl: portalUrl.trim() } : {}),
    };
    addClient(client);
    onAdded();
  };

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="eyebrow" style={{ marginBottom: 12 }}>Add client</div>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Client name">
          <input className="inp" placeholder="e.g. Northgate FC" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Account lead">
          <input className="inp" value={owner} onChange={(e) => setOwner(e.target.value)} />
        </Field>
        <Field label="Type">
          <div className="seg" style={{ width: 'fit-content' }}>
            <button className={kind === 'reporting' ? 'on' : ''} onClick={() => setKind('reporting')}>Reporting</button>
            <button className={kind === 'client-hq' ? 'on' : ''} onClick={() => setKind('client-hq')}>Client HQ</button>
          </div>
        </Field>
        <Field label="Report cadence">
          <select className="inp" value={report} onChange={(e) => setReport(e.target.value as typeof report)}>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="none">None</option>
          </select>
        </Field>
        <Field label="Articles / week">
          <input className="inp" type="number" min={0} value={articles} onChange={(e) => setArticles(Number(e.target.value))} />
        </Field>
        <Field label="Review plan every (months)">
          <input className="inp" type="number" min={1} value={reviewMonths} onChange={(e) => setReviewMonths(Number(e.target.value))} />
        </Field>
        {kind === 'client-hq' && (
          <Field label="Client HQ portal URL (optional)">
            <input className="inp" placeholder="https://…/portal/" value={portalUrl} onChange={(e) => setPortalUrl(e.target.value)} />
          </Field>
        )}
        <Field label="Strategic focus (optional)">
          <input className="inp" placeholder="One line on the plan…" value={focus} onChange={(e) => setFocus(e.target.value)} />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <button className="btn" disabled={!name.trim()} onClick={submit}>Add to roster</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span className="small" style={{ color: 'var(--muted)', fontWeight: 500 }}>{label}</span>
      {children}
    </label>
  );
}
