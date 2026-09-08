/* App.tsx — the Agency HQ shell. Same bones as Finance HQ: a navy sidebar of
   rooms, a snapshot-first overview, and everything derived from the reporting
   core + roster. One system for running every client, not a folder per client. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadSnapshot } from './lib/api';
import { deriveAll, totals as computeTotals, rosterFromSnapshot } from './lib/agency';
import type { Snapshot, ClientState } from './lib/agency';
import { effectiveRoster } from './lib/rosterStore';
import { makeStore } from './lib/store';
import { demoStates } from './lib/demo';
import { Overview } from './views/Overview';
import { ThisWeek } from './views/ThisWeek';
import { Strategy } from './views/Strategy';
import { Reminders } from './views/Reminders';
import { Clients } from './views/Clients';
import { ClientSheet } from './views/ClientSheet';
import { Toaster, OfflineNote } from './components/ui';
import dfLogo from './assets/df/logo-white.png';

interface Room { id: string; label: string; }
interface Group { name: string; rooms: Room[]; }

const GROUPS: Group[] = [
  { name: '', rooms: [{ id: 'overview', label: 'Overview' }] },
  { name: 'Delivery', rooms: [
    { id: 'week', label: 'This week' },
    { id: 'strategy', label: 'Strategy plans' },
  ] },
  { name: 'Roster', rooms: [
    { id: 'clients', label: 'Clients' },
  ] },
  { name: 'Automation', rooms: [
    { id: 'reminders', label: 'Reminders' },
  ] },
];
const ROOMS = GROUPS.flatMap((g) => g.rooms);

const TITLES: Record<string, { h: string; sub: string }> = {
  overview: { h: 'Overview', sub: 'Every client, one snapshot — status, what’s due, and how the story reads today' },
  week: { h: 'This week', sub: 'Everything due across the whole roster — as a list or a calendar' },
  strategy: { h: 'Strategy plans', sub: 'Every client’s plan and how fresh it is — stale plans surface themselves' },
  clients: { h: 'Clients', sub: 'The roster itself — add clients and set their strategy plans' },
  reminders: { h: 'Reminders', sub: 'The morning digest and the rules that generate the nudges' },
};

function readHash(): string {
  const h = window.location.hash.replace('#', '');
  return ROOMS.some((v) => v.id === h) ? h : 'overview';
}

export function App() {
  const [view, setView] = useState(readHash);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  // Bumped whenever the Clients room mutates the roster overlay, to re-derive.
  const [rosterVersion, setRosterVersion] = useState(0);

  useEffect(() => {
    const onHash = () => setView(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const reload = useCallback(() => loadSnapshot().then((s) => { setSnapshot(s); setLoaded(true); }), []);
  useEffect(() => { reload(); }, [reload]);

  // Online = the reporting core answered with a live snapshot; then the DB owns
  // the roster and writes go to the API. Offline (static preview / backend down)
  // the roster falls back to config + the localStorage overlay.
  const online = snapshot !== null;
  const store = useMemo(
    () => makeStore({
      online,
      vaultReady: !!snapshot?.vault_ready,
      refresh: online ? reload : () => setRosterVersion((v) => v + 1),
    }),
    [online, snapshot?.vault_ready, reload],
  );

  // ?demo=N pads the roster with synthetic clients so the triage UX can be
  // judged at scale. Real roster only when the param is absent.
  const demoN = Number(new URLSearchParams(window.location.search).get('demo') || 0);
  const states: ClientState[] = useMemo(() => {
    const roster = snapshot ? rosterFromSnapshot(snapshot) : effectiveRoster();
    const real = deriveAll(snapshot, roster);
    if (!demoN) return real;
    const extra = demoStates(demoN - real.length, new Date());
    return [...real, ...extra];
    // rosterVersion re-derives after offline Clients-room edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, demoN, rosterVersion]);
  const totals = useMemo(() => computeTotals(states), [states]);
  const openState = openSlug ? states.find((s) => s.client.slug === openSlug) ?? null : null;

  const go = (v: string) => { window.location.hash = v; };
  const t = TITLES[view];

  return (
    <div className="shell">
      <Toaster />
      <aside className="side">
        <div className="brand">
          <img src={dfLogo} alt="Digital Footprints" style={{ width: 138, display: 'block' }} />
          <div className="eyebrow" style={{ marginTop: 10 }}>Agency HQ</div>
        </div>
        <nav>
          {GROUPS.map((g) => (
            <div className="navgroup" key={g.name || 'top'}>
              {g.name && <div className="navlabel">{g.name}</div>}
              {g.rooms.map((v) => (
                <button key={v.id} className={`navlink ${view === v.id ? 'on' : ''}`} onClick={() => go(v.id)}>
                  {v.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="clientcard">
          <div className="eyebrow">Portfolio</div>
          <div style={{ fontWeight: 700, fontSize: 14, margin: '6px 0 2px', letterSpacing: '-0.01em' }}>{states.length} clients</div>
          <div className="small" style={{ opacity: 0.7 }}>
            {totals.blocked ? `${totals.blocked} blocked · ${totals.dueThisWeek} due` : totals.dueThisWeek ? `${totals.dueThisWeek} due this week` : 'all on track'}
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="page">
          <div className="pagehead">
            <h1>{t.h}</h1>
            <div className="sub">{t.sub}</div>
          </div>

          {demoN > 0 && (
            <div className="card accent" style={{ marginBottom: 16, borderLeft: '3px solid var(--cyan)', padding: '10px 14px' }}>
              <span className="eyebrow" style={{ color: 'var(--cyan)' }}>Scale preview</span>
              <span className="small" style={{ color: 'var(--muted)', marginLeft: 10 }}>
                Padded to {states.length} synthetic clients to show the layout at scale — drop <code>?demo</code> for the real roster.
              </span>
            </div>
          )}
          {loaded && !snapshot && !demoN && <div style={{ marginBottom: 16 }}><OfflineNote /></div>}

          {view === 'overview' && <Overview states={states} totals={totals} onOpen={setOpenSlug} go={go} />}
          {view === 'week' && <ThisWeek states={states} onOpen={setOpenSlug} />}
          {view === 'strategy' && <Strategy states={states} onOpen={setOpenSlug} />}
          {view === 'clients' && <Clients states={states} store={store} snapshot={snapshot} onOpen={setOpenSlug} />}
          {view === 'reminders' && <Reminders states={states} />}
        </div>
      </main>

      {openState && <ClientSheet key={openState.client.slug} state={openState} store={store} snapshot={snapshot} onClose={() => setOpenSlug(null)} />}
    </div>
  );
}
