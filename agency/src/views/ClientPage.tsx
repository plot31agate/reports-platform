/* ClientPage — one page per client: see the systems, see what's missing, go anywhere.

   Replaces the old two-tab modal sheet. The shape:

   - Header + quick-access bar: the things you reach for daily (workspace,
     latest report, the Client HQ portal, the client's site) are always one
     click away at the top, never buried in setup.
   - Systems: Reporting, Client HQ and Content are modules a client has ON or
     OFF — each row shows its state and its one obvious action. "Create
     reporting" and "create HQ" live here, not in a type toggle.
   - Setup checklist (right rail): derived from live data, never hand-kept —
     each item jumps to the section that fixes it, so "is this client fully
     set up?" is a glance.
   - Below: profile, the reporting-core setup editors (same vocabulary as the
     new-client wizard), the credential vault, and the remove-client card.

   Everything routes through the store: reporting.db online, overlay offline. */
import { useEffect, useRef, useState } from 'react';
import type { ClientState, SecretMeta, Snapshot } from '../lib/agency';
import { fmtDate, periodLabel } from '../lib/agency';
import type { RosterClient, PortalStatus } from '../lib/roster';
import type { Store } from '../lib/store';
import { StatusPill, TaskGlyph, toast } from '../components/ui';
import { LinesArea, SectionsPicker, ConnectionFields, FALLBACK_META, fromLines, toLines } from '../components/setup';

const isoToday = () => new Date().toISOString().slice(0, 10);

export function ClientPage({ state, store, snapshot, onBack }: {
  state: ClientState; store: Store; snapshot: Snapshot | null; onBack: () => void;
}) {
  const { client, snap } = state;
  // Bumping this opens the reporting-setup editors (checklist jumps use it).
  const [setupSignal, setSetupSignal] = useState(0);

  const jump = (target: string) => {
    if (target === 'sec-reporting') setSetupSignal((v) => v + 1);
    // Let the section render open before scrolling to it.
    requestAnimationFrame(() =>
      document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const reportingOn = client.cadence.report !== 'none' || (snap?.reports.length ?? 0) > 0;
  const portalStatus: PortalStatus = client.portalStatus ?? (client.portalUrl ? 'live' : 'none');
  const systems = [
    reportingOn ? 'Reporting' : null,
    portalStatus !== 'none' ? 'Client HQ' : null,
    client.cadence.articlesPerWeek > 0 ? 'Content' : null,
  ].filter(Boolean).join(' · ') || 'No systems on yet';

  return (
    <div>
      {/* ---- header ---- */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <button className="linky" onClick={onBack} style={{ textDecoration: 'none', fontSize: 12.5 }}>← Clients</button>
          <h1 style={{ margin: '6px 0 4px' }}>{client.name}</h1>
          <div className="small" style={{ color: 'var(--muted)' }}>{client.owner} · {systems}</div>
        </div>
        <div style={{ paddingTop: 26 }}><StatusPill s={state.status} /></div>
      </div>

      {/* ---- quick access: the daily destinations ---- */}
      <div className="cp-quick">
        {store.online && (
          <a className="btn sm" href={`/admin/workspace?client=${client.slug}`} target="_blank" rel="noreferrer">Open workspace ↗</a>
        )}
        {store.online && state.latestReport && (
          <a className="btn ghost sm" href={`/admin/workspace?client=${client.slug}&period=${state.latestReport.period}`} target="_blank" rel="noreferrer">
            Latest report · {periodLabel(state.latestReport.period)} ↗
          </a>
        )}
        {client.portalUrl && (
          <a className="btn ghost sm" href={client.portalUrl} target="_blank" rel="noreferrer">Open Client HQ ↗</a>
        )}
        {client.website && (
          <a className="btn ghost sm" href={client.website} target="_blank" rel="noreferrer">{prettyUrl(client.website)} ↗</a>
        )}
      </div>

      {!store.online && (
        <div className="card accent" style={{ borderLeft: '3px solid var(--warn)', padding: '10px 14px', marginBottom: 16 }}>
          <span className="eyebrow" style={{ color: 'var(--warn)' }}>Core offline</span>
          <span className="small" style={{ color: 'var(--muted)', marginLeft: 10 }}>
            Edits save to this browser only; the reporting setup and credential vault need the reporting core.
          </span>
        </div>
      )}

      <div className="cp-grid">
        {/* ---- left: systems + setup ---- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          <SystemsCard state={state} store={store} onSetUpReporting={() => jump('sec-reporting')} />
          <div id="sec-profile"><ProfileCard client={client} store={store} /></div>
          {store.online && (
            <div id="sec-reporting">
              <ReportingSetupCard state={state} store={store} snapshot={snapshot} openSignal={setupSignal} />
            </div>
          )}
          <div id="sec-vault"><VaultCard state={state} store={store} /></div>
          <DangerCard state={state} store={store} onDone={onBack} />
        </div>

        {/* ---- right rail: checklist + live state ---- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          {store.online && (client.website || client.portalUrl) && (
            <LiveHealthCard state={state} store={store} />
          )}
          <ChecklistCard state={state} reportingOn={reportingOn} portalStatus={portalStatus} onJump={jump} />
          <div id="sec-strategy"><StrategyCard client={client} state={state} store={store} /></div>
          <OutstandingCard state={state} />
          {snap && snap.reports.length > 0 && <ReportHistoryCard state={state} />}
          {snap && snap.connections.length > 0 && <ConnectionsStatusCard state={state} />}
        </div>
      </div>
    </div>
  );
}

/* ============================ SYSTEMS ============================ */
const PORTAL_STAGES: { id: PortalStatus; label: string }[] = [
  { id: 'none', label: 'Off' },
  { id: 'planned', label: 'Planned' },
  { id: 'building', label: 'Building' },
  { id: 'live', label: 'Live' },
];

function SystemsCard({ state, store, onSetUpReporting }: {
  state: ClientState; store: Store; onSetUpReporting: () => void;
}) {
  const { client, snap } = state;
  const [busy, setBusy] = useState(false);
  const [portalUrl, setPortalUrl] = useState(client.portalUrl ?? '');
  const [articles, setArticles] = useState(client.cadence.articlesPerWeek);

  const reports = snap?.reports.length ?? 0;
  const reportingOn = client.cadence.report !== 'none' || reports > 0;
  const portalStatus: PortalStatus = client.portalStatus ?? (client.portalUrl ? 'live' : 'none');

  const turnOnReporting = async () => {
    setBusy(true);
    try {
      await store.createReporting(client.slug);
      toast('Reporting is on — finish its setup below');
      onSetUpReporting();
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };

  const setStage = async (s: PortalStatus) => {
    setBusy(true);
    try { await store.createPortal(client.slug, s, s === 'live' ? portalUrl.trim() : undefined); toast(s === 'none' ? 'Client HQ off' : `Client HQ: ${s}`); }
    catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };

  const saveArticles = async () => {
    setBusy(true);
    try {
      await store.patch(client.slug, { cadence: { ...client.cadence, articlesPerWeek: Math.max(0, articles) } });
      toast(articles > 0 ? `Content: ${articles}/week` : 'Content off');
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="eyebrow" style={{ marginBottom: 4 }}>Systems</div>

      {/* Reporting */}
      <div className="setup-row">
        <ModuleState
          on={reportingOn}
          name="Reporting"
          detail={reports > 0
            ? `${client.cadence.report} · ${reports} report${reports === 1 ? '' : 's'}, latest ${state.latestReport ? periodLabel(state.latestReport.period) : '—'}`
            : reportingOn ? `${client.cadence.report} cadence · no reports built yet` : 'Monthly report machine: sections, data syncs, AI commentary, share links'}
        />
        {reportingOn ? (
          store.online
            ? <a className="btn ghost sm" href={`/admin/workspace?client=${client.slug}`} target="_blank" rel="noreferrer">Open workspace ↗</a>
            : <span className="small" style={{ color: 'var(--faint)' }}>workspace needs the core</span>
        ) : (
          <button className="btn sm" disabled={busy} onClick={turnOnReporting}>Create reporting</button>
        )}
      </div>

      {/* Client HQ */}
      <div className="setup-row" style={{ borderTop: '1px solid var(--line-soft)', flexWrap: 'wrap' }}>
        <ModuleState
          on={portalStatus === 'live'}
          mid={portalStatus === 'planned' || portalStatus === 'building'}
          name="Client HQ"
          detail={portalStatus === 'live' ? 'Portal live'
            : portalStatus !== 'none' ? `Portal ${portalStatus} — the site itself is a separate build (client-hq scaffold)`
            : 'Client portal: content engine, plan approvals, post workbench, site health'}
        />
        <div className="seg" style={{ width: 'fit-content' }}>
          {PORTAL_STAGES.map((st) => (
            <button key={st.id} className={portalStatus === st.id ? 'on' : ''} disabled={busy} onClick={() => setStage(st.id)}>{st.label}</button>
          ))}
        </div>
      </div>
      {(portalStatus === 'live' || client.portalUrl) && (
        <div className="setup-row" style={{ gap: 10, paddingTop: 0 }}>
          <span style={{ width: 18 }} />
          <input className="inp" placeholder="https://…/portal/" value={portalUrl} onChange={(e) => setPortalUrl(e.target.value)} style={{ flex: 1 }} />
          <button className="btn ghost sm" disabled={busy} onClick={() => setStage('live')}>Save link</button>
          {client.portalUrl && <a className="btn sm" href={client.portalUrl} target="_blank" rel="noreferrer">Open ↗</a>}
        </div>
      )}

      {/* Content */}
      <div className="setup-row" style={{ borderTop: '1px solid var(--line-soft)' }}>
        <ModuleState
          on={client.cadence.articlesPerWeek > 0}
          name="Content"
          detail={client.cadence.articlesPerWeek > 0
            ? `${client.cadence.articlesPerWeek} article${client.cadence.articlesPerWeek === 1 ? '' : 's'} / week, due Fridays`
            : 'Weekly article cadence — drives the This-week board'}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input className="inp" type="number" min={0} value={articles} style={{ width: 70 }}
            onChange={(e) => setArticles(Number(e.target.value))} />
          <span className="small" style={{ color: 'var(--muted)' }}>/wk</span>
          {articles !== client.cadence.articlesPerWeek && (
            <button className="btn ghost sm" disabled={busy} onClick={saveArticles}>Save</button>
          )}
        </div>
      </div>
    </div>
  );
}

function ModuleState({ on, mid, name, detail }: { on: boolean; mid?: boolean; name: string; detail: string }) {
  return (
    <div style={{ flex: 1, minWidth: 200, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <span className={`dot ${on ? 'up' : mid ? 'warn' : 'idle'}`} style={{ marginTop: 6 }} />
      <div>
        <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{name}</div>
        <div className="small" style={{ color: 'var(--muted)', lineHeight: 1.45 }}>{detail}</div>
      </div>
    </div>
  );
}

/* ============================ CHECKLIST ============================ */
interface CheckItem { id: string; label: string; status: 'done' | 'warn' | 'todo'; detail?: string; target: string; }

function deriveChecklist(state: ClientState, reportingOn: boolean, portalStatus: PortalStatus): CheckItem[] {
  const { client, snap } = state;
  const setup = snap?.setup;
  const items: CheckItem[] = [];

  items.push({
    id: 'website', label: 'Website on profile', target: 'sec-profile',
    status: client.website ? 'done' : 'todo',
  });

  items.push({
    id: 'strategy', label: 'Strategy plan',
    status: !client.strategy.updated ? 'todo' : state.strategyLabel === 'Review due' ? 'warn' : 'done',
    detail: state.strategyLabel === 'Review due' ? 'review due' : undefined,
    target: 'sec-strategy',
  });

  if (reportingOn && setup) {
    const briefs = [setup.sentiment_context, setup.report_focus].filter((b) => b.trim()).length;
    items.push({
      id: 'briefs', label: 'AI briefs (sentiment + report focus)',
      status: briefs === 2 ? 'done' : briefs === 1 ? 'warn' : 'todo',
      detail: briefs === 1 ? '1 of 2 set' : undefined,
      target: 'sec-reporting',
    });

    const savedProviders = Object.entries(setup.connections)
      .filter(([, fields]) => Object.values(fields).some((v) => v && v !== '')).map(([p]) => p);
    const statuses = new Map((snap?.connections ?? []).map((c) => [c.provider, c.status]));
    const anyError = savedProviders.some((p) => statuses.get(p) === 'error');
    const untested = savedProviders.filter((p) => !statuses.has(p) || statuses.get(p) === 'untested');
    items.push({
      id: 'connections', label: 'Data connections',
      status: savedProviders.length === 0 ? 'todo' : anyError ? 'warn' : untested.length ? 'warn' : 'done',
      detail: savedProviders.length === 0 ? 'none saved'
        : anyError ? 'connection error'
        : untested.length ? `${untested.length} untested` : `${savedProviders.length} connected`,
      target: 'sec-reporting',
    });
  }

  items.push({
    id: 'vault', label: 'Logins in the vault', target: 'sec-vault',
    status: (snap?.secrets?.length ?? 0) > 0 ? 'done' : 'todo',
    detail: snap?.secrets?.length ? `${snap.secrets.length} stored` : undefined,
  });

  if (reportingOn) {
    items.push({
      id: 'first-report', label: 'First report built', target: 'sec-systems',
      status: (snap?.reports.length ?? 0) > 0 ? 'done' : 'todo',
    });
  }

  if (portalStatus !== 'none') {
    items.push({
      id: 'portal', label: 'Client HQ portal live', target: 'sec-systems',
      status: portalStatus === 'live' ? 'done' : 'warn',
      detail: portalStatus !== 'live' ? portalStatus : undefined,
    });
  }

  return items;
}

function ChecklistCard({ state, reportingOn, portalStatus, onJump }: {
  state: ClientState; reportingOn: boolean; portalStatus: PortalStatus; onJump: (target: string) => void;
}) {
  const items = deriveChecklist(state, reportingOn, portalStatus);
  const done = items.filter((i) => i.status === 'done').length;
  return (
    <div className="card" id="sec-systems">
      <div className="controls" style={{ marginBottom: 6 }}>
        <div className="eyebrow">Setup · {done}/{items.length}</div>
        <div style={{ flex: 1 }} />
        {done === items.length && <span className="pill pass">Fully set up</span>}
      </div>
      <div className="wt-bar" style={{ margin: '2px 0 8px' }}>
        <span style={{ width: `${Math.round((done / Math.max(1, items.length)) * 100)}%` }} />
      </div>
      {items.map((i) => (
        <button key={i.id} className="check-item" onClick={() => onJump(i.target)}>
          <span className={`ck-dot ${i.status}`}>{i.status === 'done' ? '✓' : i.status === 'warn' ? '!' : ''}</span>
          <span className="ck-label" style={{ color: i.status === 'done' ? 'var(--muted)' : 'var(--ink)' }}>{i.label}</span>
          {i.detail && <span className="small" style={{ color: i.status === 'warn' ? 'var(--warn)' : 'var(--faint)' }}>{i.detail}</span>}
        </button>
      ))}
    </div>
  );
}

/* ============================ RIGHT-RAIL CARDS ============================ */

/* ---- live estate health: what the last check actually measured ---- */
function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const HEALTH_LABEL: Record<string, string> = { ok: 'up', warn: 'warning', down: 'down' };

function LiveHealthCard({ state, store }: { state: ClientState; store: Store }) {
  const { client } = state;
  const live = client.live ?? {};
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true);
    try {
      const r = await store.checkHealth(client.slug);
      const worst = [r.siteHealth, r.portalHealth].includes('down') ? 'something is down'
        : [r.siteHealth, r.portalHealth].includes('warn') ? 'warnings found' : 'all up';
      toast(`Checked — ${worst}`);
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };

  const row = (label: string, health?: string) => health && (
    <div className="checkrow" style={{ padding: '7px 0' }}>
      <span className={`dot ${health === 'ok' ? 'up' : health === 'warn' ? 'warn' : 'down'}`} />
      <span className="name">{label}</span>
      <span className={`pill ${health === 'ok' ? 'pass' : health === 'warn' ? 'warn' : 'fail'}`}>{HEALTH_LABEL[health] ?? health}</span>
    </div>
  );

  return (
    <div className="card">
      <div className="controls" style={{ marginBottom: 6 }}>
        <div className="eyebrow">Live status</div>
        <div style={{ flex: 1 }} />
        <button className="btn ghost sm" disabled={busy} onClick={check}>{busy ? 'Checking…' : 'Check now'}</button>
      </div>
      {!live.checkedAt ? (
        <p className="small" style={{ margin: 0, color: 'var(--faint)' }}>
          Never checked — Check now pings the site{client.portalUrl ? ' and portal' : ''} for real.
        </p>
      ) : (
        <>
          {row('Website', client.website ? (live.siteHealth ?? undefined) : undefined)}
          {row('Client HQ portal', client.portalUrl ? (live.portalHealth ?? undefined) : undefined)}
          {(live.pendingApprovals !== undefined || live.contentDueThisWeek !== undefined) && (
            <div className="small" style={{ color: 'var(--muted)', marginTop: 6 }}>
              Portal reports: {[
                live.pendingApprovals !== undefined ? `${live.pendingApprovals} approval${live.pendingApprovals === 1 ? '' : 's'} pending` : null,
                live.contentDueThisWeek !== undefined ? `${live.contentDueThisWeek} article${live.contentDueThisWeek === 1 ? '' : 's'} due this week` : null,
              ].filter(Boolean).join(' · ')}
            </div>
          )}
          {live.note && <div className="small" style={{ color: 'var(--warn)', marginTop: 6 }}>{live.note}</div>}
          <div className="small" style={{ color: 'var(--faint)', marginTop: 8 }}>Checked {timeAgo(live.checkedAt)}</div>
        </>
      )}
    </div>
  );
}

function StrategyCard({ client, state, store }: { client: RosterClient; state: ClientState; store: Store }) {
  const [editing, setEditing] = useState(false);
  const [focus, setFocus] = useState(client.strategy.focus ?? '');
  const [busy, setBusy] = useState(false);

  const save = async (date: string) => {
    setBusy(true);
    try {
      await store.patch(client.slug, { strategy: { focus: focus.trim(), updated: date } });
      setEditing(false);
      toast('Strategy plan saved');
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="controls" style={{ marginBottom: 8 }}>
        <div className="eyebrow">Strategy plan</div>
        <div style={{ flex: 1 }} />
        {state.strategyLabel === 'Review due' && <span className="pill warn">Review due</span>}
        <button className="btn ghost sm" onClick={() => setEditing((v) => !v)}>{editing ? 'Cancel' : client.strategy.updated ? 'Edit' : 'Set plan'}</button>
      </div>
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <textarea className="inp" rows={2} placeholder="One line on the current strategic focus…" value={focus}
            onChange={(e) => setFocus(e.target.value)} style={{ resize: 'vertical', fontFamily: 'inherit' }} autoFocus />
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn sm" disabled={!focus.trim() || busy} onClick={() => save(isoToday())}>Save · reviewed today</button>
            {client.strategy.updated && (
              <button className="btn ghost sm" disabled={!focus.trim() || busy} onClick={() => save(client.strategy.updated!)}>Save, keep date</button>
            )}
          </div>
        </div>
      ) : client.strategy.updated ? (
        <>
          <p style={{ margin: 0, color: 'var(--ink)', fontWeight: 500 }}>{client.strategy.focus}</p>
          <div className="small" style={{ color: 'var(--muted)', marginTop: 8 }}>
            Last set {fmtDate(client.strategy.updated)} · reviewed every {client.cadence.reviewMonths} months
          </div>
        </>
      ) : (
        <p className="small" style={{ margin: 0, color: 'var(--fail)' }}>No strategy plan on file.</p>
      )}
    </div>
  );
}

function OutstandingCard({ state }: { state: ClientState }) {
  const { tasks } = state;
  return (
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
  );
}

function ReportHistoryCard({ state }: { state: ClientState }) {
  const reports = state.snap?.reports ?? [];
  return (
    <div className="card">
      <div className="eyebrow" style={{ marginBottom: 8 }}>Report history</div>
      <table className="t compact">
        <tbody>
          {reports.slice(0, 6).map((r) => (
            <tr key={r.period}>
              <td style={{ fontWeight: 500 }}>{periodLabel(r.period)}</td>
              <td style={{ textAlign: 'right' }}>
                <span className={`pill ${r.status === 'published' ? 'pass' : 'warn'}`}>{r.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConnectionsStatusCard({ state }: { state: ClientState }) {
  return (
    <div className="card">
      <div className="eyebrow" style={{ marginBottom: 8 }}>Data connections</div>
      {(state.snap?.connections ?? []).map((c) => (
        <div key={c.provider} className="checkrow" style={{ padding: '6px 0' }}>
          <span className="name">{c.provider}</span>
          <span className={`pill ${c.status === 'ok' ? 'pass' : c.status === 'error' ? 'fail' : 'warn'}`}>{c.status}</span>
        </div>
      ))}
    </div>
  );
}

/* ============================ SETUP CARDS ============================ */
function ProfileCard({ client, store }: { client: RosterClient; store: Store }) {
  const [name, setName] = useState(client.name);
  const [website, setWebsite] = useState(client.website ?? '');
  const [owner, setOwner] = useState(client.owner);
  const [report, setReport] = useState(client.cadence.report);
  const [review, setReview] = useState(client.cadence.reviewMonths);
  const [busy, setBusy] = useState(false);

  const dirty = name !== client.name || website !== (client.website ?? '') || owner !== client.owner
    || report !== client.cadence.report || review !== client.cadence.reviewMonths;

  const save = async () => {
    setBusy(true);
    try {
      await store.patch(client.slug, {
        name: name.trim(), website: website.trim(), owner: owner.trim() || 'Unassigned',
        cadence: { ...client.cadence, report, reviewMonths: Math.max(1, review) },
      } as Partial<RosterClient>);
      toast('Profile saved');
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="eyebrow" style={{ marginBottom: 12 }}>Profile</div>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <SField label="Client name"><input className="inp" value={name} onChange={(e) => setName(e.target.value)} /></SField>
        <SField label="Website">
          <input className="inp" placeholder="https://…" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </SField>
        <SField label="Account lead"><input className="inp" value={owner} onChange={(e) => setOwner(e.target.value)} /></SField>
        <SField label="Report cadence">
          <select className="inp" value={report} onChange={(e) => setReport(e.target.value as typeof report)}>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="none">None</option>
          </select>
        </SField>
        <SField label="Review plan every (months)">
          <input className="inp" type="number" min={1} value={review} onChange={(e) => setReview(Number(e.target.value))} />
        </SField>
      </div>
      <div style={{ marginTop: 14 }}>
        <button className="btn" disabled={!dirty || busy || !name.trim()} onClick={save}>Save profile</button>
      </div>
    </div>
  );
}

/* ---- reporting-core setup: same vocabulary as the new-client wizard ---- */
function ReportingSetupCard({ state, store, snapshot, openSignal }: {
  state: ClientState; store: Store; snapshot: Snapshot | null; openSignal: number;
}) {
  const meta = snapshot?.meta ?? FALLBACK_META;
  const setup = state.snap?.setup;
  const agencyKeys = snapshot?.agency_keys ?? [];

  const [open, setOpen] = useState(false);
  const firstSignal = useRef(openSignal);
  useEffect(() => {
    if (openSignal !== firstSignal.current) setOpen(true);
  }, [openSignal]);

  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [about, setAbout] = useState(setup?.about ?? '');
  const [sections, setSections] = useState<string[]>(setup?.sections ?? []);
  const [competitors, setCompetitors] = useState(toLines(setup?.competitors));
  const [executives, setExecutives] = useState(toLines(setup?.executives));
  const [sentiment, setSentiment] = useState(setup?.sentiment_context ?? '');
  const [reportFocus, setReportFocus] = useState(setup?.report_focus ?? '');
  const [conn, setConnState] = useState<Record<string, Record<string, string>>>(setup?.connections ?? {});
  const setConn = (provider: string, key: string, value: string) =>
    setConnState((prev) => ({ ...prev, [provider]: { ...(prev[provider] ?? {}), [key]: value } }));

  const saveSettings = async () => {
    setBusy(true);
    try {
      await store.saveSettings(state.client.slug, {
        about: about.trim(), sections,
        competitors: fromLines(competitors), executives: fromLines(executives),
        sentiment_context: sentiment.trim(), report_focus: reportFocus.trim(),
      });
      toast('Reporting setup saved');
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };

  const saveConn = async (provider: string) => {
    setBusy(true);
    try { await store.saveConnection(state.client.slug, provider, conn[provider] ?? {}); toast('Connection settings saved'); }
    catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };

  const testConn = async (provider: string) => {
    setBusy(true);
    try {
      const r = await store.testConnection(state.client.slug, provider);
      toast(r.ok ? `✓ ${r.message}` : r.message);
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };

  const redraft = async () => {
    setDrafting(true);
    try {
      const draft = await store.draftSetup({
        name: state.client.name, website: state.client.website,
        description: about.trim(), kind: state.client.kind,
      });
      if (draft.about && !about.trim()) setAbout(draft.about);
      if (draft.competitors?.length && !competitors.trim()) setCompetitors(toLines(draft.competitors));
      if (draft.executives?.length && !executives.trim()) setExecutives(toLines(draft.executives));
      if (draft.sentiment_brief) setSentiment(draft.sentiment_brief);
      if (draft.report_focus) setReportFocus(draft.report_focus);
      if (draft.sections?.length && sections.length === 0) setSections(draft.sections);
      toast('Drafted — review, then Save setup');
    } catch (e) { toast((e as Error).message); }
    finally { setDrafting(false); }
  };

  const toggle = (key: string) =>
    setSections((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  return (
    <div className="card">
      <div className="controls" style={{ marginBottom: open ? 10 : 0 }}>
        <div>
          <div className="eyebrow">Reporting setup</div>
          <div className="small" style={{ color: 'var(--muted)', marginTop: 4 }}>
            {sections.length} sections · {fromLines(competitors).length} competitors ·{' '}
            {sentiment.trim() ? 'sentiment brief set' : 'no sentiment brief'} ·{' '}
            {reportFocus.trim() ? 'report focus set' : 'no report focus'}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => setOpen((v) => !v)}>{open ? 'Close' : 'Edit'}</button>
      </div>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 4 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn ghost sm" disabled={drafting || !snapshot?.assist_ready} onClick={redraft}>
              {drafting ? 'Claude is drafting…' : 'Draft empty fields with Claude'}
            </button>
            {!snapshot?.assist_ready && <span className="small" style={{ color: 'var(--faint)' }}>ANTHROPIC_API_KEY isn't set on the server.</span>}
          </div>
          <LinesArea label="About" rows={2} hint="One or two sentences on what they do — context for every Claude draft."
            value={about} onChange={setAbout} />
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Report sections</div>
            <SectionsPicker defs={meta.section_defs} chosen={sections} onToggle={toggle} />
          </div>
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <LinesArea label="Competitors" placeholder={'One per line'} value={competitors} onChange={setCompetitors} />
            <LinesArea label="Executives to track" placeholder={'One per line'} value={executives} onChange={setExecutives} />
          </div>
          <LinesArea label="Sentiment brief" rows={5}
            hint="Read by the AI that scores every media mention from this client's commercial perspective."
            value={sentiment} onChange={setSentiment} />
          <LinesArea label="Report focus" rows={4}
            hint="Read by the AI that writes the report's headline and commentary."
            value={reportFocus} onChange={setReportFocus} />
          <div>
            <button className="btn" disabled={busy} onClick={saveSettings}>Save setup</button>
          </div>

          <div className="eyebrow" style={{ marginTop: 6 }}>Data connections</div>
          {meta.connectors.map((c) => (
            <ConnectionFields
              key={c.provider} def={c}
              hasAgencyKey={agencyKeys.includes(c.provider)}
              values={conn[c.provider] ?? {}}
              onChange={(k, v) => setConn(c.provider, k, v)}
              extra={
                <span style={{ display: 'inline-flex', gap: 6 }}>
                  <button className="btn ghost sm" disabled={busy} onClick={() => saveConn(c.provider)}>Save</button>
                  <button className="btn ghost sm" disabled={busy} onClick={() => testConn(c.provider)}>Test</button>
                </span>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- credential vault ---- */
function VaultCard({ state, store }: { state: ClientState; store: Store }) {
  const secrets = state.snap?.secrets ?? [];
  const [adding, setAdding] = useState(false);

  if (!store.online || !store.vaultReady) {
    return (
      <div className="card">
        <div className="eyebrow" style={{ marginBottom: 8 }}>Credentials</div>
        <p className="small" style={{ margin: 0, color: 'var(--muted)' }}>
          {store.online
            ? 'The vault is locked — VAULT_KEY isn’t set on the server. Add it to .env to store client logins.'
            : 'Client logins live in the reporting core. Sign in there to view or add credentials.'}
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="controls" style={{ marginBottom: 10 }}>
        <div className="eyebrow">Credentials · {secrets.length}</div>
        <div style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => setAdding((v) => !v)}>{adding ? 'Cancel' : '+ Add login'}</button>
      </div>
      <p className="small" style={{ margin: '0 0 12px', color: 'var(--faint)' }}>
        Shared team vault — passwords are encrypted at rest and only decrypted when you reveal one. Every reveal is logged.
      </p>

      {adding && (
        <SecretForm
          onCancel={() => setAdding(false)}
          onSave={async (input) => { await store.addSecret(state.client.slug, input); setAdding(false); toast('Login saved'); }}
        />
      )}

      {secrets.length === 0 && !adding && (
        <div className="small" style={{ color: 'var(--faint)', padding: '4px 0' }}>No logins stored yet.</div>
      )}
      {secrets.map((s) => <SecretRow key={s.id} secret={s} store={store} />)}
    </div>
  );
}

function SecretRow({ secret, store }: { secret: SecretMeta; store: Store }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const reveal = async () => {
    setBusy(true);
    try { setRevealed(await store.revealSecret(secret.id)); }
    catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    const pw = revealed ?? await store.revealSecret(secret.id).catch(() => null);
    if (pw == null) return;
    try { await navigator.clipboard.writeText(pw); toast('Password copied'); } catch { toast('Copy failed'); }
  };
  const del = async () => {
    if (!confirm(`Delete the "${secret.label}" login?`)) return;
    try { await store.deleteSecret(secret.id); toast('Login deleted'); } catch (e) { toast((e as Error).message); }
  };

  if (editing) {
    return (
      <SecretForm
        secret={secret}
        onCancel={() => setEditing(false)}
        onSave={async (input) => { await store.updateSecret(secret.id, input); setEditing(false); toast('Login updated'); }}
      />
    );
  }

  return (
    <div className="vault-row">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{secret.label}</div>
        <div className="small" style={{ color: 'var(--muted)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {secret.username && <span>{secret.username}</span>}
          {secret.login_url && <a href={secret.login_url} target="_blank" rel="noreferrer" className="linky">{prettyUrl(secret.login_url)} ↗</a>}
        </div>
        {revealed !== null && (
          <div className="vault-pw">
            <code>{revealed}</code>
            <button className="linky" onClick={() => setRevealed(null)}>hide</button>
          </div>
        )}
        {secret.last_revealed_at && (
          <div className="small" style={{ color: 'var(--faint)', marginTop: 4 }}>
            last revealed {fmtDate(secret.last_revealed_at.slice(0, 10))}{secret.last_revealed_by ? ` by ${secret.last_revealed_by}` : ''}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
        {secret.has_password ? (
          <>
            {revealed === null && <button className="btn ghost sm" disabled={busy} onClick={reveal}>Reveal</button>}
            <button className="btn ghost sm" onClick={copy}>Copy</button>
          </>
        ) : <span className="small" style={{ color: 'var(--faint)' }}>no password</span>}
        <button className="btn ghost sm" onClick={() => setEditing(true)}>Edit</button>
        <button className="btn ghost sm" style={{ color: 'var(--fail)' }} onClick={del}>Delete</button>
      </div>
    </div>
  );
}

function SecretForm({ secret, onCancel, onSave }: {
  secret?: SecretMeta; onCancel: () => void; onSave: (input: { label: string; login_url?: string; username?: string; password?: string; notes?: string }) => Promise<void>;
}) {
  const [label, setLabel] = useState(secret?.label ?? '');
  const [loginUrl, setLoginUrl] = useState(secret?.login_url ?? '');
  const [username, setUsername] = useState(secret?.username ?? '');
  const [password, setPassword] = useState('');
  const [notes, setNotes] = useState(secret?.notes ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!label.trim()) return;
    setBusy(true);
    try {
      // Editing with a blank password field leaves the stored one untouched
      // (omit the key); a fresh secret sends whatever was typed.
      const input: { label: string; login_url?: string; username?: string; password?: string; notes?: string } = {
        label: label.trim(), login_url: loginUrl.trim(), username: username.trim(), notes: notes.trim(),
      };
      if (!secret || password) input.password = password;
      await onSave(input);
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="vault-form">
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <SField label="Label"><input className="inp" placeholder="WordPress admin" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus /></SField>
        <SField label="Login URL"><input className="inp" placeholder="https://…/wp-admin" value={loginUrl} onChange={(e) => setLoginUrl(e.target.value)} /></SField>
        <SField label="Username / email"><input className="inp" value={username} onChange={(e) => setUsername(e.target.value)} /></SField>
        <SField label={secret ? 'Password (blank = keep)' : 'Password'}>
          <input className="inp" type="password" placeholder={secret ? '••••••••' : ''} value={password} onChange={(e) => setPassword(e.target.value)} />
        </SField>
      </div>
      <SField label="Notes (optional)"><input className="inp" placeholder="2FA on Steve’s phone, recovery email…" value={notes} onChange={(e) => setNotes(e.target.value)} /></SField>
      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
        <button className="btn sm" disabled={!label.trim() || busy} onClick={submit}>{secret ? 'Save changes' : 'Save login'}</button>
        <button className="btn ghost sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/* ---- remove client: type-the-name confirmation, then gone for good ---- */
function DangerCard({ state, store, onDone }: { state: ClientState; store: Store; onDone: () => void }) {
  const { client, snap } = state;
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const armed = confirmName.trim().toLowerCase() === client.name.trim().toLowerCase();

  const counts = [
    snap?.reports.length ? `${snap.reports.length} report${snap.reports.length === 1 ? '' : 's'} and their share links` : null,
    snap?.secrets?.length ? `${snap.secrets.length} vault login${snap.secrets.length === 1 ? '' : 's'}` : null,
    'all uploaded data and connection settings',
  ].filter(Boolean).join(', ');

  const remove = async () => {
    setBusy(true);
    try {
      await store.remove(client.slug);
      toast(`${client.name} removed`);
      onDone();
    } catch (e) {
      toast((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ borderColor: open ? 'var(--fail)' : undefined }}>
      <div className="controls" style={{ marginBottom: open ? 10 : 0 }}>
        <div>
          <div className="eyebrow" style={{ color: 'var(--fail)' }}>Remove client</div>
          {open && (
            <div className="small" style={{ color: 'var(--muted)', marginTop: 4, maxWidth: 560, lineHeight: 1.5 }}>
              {store.online
                ? <>Permanently deletes {client.name} from the reporting core — {counts}. There is no undo.</>
                : <>The core is offline — this only removes {client.name} from this browser's roster overlay.</>}
            </div>
          )}
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => { setOpen((v) => !v); setConfirmName(''); }}>
          {open ? 'Cancel' : 'Remove…'}
        </button>
      </div>
      {open && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="inp"
            style={{ maxWidth: 320 }}
            placeholder={`Type "${client.name}" to confirm`}
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            autoFocus
          />
          <button
            className="btn sm"
            style={{ background: 'var(--fail)', borderColor: 'var(--fail)' }}
            disabled={!armed || busy}
            onClick={remove}
          >
            {busy ? 'Removing…' : `Remove ${client.name}`}
          </button>
        </div>
      )}
    </div>
  );
}

/* ---- small helpers ---- */
function SField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span className="small" style={{ color: 'var(--muted)', fontWeight: 500 }}>{label}</span>
      {children}
    </label>
  );
}
function prettyUrl(u: string): string {
  try { return new URL(u).host; } catch { return u.replace(/^https?:\/\//, '').split('/')[0]; }
}
