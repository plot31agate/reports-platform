/* App.tsx — the Finance HQ shell: the same Digital Footprints navy sidebar as
   the client portal, with the rooms ordered the way finance work flows —
   see the numbers, bring numbers in, question them, then plan against them. */
import { useEffect, useState } from 'react';
import { Dashboard } from './views/Dashboard';
import { CashFlow } from './views/CashFlow';
import { Pipeline } from './views/Pipeline';
import { Import } from './views/Import';
import { Ask } from './views/Ask';
import { Budgets } from './views/Budgets';
import { Reports } from './views/Reports';
import { BUSINESS } from './lib/client';
import { Toaster } from './components/ui';
import dfLogo from './assets/df/logo-white.png';

export const ROOMS = [
  { id: 'dashboard', label: 'Dashboard', glyph: '01' },
  { id: 'cashflow', label: 'Cash flow', glyph: '02' },
  { id: 'pipeline', label: 'Pipeline', glyph: '03' },
  { id: 'import', label: 'Import', glyph: '04' },
  { id: 'ask', label: 'Ask the data', glyph: '05' },
  { id: 'budgets', label: 'Budgets & Forecast', glyph: '06' },
  { id: 'reports', label: 'Board Reports', glyph: '07' },
];

const TITLES: Record<string, { h: string; sub: string }> = {
  dashboard: { h: 'Dashboard', sub: `${BUSINESS.name}'s finances, first look` },
  cashflow: { h: 'Cash flow', sub: '13-week rolling forecast — total & available cash, runway' },
  pipeline: { h: 'Pipeline', sub: 'Agreed vs potential work, weighted by stage' },
  import: { h: 'Import', sub: 'Upload Xero reports — profit & loss, balance sheet' },
  ask: { h: 'Ask the data', sub: 'Interrogate the numbers in plain English' },
  budgets: { h: 'Budgets & Forecast', sub: 'Spend layers, variance, cash runway and what-ifs' },
  reports: { h: 'Board Reports', sub: 'A board pack from your numbers, with a shareable link' },
};

function readHash(): string {
  const h = window.location.hash.replace('#', '');
  return ROOMS.some((v) => v.id === h) ? h : 'dashboard';
}

export function App() {
  const [view, setView] = useState(readHash);

  useEffect(() => {
    const onHash = () => setView(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (v: string) => { window.location.hash = v; };
  const t = TITLES[view];

  return (
    <div className="shell">
      <Toaster />
      <aside className="side">
        <div className="brand">
          <img src={dfLogo} alt="Digital Footprints" style={{ width: 148, display: 'block' }} />
          <div className="eyebrow" style={{ marginTop: 12 }}>Finance HQ</div>
        </div>
        <nav>
          {ROOMS.map((v) => (
            <button key={v.id} className={`navlink ${view === v.id ? 'on' : ''}`} onClick={() => go(v.id)}>
              <span className="glyph">{v.glyph}</span>
              {v.label}
            </button>
          ))}
        </nav>
        <div className="clientcard">
          <div className="eyebrow" style={{ color: 'var(--yellow)' }}>Business</div>
          <div style={{ fontWeight: 800, fontSize: 15, margin: '6px 0 2px', letterSpacing: '-0.02em' }}>{BUSINESS.name}</div>
          <div className="small" style={{ color: 'var(--cyan)', fontWeight: 600 }}>{BUSINESS.currency} · {BUSINESS.jurisdiction}</div>
        </div>
      </aside>

      <main className="main">
        <div className="page">
          <div className="pagehead">
            <h1>{t.h}</h1>
            <div className="sub">{t.sub}</div>
          </div>
          {view === 'dashboard' && <Dashboard go={go} />}
          {view === 'cashflow' && <CashFlow go={go} />}
          {view === 'pipeline' && <Pipeline go={go} />}
          {view === 'import' && <Import go={go} />}
          {view === 'ask' && <Ask />}
          {view === 'budgets' && <Budgets />}
          {view === 'reports' && <Reports />}
        </div>
      </main>
    </div>
  );
}
