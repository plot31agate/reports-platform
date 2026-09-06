/* Overview — the triage dashboard. Built for a big roster: the question isn't
   "list every client" but "who needs me today?". A portfolio health bar and a
   needs-you count sit up top; search + filters narrow the book; clients group
   into status bands (On track folds away) or a board. The flat table is gone. */
import { useMemo, useState } from 'react';
import type { ClientState, Totals, Severity } from '../lib/agency';
import { periodLabel } from '../lib/agency';
import { StatusDot, Empty } from '../components/ui';

const HEALTH_DOT: Record<string, string> = { ok: 'up', warn: 'warn', down: 'down', unknown: 'idle' };

type StatusFilter = 'all' | 'blocked' | 'attention' | 'ok';
type TypeFilter = 'all' | 'client-hq' | 'reporting';
type ViewMode = 'grouped' | 'board';

const lsGet = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

export function Overview({ states, totals, onOpen, go }: {
  states: ClientState[]; totals: Totals; onOpen: (slug: string) => void; go: (v: string) => void;
}) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [type, setType] = useState<TypeFilter>((lsGet('agency.type', 'all')) as TypeFilter);
  const [owner, setOwner] = useState('all');
  const [dueOnly, setDueOnly] = useState(false);
  const [view, setView] = useState<ViewMode>(lsGet('agency.view', 'grouped') as ViewMode);

  const owners = useMemo(() => ['all', ...Array.from(new Set(states.map((s) => s.client.owner))).sort()], [states]);

  const filtered = useMemo(() => states.filter((s) => {
    if (status !== 'all' && s.status !== status) return false;
    if (type !== 'all' && s.client.kind !== type) return false;
    if (owner !== 'all' && s.client.owner !== owner) return false;
    if (dueOnly && !s.tasks.some((t) => t.overdueDays > 0 || daysUntil(t.due) <= 7)) return false;
    if (q.trim()) {
      const hay = `${s.client.name} ${s.client.owner} ${s.tasks.map((t) => t.label).join(' ')}`.toLowerCase();
      if (!hay.includes(q.trim().toLowerCase())) return false;
    }
    return true;
  }), [states, status, type, owner, dueOnly, q]);

  const setViewP = (v: ViewMode) => { setView(v); lsSet('agency.view', v); };
  const setTypeP = (t: TypeFilter) => { setType(t); lsSet('agency.type', t); };

  return (
    <>
      {/* Portfolio pulse */}
      <div className="grid" style={{ gridTemplateColumns: '1.4fr 1fr 1fr 1fr', gap: 14, marginBottom: 16 }}>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div className="l" style={{ color: 'var(--muted)', fontSize: 12.5, fontWeight: 500, marginBottom: 8 }}>Portfolio health · {totals.clients} clients</div>
          <HealthBar states={states} />
          <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 12 }}>
            <Legend cls="down" n={totals.blocked} label="blocked" />
            <Legend cls="warn" n={totals.attention} label="needs input" />
            <Legend cls="up" n={totals.onTrack} label="on track" />
          </div>
        </div>
        <MiniStat n={totals.blocked + totals.attention} label="Need you" tone={totals.blocked ? 'fail' : totals.attention ? 'warn' : 'pass'} />
        <MiniStat n={totals.overdue} label="Overdue tasks" tone={totals.overdue ? 'fail' : 'pass'} />
        <MiniStat n={totals.dueThisWeek} label="Due this week" tone={totals.dueThisWeek ? 'warn' : 'pass'} />
      </div>

      {/* Controls */}
      <div className="controls">
        <input className="inp search" placeholder="Search clients, owners, tasks…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg">
          {(['all', 'blocked', 'attention', 'ok'] as StatusFilter[]).map((s) => (
            <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>
              {s === 'all' ? 'All' : s === 'blocked' ? 'Blocked' : s === 'attention' ? 'Needs input' : 'On track'}
            </button>
          ))}
        </div>
        <div className="seg">
          {(['all', 'client-hq', 'reporting'] as TypeFilter[]).map((t) => (
            <button key={t} className={type === t ? 'on' : ''} onClick={() => setTypeP(t)}>
              {t === 'all' ? 'All types' : t === 'client-hq' ? 'Client HQ' : 'Reporting'}
            </button>
          ))}
        </div>
        {owners.length > 2 && (
          <select className="inp" style={{ width: 'auto' }} value={owner} onChange={(e) => setOwner(e.target.value)}>
            {owners.map((o) => <option key={o} value={o}>{o === 'all' ? 'All owners' : o}</option>)}
          </select>
        )}
        <button className={`chiptoggle ${dueOnly ? 'on' : ''}`} onClick={() => setDueOnly((v) => !v)}>Due this week</button>
        <div style={{ flex: 1 }} />
        <div className="seg">
          <button className={view === 'grouped' ? 'on' : ''} onClick={() => setViewP('grouped')}>List</button>
          <button className={view === 'board' ? 'on' : ''} onClick={() => setViewP('board')}>Board</button>
        </div>
      </div>

      {filtered.length === 0
        ? <div className="card"><Empty>No clients match these filters.</Empty></div>
        : view === 'grouped'
          ? <Grouped states={filtered} onOpen={onOpen} />
          : <Board states={filtered} onOpen={onOpen} />}

      <div className="small" style={{ color: 'var(--faint)', marginTop: 14 }}>
        Derived from the reporting core + each client&rsquo;s plan · <button className="linky" onClick={() => go('week')}>see the week across all clients</button>
      </div>
    </>
  );
}

/* ---- grouped (status bands, On track folds away) ---- */
function Grouped({ states, onOpen }: { states: ClientState[]; onOpen: (slug: string) => void }) {
  const bands: { key: Severity; label: string; open: boolean }[] = [
    { key: 'blocked', label: 'Blocked', open: true },
    { key: 'attention', label: 'Needs input', open: true },
    { key: 'ok', label: 'On track', open: false },
  ];
  return (
    <>
      {bands.map((b) => {
        const rows = states.filter((s) => s.status === b.key).sort((a, z) => z.tasks.length - a.tasks.length);
        if (rows.length === 0) return null;
        return <Band key={b.key} sev={b.key} label={b.label} rows={rows} defaultOpen={b.open} onOpen={onOpen} />;
      })}
    </>
  );
}

function Band({ sev, label, rows, defaultOpen, onOpen }: { sev: Severity; label: string; rows: ClientState[]; defaultOpen: boolean; onOpen: (slug: string) => void }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="band">
      <button className="bandhead" onClick={() => setOpen((o) => !o)}>
        <span className={`caret ${open ? 'open' : ''}`}>▸</span>
        <StatusDot s={sev} />
        <span className="bandlabel">{label}</span>
        <span className="bandcount">{rows.length}</span>
      </button>
      {open && (
        <div className="bandbody">
          {rows.map((s) => <Row key={s.client.slug} s={s} onOpen={onOpen} />)}
        </div>
      )}
    </div>
  );
}

function Row({ s, onOpen }: { s: ClientState; onOpen: (slug: string) => void }) {
  const top = s.tasks[0];
  const more = s.tasks.length - 1;
  const reportDone = s.latestReport && s.latestReport.period >= s.nextReportPeriod;
  return (
    <button className="crow" onClick={() => onOpen(s.client.slug)}>
      <span className={`dot ${HEALTH_DOT[s.health]}`} title={`site ${s.health}`} />
      <span className="crow-name">
        {s.client.name}
        <span className="crow-meta">{s.client.kind === 'client-hq' ? 'Client HQ' : 'Reporting'} · {s.client.owner}</span>
      </span>
      <span className="crow-task">
        {top ? (
          <>
            <span style={{ color: top.severity === 'blocked' ? 'var(--fail)' : 'var(--body)' }}>{top.label}</span>
            {top.overdueDays > 0 && <span className="pill fail" style={{ marginLeft: 8 }}>{top.overdueDays}d</span>}
            {more > 0 && <span className="crow-more">+{more}</span>}
          </>
        ) : <span style={{ color: 'var(--pass)' }}>Nothing outstanding</span>}
      </span>
      <span className="crow-report">
        {reportDone
          ? <span className="pill pass">{periodLabel(s.latestReport!.period)} ✓</span>
          : <span className="pill warn">{periodLabel(s.nextReportPeriod)}</span>}
      </span>
      <span className="crow-strat">
        {s.strategyLabel === 'Current' && <span className="pill pass">Plan ✓</span>}
        {s.strategyLabel === 'Review due' && <span className="pill warn">Review</span>}
        {s.strategyLabel === 'Missing' && <span className="pill fail">No plan</span>}
      </span>
    </button>
  );
}

/* ---- board (kanban by status) ---- */
function Board({ states, onOpen }: { states: ClientState[]; onOpen: (slug: string) => void }) {
  const cols: { key: Severity; label: string }[] = [
    { key: 'blocked', label: 'Blocked' },
    { key: 'attention', label: 'Needs input' },
    { key: 'ok', label: 'On track' },
  ];
  return (
    <div className="board">
      {cols.map((c) => {
        const rows = states.filter((s) => s.status === c.key).sort((a, z) => z.tasks.length - a.tasks.length);
        return (
          <div className="boardcol" key={c.key}>
            <div className="boardcolhead"><StatusDot s={c.key} /> {c.label} <span className="bandcount">{rows.length}</span></div>
            {rows.map((s) => {
              const top = s.tasks[0];
              return (
                <button className="bcard" key={s.client.slug} onClick={() => onOpen(s.client.slug)}>
                  <div className="bcard-top">
                    <span className={`dot ${HEALTH_DOT[s.health]}`} />
                    <span className="bcard-name">{s.client.name}</span>
                  </div>
                  <div className="bcard-meta">{s.client.kind === 'client-hq' ? 'Client HQ' : 'Reporting'} · {s.client.owner}</div>
                  {top ? (
                    <div className="bcard-task" style={{ color: top.severity === 'blocked' ? 'var(--fail)' : 'var(--body)' }}>
                      {top.label}{s.tasks.length > 1 && <span className="crow-more">+{s.tasks.length - 1}</span>}
                    </div>
                  ) : <div className="bcard-task" style={{ color: 'var(--pass)' }}>On track</div>}
                </button>
              );
            })}
            {rows.length === 0 && <div className="small" style={{ color: 'var(--faint)', padding: '6px 2px' }}>—</div>}
          </div>
        );
      })}
    </div>
  );
}

/* ---- small pieces ---- */
function HealthBar({ states }: { states: ClientState[] }) {
  const n = states.length || 1;
  const b = states.filter((s) => s.status === 'blocked').length;
  const a = states.filter((s) => s.status === 'attention').length;
  const o = n - b - a;
  return (
    <div className="hbar">
      {b > 0 && <span style={{ width: `${(b / n) * 100}%`, background: 'var(--fail)' }} />}
      {a > 0 && <span style={{ width: `${(a / n) * 100}%`, background: 'var(--warn)' }} />}
      {o > 0 && <span style={{ width: `${(o / n) * 100}%`, background: 'var(--pass)' }} />}
    </div>
  );
}
function Legend({ cls, n, label }: { cls: string; n: number; label: string }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)' }}><span className={`dot ${cls}`} />{n} {label}</span>;
}
function MiniStat({ n, label, tone }: { n: number; label: string; tone?: 'pass' | 'warn' | 'fail' }) {
  const color = tone === 'fail' ? 'var(--fail)' : tone === 'warn' ? 'var(--warn)' : tone === 'pass' ? 'var(--pass)' : 'var(--ink)';
  return <div className="card stat"><div className="n" style={{ color }}>{n}</div><div className="l">{label}</div></div>;
}
function daysUntil(d: string) { return Math.round((new Date(d).getTime() - Date.now()) / 86400000); }
