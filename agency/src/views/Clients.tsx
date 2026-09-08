/* Clients — the roster management room. Agency HQ is the hub, so this is where
   clients are added and their plans set without leaving for a config file.
   Adding a client opens the guided wizard (NewClientWizard): basics, a Claude
   draft of the whole setup, positioning, report sections + data connections,
   then one create that lands the client in reporting.db fully configured.
   Writes go through the store: online they hit the reporting core and
   re-derive from the DB; offline they fall back to the localStorage overlay
   so a bare preview still works. Editing later happens in the client sheet. */
import { Fragment, useState } from 'react';
import type { ClientState, Snapshot } from '../lib/agency';
import type { RosterClient } from '../lib/roster';
import type { Store } from '../lib/store';
import { overlayStats, resetOverlay } from '../lib/rosterStore';
import { toast, Empty } from '../components/ui';
import { NewClientWizard } from './NewClientWizard';

const isoToday = () => new Date().toISOString().slice(0, 10);

export function Clients({ states, store, snapshot, onOpen }: {
  states: ClientState[]; store: Store; snapshot: Snapshot | null; onOpen: (slug: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editSlug, setEditSlug] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The reset-to-config affordance only makes sense for the offline overlay.
  const stats = store.online ? { edited: 0, added: 0 } : overlayStats();
  const hasOverlay = !store.online && (stats.edited > 0 || stats.added > 0);

  const run = async (fn: () => Promise<void>, msg: string) => {
    setBusy(true);
    try { await fn(); toast(msg); }
    catch (e) { toast((e as Error).message || 'Something went wrong'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="controls" style={{ marginBottom: 14 }}>
        <div className="small" style={{ color: 'var(--muted)' }}>
          {states.length} client{states.length === 1 ? '' : 's'} · {store.online
            ? <span style={{ color: 'var(--pass)' }}>saving to the reporting core</span>
            : <span style={{ color: 'var(--warn)' }}>this browser only (core offline)</span>}
        </div>
        <div style={{ flex: 1 }} />
        {hasOverlay && (
          <button
            className="chiptoggle"
            onClick={() => { if (confirm('Discard all local roster changes and reset to config?')) { resetOverlay(); setEditSlug(null); setAdding(false); run(async () => {}, 'Roster reset to config'); } }}
            title={`${stats.edited} edited · ${stats.added} added locally`}
          >
            Reset changes
          </button>
        )}
        {store.online && (
          <button
            className="chiptoggle"
            disabled={busy}
            title="Ping every client's website and Client HQ portal, and pull portal-published status"
            onClick={async () => {
              setBusy(true);
              try {
                const r = await store.checkAllHealth();
                toast(r.checked === 0 ? 'No sites or portals to check yet'
                  : r.down > 0 ? `Checked ${r.checked} — ${r.down} down`
                  : `Checked ${r.checked} — all up`);
              } catch (e) { toast((e as Error).message); }
              finally { setBusy(false); }
            }}
          >
            {busy ? 'Checking…' : 'Check sites'}
          </button>
        )}
        <button className="btn" onClick={() => { setAdding(true); setEditSlug(null); }}>
          + Add client
        </button>
      </div>

      {adding && (
        <NewClientWizard
          store={store}
          meta={snapshot?.meta}
          assistReady={!!snapshot?.assist_ready}
          agencyKeys={snapshot?.agency_keys ?? []}
          onClose={() => setAdding(false)}
          onCreated={(_slug, c) => toast(`${c.name} added`)}
          onOpenSheet={(slug) => { setAdding(false); onOpen(slug); }}
        />
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
                <th style={{ width: 170 }} />
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
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="btn ghost sm" onClick={() => onOpen(c.slug)} title="Full setup: website, connections, credentials, portal">Setup</button>
                        <button className="btn ghost sm" style={{ marginLeft: 6 }} onClick={() => setEditSlug(editing ? null : c.slug)}>
                          {editing ? 'Close' : 'Set plan'}
                        </button>
                      </td>
                    </tr>
                    {editing && (
                      <tr className="expand">
                        <td colSpan={6}>
                          <PlanEditor
                            client={c}
                            busy={busy}
                            onSave={(focus, updated) => run(async () => {
                              await store.patch(c.slug, { strategy: { focus, updated } });
                              setEditSlug(null);
                            }, 'Plan updated')}
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
function PlanEditor({ client, busy, onSave }: { client: RosterClient; busy: boolean; onSave: (focus: string, updated: string) => void }) {
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
        <button className="btn" disabled={!focus.trim() || busy} onClick={() => onSave(focus.trim(), date)}>Save plan</button>
      </div>
    </div>
  );
}

