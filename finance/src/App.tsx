/* App.tsx — the Finance HQ shell. Rooms are grouped the way the owner thinks:
   the overview first, then the money itself (in, out, owed, forecast), then
   planning, then the tools that feed it all. One system, not ten tabs. */
import { useEffect, useState } from 'react';
import { Dashboard } from './views/Dashboard';
import { MoneyIn } from './views/MoneyIn';
import { Spending } from './views/Spending';
import { Debt } from './views/Debt';
import { CashFlow } from './views/CashFlow';
import { Pipeline } from './views/Pipeline';
import { Import } from './views/Import';
import { Ask } from './views/Ask';
import { Budgets } from './views/Budgets';
import { Reports } from './views/Reports';
import { BUSINESS } from './lib/client';
import { Toaster } from './components/ui';
import dfLogo from './assets/df/logo-white.png';

interface Room { id: string; label: string; }
interface Group { name: string; rooms: Room[]; }

export const GROUPS: Group[] = [
  { name: '', rooms: [{ id: 'dashboard', label: 'Overview' }] },
  {
    name: 'Money', rooms: [
      { id: 'moneyin', label: 'Money in' },
      { id: 'spending', label: 'Spending' },
      { id: 'debt', label: 'Debt & loans' },
      { id: 'cashflow', label: 'Cash flow' },
    ],
  },
  {
    name: 'Planning', rooms: [
      { id: 'pipeline', label: 'Pipeline' },
      { id: 'budgets', label: 'Budgets & forecast' },
    ],
  },
  {
    name: 'Tools', rooms: [
      { id: 'import', label: 'Import' },
      { id: 'ask', label: 'Ask the data' },
      { id: 'reports', label: 'Board reports' },
    ],
  },
];

const ROOMS: Room[] = GROUPS.flatMap((g) => g.rooms);

const TITLES: Record<string, { h: string; sub: string }> = {
  dashboard: { h: 'Overview', sub: `${BUSINESS.name} — cash, clients, spending and the questions to ask` },
  moneyin: { h: 'Money in', sub: 'Every client: what they pay, on what rhythm, and who has gone quiet' },
  spending: { h: 'Spending', sub: 'Where the money goes — groups, suppliers and the subscription audit' },
  debt: { h: 'Debt & loans', sub: 'Every facility: monthly service, payoff dates, and the hire-vs-paydown call' },
  cashflow: { h: 'Cash flow', sub: '13-week rolling forecast — total & available cash, runway' },
  pipeline: { h: 'Pipeline', sub: 'Agreed vs potential work, weighted by stage' },
  import: { h: 'Import', sub: 'Bank statement, Xero sync or CSV export — all data comes in here' },
  ask: { h: 'Ask the data', sub: 'Interrogate the numbers in plain English' },
  budgets: { h: 'Budgets & forecast', sub: 'Spend layers, variance, cash runway and what-ifs' },
  reports: { h: 'Board reports', sub: 'A board pack from your numbers, with a shareable link' },
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
          <img src={dfLogo} alt="Digital Footprints" style={{ width: 138, display: 'block' }} />
          <div className="eyebrow" style={{ marginTop: 10 }}>Finance HQ</div>
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
          <div className="eyebrow">Business</div>
          <div style={{ fontWeight: 700, fontSize: 14, margin: '6px 0 2px', letterSpacing: '-0.01em' }}>{BUSINESS.name}</div>
          <div className="small" style={{ opacity: 0.7 }}>{BUSINESS.currency} · {BUSINESS.jurisdiction}</div>
        </div>
      </aside>

      <main className="main">
        <div className="page">
          <div className="pagehead">
            <h1>{t.h}</h1>
            <div className="sub">{t.sub}</div>
          </div>
          {view === 'dashboard' && <Dashboard go={go} />}
          {view === 'moneyin' && <MoneyIn go={go} />}
          {view === 'spending' && <Spending go={go} />}
          {view === 'debt' && <Debt go={go} />}
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
