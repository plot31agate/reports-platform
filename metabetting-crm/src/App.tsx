/* App.tsx — Meta Betting CRM Snapshot. Same shell as Agency HQ (navy sidebar
   of rooms, DF analytical theme). v1 is counts-only and fully local: state in
   localStorage, JSON export/import per meeting, no network calls. */
import { useEffect, useState } from 'react';
import { blankSnapshot, exampleSnapshot } from './lib/model';
import { dataRequests, readiness } from './lib/calc';
import { SEGMENTS } from './lib/model';
import { download, exportName, pickJSON, useSnapshot } from './lib/store';
import { Toaster, toast } from './components/ui';
import { Audit } from './views/Audit';
import { Inputs } from './views/Inputs';
import { Overview } from './views/Overview';
import { Segments } from './views/Segments';
import { Abuse } from './views/Abuse';
import { Opportunity } from './views/Opportunity';
import { Roadmap } from './views/Roadmap';
import { Summary } from './views/Summary';
import dfLogo from './assets/df/logo-white.png';

interface Room { id: string; label: string; glyph: string; }
const GROUPS: { name: string; rooms: Room[] }[] = [
  { name: 'Capture', rooms: [
    { id: 'audit', label: 'Data audit', glyph: '3.1' },
    { id: 'inputs', label: 'Funnel inputs', glyph: '3.2' },
  ] },
  { name: 'Analyse', rooms: [
    { id: 'overview', label: 'Overview', glyph: '3.3' },
    { id: 'segments', label: 'Segments', glyph: '3.4' },
    { id: 'abuse', label: 'Bonus abuse rules', glyph: '3.5' },
    { id: 'opportunity', label: 'Opportunity', glyph: '3.6' },
  ] },
  { name: 'Share', rooms: [
    { id: 'roadmap', label: 'Roadmap', glyph: '3.7' },
    { id: 'summary', label: 'Client summary', glyph: '3.8' },
  ] },
];
const ROOMS = GROUPS.flatMap((g) => g.rooms);
const TITLES: Record<string, { h: string; sub: string }> = {
  audit: { h: 'Data audit', sub: 'What exists in Customer.io today: status, the name it lives under, and notes. Drives readiness and the Swifty request list.' },
  inputs: { h: 'Funnel inputs', sub: 'Counts only. Leave anything blank you don’t have yet.' },
  overview: { h: 'Overview', sub: 'Conversion, the biggest drop-off, genuine players and who we can legally market to' },
  segments: { h: 'Segment priority', sub: 'What to build in Customer.io, in order, and whether the data is there to build it' },
  abuse: { h: 'Bonus abuse rules', sub: 'A worksheet for the abuse_risk score or flag' },
  opportunity: { h: 'Opportunity estimator', sub: 'Where we can take it: small conversion gains on genuine players' },
  roadmap: { h: 'Build roadmap', sub: 'Generated from readiness and priority' },
  summary: { h: 'Client summary', sub: 'One page to print or paste' },
};

const readHash = () => { const h = window.location.hash.replace('#', ''); return ROOMS.some((r) => r.id === h) ? h : 'audit'; };

export function App() {
  const { snap, update, replace, compare, setCompare } = useSnapshot();
  const [view, setView] = useState(readHash);
  useEffect(() => {
    const on = () => setView(readHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => { document.querySelector('.main')?.scrollTo(0, 0); }, [view]);
  const go = (v: string) => { window.location.hash = v; };

  const ready = SEGMENTS.filter((d) => readiness(snap, d).ready).length;
  const reqs = dataRequests(snap).length;
  const t = TITLES[view];

  const doImport = () => pickJSON()
    .then((s) => { replace(s); toast(`Loaded snapshot ${s.meta.snapshotDate || ''}`); })
    .catch((e) => { if (e?.message !== 'No file') toast(e.message); });
  const doReset = () => { if (confirm('Clear every field in this snapshot? Export JSON first if you want to keep it.')) { replace(blankSnapshot()); toast('Snapshot cleared'); } };
  const doExample = () => { if (confirm('Replace the current snapshot with EXAMPLE (dummy) data?')) { replace(exampleSnapshot()); toast('Example data loaded'); } };

  return (
    <div className="shell">
      <Toaster />
      <aside className="side no-print">
        <div className="brand">
          <img src={dfLogo} alt="Digital Footprints" style={{ width: 138, display: 'block' }} />
          <div className="eyebrow" style={{ marginTop: 10 }}>Meta Betting · CRM Snapshot</div>
        </div>
        <nav>
          {GROUPS.map((g) => (
            <div className="navgroup" key={g.name}>
              <div className="navlabel">{g.name}</div>
              {g.rooms.map((r) => (
                <button key={r.id} className={`navlink ${view === r.id ? 'on' : ''}`} onClick={() => go(r.id)}>
                  <span className="glyph">{r.glyph}</span>{r.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="clientcard">
          <div className="eyebrow">This snapshot</div>
          <div style={{ fontWeight: 700, fontSize: 14, margin: '6px 0 2px' }}>{snap.meta.snapshotDate || 'Undated'}</div>
          <div className="small" style={{ opacity: 0.7 }}>{ready}/{SEGMENTS.length} segments ready · {reqs} data requests</div>
          <div className="small" style={{ opacity: 0.5, marginTop: 6 }}>Stored in this browser only</div>
        </div>
      </aside>

      <main className="main">
        {snap.meta.isExample && (
          <div className="example-bar no-print">
            <b>EXAMPLE DATA</b>: dummy figures for demos, not Meta Betting's real numbers. <button className="linky" style={{ color: 'inherit' }} onClick={doReset}>Reset to clear</button>
          </div>
        )}
        <div className="page">
          <div className="toolbar no-print">
            <div className="meta">
              <input className="inp" style={{ width: 170 }} value={snap.meta.client} onChange={(e) => update((s) => { s.meta.client = e.target.value; return s; })} aria-label="Client" />
              <input className="inp" type="date" style={{ width: 150 }} value={snap.meta.snapshotDate} onChange={(e) => update((s) => { s.meta.snapshotDate = e.target.value; return s; })} aria-label="Snapshot date" />
              <input className="inp" style={{ flex: 1, minWidth: 160 }} placeholder="Notes (meeting, who was there…)" value={snap.meta.notes} onChange={(e) => update((s) => { s.meta.notes = e.target.value; return s; })} />
            </div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <button className="btn sm" onClick={() => { download(exportName(snap), JSON.stringify(snap, null, 2)); toast('Snapshot exported'); }}>Export JSON</button>
              <button className="btn ghost sm" onClick={doImport}>Import JSON</button>
              <button className="btn ghost sm" onClick={doExample}>Load example data (dummy)</button>
              <button className="btn ghost sm" onClick={doReset}>Reset</button>
            </div>
          </div>

          <div className="pagehead no-print">
            <h1>{t.h}</h1>
            <div className="sub">{t.sub}</div>
          </div>

          {view === 'audit' && <Audit snap={snap} update={update} />}
          {view === 'inputs' && <Inputs snap={snap} update={update} />}
          {view === 'overview' && <Overview snap={snap} />}
          {view === 'segments' && <Segments snap={snap} update={update} />}
          {view === 'abuse' && <Abuse snap={snap} update={update} />}
          {view === 'opportunity' && <Opportunity snap={snap} update={update} />}
          {view === 'roadmap' && <Roadmap snap={snap} />}
          {view === 'summary' && <Summary snap={snap} compare={compare} setCompare={setCompare} />}
        </div>
      </main>
    </div>
  );
}
