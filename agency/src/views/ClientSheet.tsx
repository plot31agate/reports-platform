/* ClientSheet — the drill-down for one client, in two tabs.

   Overview: what the roster row summarised, expanded — the task list, report
   history and connections from the core, the strategy plan, the portal link.

   Setup: the client's own record, editable. Profile (name, website, lead, type,
   cadence) writes straight to the reporting core; the credential vault holds the
   client's logins (encrypted server-side, revealed on demand and audit-stamped);
   and the two lifecycle actions — Create reporting and Create portal — wire this
   client into the rest of the stack. Everything routes through the store, so it
   persists to reporting.db online and to the local overlay offline. */
import { useState } from 'react';
import type { ClientState, SecretMeta } from '../lib/agency';
import { fmtDate, periodLabel } from '../lib/agency';
import type { RosterClient, ClientKind, PortalStatus } from '../lib/roster';
import type { Store } from '../lib/store';
import { StatusPill, TaskGlyph, toast } from '../components/ui';

type Tab = 'overview' | 'setup';

export function ClientSheet({ state, store, onClose }: { state: ClientState; store: Store; onClose: () => void }) {
  const { client } = state;
  const [tab, setTab] = useState<Tab>('overview');
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
        <div className="sheet-tabs">
          <button className={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')}>Overview</button>
          <button className={tab === 'setup' ? 'on' : ''} onClick={() => setTab('setup')}>Setup</button>
        </div>
        <div className="sheet-body">
          {tab === 'overview' ? <OverviewTab state={state} /> : <SetupTab state={state} store={store} />}
        </div>
      </div>
    </div>
  );
}

/* ============================ OVERVIEW ============================ */
function OverviewTab({ state }: { state: ClientState }) {
  const { client, snap, tasks } = state;
  return (
    <div className="grid g2" style={{ alignItems: 'start' }}>
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
          ) : <p style={{ margin: 0, color: 'var(--fail)' }}>No strategy plan on file — set one under Setup.</p>}
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

        {client.portalUrl ? (
          <a className="btn" href={client.portalUrl} target="_blank" rel="noreferrer">Open {client.name} Client HQ ↗</a>
        ) : client.kind === 'client-hq' ? (
          <div className="small" style={{ color: 'var(--faint)', textAlign: 'center', padding: '4px 0' }}>
            Client HQ portal not live yet — manage it under Setup.
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ============================ SETUP ============================ */
function SetupTab({ state, store }: { state: ClientState; store: Store }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {!store.online && (
        <div className="card accent" style={{ borderLeft: '3px solid var(--warn)', padding: '10px 14px' }}>
          <span className="eyebrow" style={{ color: 'var(--warn)' }}>Core offline</span>
          <span className="small" style={{ color: 'var(--muted)', marginLeft: 10 }}>
            Profile edits save to this browser only; the credential vault needs the reporting core.
          </span>
        </div>
      )}
      <ProfileCard client={state.client} store={store} />
      <ActionsCard state={state} store={store} />
      <VaultCard state={state} store={store} />
    </div>
  );
}

/* ---- profile ---- */
function ProfileCard({ client, store }: { client: RosterClient; store: Store }) {
  const [name, setName] = useState(client.name);
  const [website, setWebsite] = useState(client.website ?? '');
  const [owner, setOwner] = useState(client.owner);
  const [kind, setKind] = useState<ClientKind>(client.kind);
  const [report, setReport] = useState(client.cadence.report);
  const [articles, setArticles] = useState(client.cadence.articlesPerWeek);
  const [review, setReview] = useState(client.cadence.reviewMonths);
  const [busy, setBusy] = useState(false);

  const dirty = name !== client.name || website !== (client.website ?? '') || owner !== client.owner
    || kind !== client.kind || report !== client.cadence.report
    || articles !== client.cadence.articlesPerWeek || review !== client.cadence.reviewMonths;

  const save = async () => {
    setBusy(true);
    try {
      await store.patch(client.slug, {
        name: name.trim(), website: website.trim(), owner: owner.trim() || 'Unassigned', kind,
        cadence: { report, articlesPerWeek: Math.max(0, articles), reviewMonths: Math.max(1, review) },
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
        <SField label="Type">
          <div className="seg" style={{ width: 'fit-content' }}>
            <button className={kind === 'reporting' ? 'on' : ''} onClick={() => setKind('reporting')}>Reporting</button>
            <button className={kind === 'client-hq' ? 'on' : ''} onClick={() => setKind('client-hq')}>Client HQ</button>
          </div>
        </SField>
        <SField label="Report cadence">
          <select className="inp" value={report} onChange={(e) => setReport(e.target.value as typeof report)}>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="none">None</option>
          </select>
        </SField>
        <SField label="Articles / week">
          <input className="inp" type="number" min={0} value={articles} onChange={(e) => setArticles(Number(e.target.value))} />
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

/* ---- portal + reporting lifecycle ---- */
const PORTAL_STAGES: { id: PortalStatus; label: string }[] = [
  { id: 'none', label: 'Not started' },
  { id: 'planned', label: 'Planned' },
  { id: 'building', label: 'Building' },
  { id: 'live', label: 'Live' },
];

function ActionsCard({ state, store }: { state: ClientState; store: Store }) {
  const { client, snap } = state;
  const [busy, setBusy] = useState(false);
  const [portalUrl, setPortalUrl] = useState(client.portalUrl ?? '');
  const status: PortalStatus = client.portalStatus ?? (client.portalUrl ? 'live' : 'none');
  const hasReports = !!snap && snap.reports.length > 0;

  const setStage = async (s: PortalStatus) => {
    setBusy(true);
    try { await store.createPortal(client.slug, s, s === 'live' ? portalUrl.trim() : undefined); toast(`Portal: ${s}`); }
    catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };

  const createReporting = async () => {
    setBusy(true);
    try {
      const url = await store.createReporting(client.slug);
      toast('Reporting set up');
      if (url) window.open(url, '_blank');
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="eyebrow" style={{ marginBottom: 12 }}>Set up &amp; connect</div>

      {/* Reporting */}
      <div className="setup-row">
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, color: 'var(--ink)' }}>Reporting</div>
          <div className="small" style={{ color: 'var(--muted)' }}>
            {hasReports ? `${snap!.reports.length} report${snap!.reports.length === 1 ? '' : 's'} in the core`
              : client.cadence.report !== 'none' ? 'On a report cadence, no reports built yet'
              : 'Not on reporting'}
          </div>
        </div>
        {store.online && hasReports
          ? <a className="btn ghost sm" href={`/admin/workspace?client=${client.slug}`} target="_blank" rel="noreferrer">Open workspace ↗</a>
          : <button className="btn sm" disabled={busy} onClick={createReporting}>Create reporting</button>}
      </div>

      {/* Portal */}
      <div className="setup-row" style={{ borderTop: '1px solid var(--line-soft)', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontWeight: 600, color: 'var(--ink)' }}>Client HQ portal</div>
          <div className="small" style={{ color: 'var(--muted)' }}>
            Standing up the portal site is a separate build (the Client HQ scaffold). This tracks its status and link.
          </div>
        </div>
        <div className="seg" style={{ width: 'fit-content' }}>
          {PORTAL_STAGES.map((st) => (
            <button key={st.id} className={status === st.id ? 'on' : ''} disabled={busy} onClick={() => setStage(st.id)}>{st.label}</button>
          ))}
        </div>
      </div>
      {(status === 'live' || client.portalUrl) && (
        <div className="setup-row" style={{ borderTop: '1px solid var(--line-soft)', gap: 10 }}>
          <input className="inp" placeholder="https://…/portal/" value={portalUrl} onChange={(e) => setPortalUrl(e.target.value)} style={{ flex: 1 }} />
          <button className="btn ghost sm" disabled={busy} onClick={() => setStage('live')}>Save link</button>
          {client.portalUrl && <a className="btn sm" href={client.portalUrl} target="_blank" rel="noreferrer">Open ↗</a>}
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
