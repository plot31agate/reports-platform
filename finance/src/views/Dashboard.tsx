/* Dashboard.tsx — the first look. Headline KPIs with month-on-month deltas, the
   income/cost/profit trend, where the money goes, and a short read of what the
   numbers are saying. Everything here is deterministic; the judgement calls
   (Ask, scenarios) live one click away. */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { FinanceModel } from '../lib/api';
import { money, moneyShort, delta, pctLabel, runwayMonths } from '../lib/finance';
import { Stat, IncomeCostChart, SpendBars, Working, OfflineNote, Empty } from '../components/ui';
import type { MonthPoint } from '../components/ui';

export function Dashboard({ go }: { go: (v: string) => void }) {
  const [model, setModel] = useState<FinanceModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    api.model().then((m) => {
      if (m === null) setOffline(true); else setModel(m);
      setLoading(false);
    });
  }, []);

  if (loading) return <Working label="Loading the numbers…" />;
  if (offline) return <OfflineNote />;
  if (!model || model.meta.count === 0) return <EmptyState go={go} />;

  const { latest, previous, balance } = model;
  if (!latest) return <EmptyState go={go} />;
  const cur = latest.totals;
  const prv = previous?.totals ?? null;

  // Trailing net average (up to last 3 months) drives the runway read.
  const recent = model.periods.slice(-3);
  const avgNet = recent.reduce((s, p) => s + p.totals.netProfit, 0) / recent.length;
  const runway = balance ? runwayMonths(balance.cash, avgNet) : null;

  const points: MonthPoint[] = model.periods.slice(-12).map((p) => ({
    key: p.key, label: p.label,
    income: p.totals.income, cost: p.totals.cogs + p.totals.opex + p.totals.otherExpense,
    profit: p.totals.netProfit,
  }));

  const topSpend = [...latest.opex, ...latest.cogs]
    .sort((a, b) => b.amount - a.amount).slice(0, 7)
    .map((l) => ({ cap: l.account, amount: l.amount }));

  const alerts = buildAlerts(model, avgNet, runway);

  return (
    <>
      {/* KPI row */}
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Stat n={money(cur.income)} label={`Revenue · ${latest.label}`}
          delta={prv ? { d: delta(cur.income, prv.income), label: pctLabel(delta(cur.income, prv.income)), good: cur.income >= prv.income } : undefined} />
        <Stat n={money(cur.grossProfit)} label="Gross profit"
          note={cur.grossMargin !== null ? `${cur.grossMargin.toFixed(0)}% margin` : undefined}
          delta={prv ? { d: delta(cur.grossProfit, prv.grossProfit), label: pctLabel(delta(cur.grossProfit, prv.grossProfit)), good: cur.grossProfit >= prv.grossProfit } : undefined} />
        <Stat n={money(cur.netProfit)} neg={cur.netProfit < 0} label="Net profit"
          note={cur.netMargin !== null ? `${cur.netMargin.toFixed(0)}% margin` : undefined}
          delta={prv ? { d: delta(cur.netProfit, prv.netProfit), label: pctLabel(delta(cur.netProfit, prv.netProfit)), good: cur.netProfit >= prv.netProfit } : undefined} />
        <Stat n={balance ? money(balance.cash) : '—'} label={balance ? `Cash · ${balance.asAt}` : 'Cash'}
          note={runway !== null ? `~${runway.toFixed(1)} mo runway` : (balance ? 'not burning' : 'import a balance sheet')} />
      </div>

      <div className="grid g2" style={{ alignItems: 'start', marginBottom: 16 }}>
        <div className="card accent-cyan">
          <div className="eyebrow" style={{ color: 'var(--cyan)' }}>Trend</div>
          <h3 style={{ marginBottom: 14 }}>Income, costs & profit</h3>
          <IncomeCostChart points={points} />
        </div>
        <div className="card">
          <div className="eyebrow">Where the money goes</div>
          <h3 style={{ marginBottom: 14 }}>Top spend · {latest.label}</h3>
          <SpendBars rows={topSpend} />
        </div>
      </div>

      <div className="grid g2" style={{ alignItems: 'start' }}>
        <div className="card accent">
          <div className="eyebrow" style={{ color: 'var(--magenta)' }}>What the numbers say</div>
          <h3 style={{ marginBottom: 12 }}>Read</h3>
          {alerts.length === 0 ? <Empty>Nothing notable this month.</Empty> : (
            <div>
              {alerts.map((a, i) => (
                <div className="checkrow" key={i}>
                  <span className={`dot ${a.tone === 'good' ? 'up' : a.tone === 'bad' ? 'down' : 'idle'}`} style={{ marginTop: 6 }} />
                  <span className="name" style={{ fontWeight: 500 }}>{a.text}</span>
                </div>
              ))}
            </div>
          )}
          <div className="row" style={{ marginTop: 16, gap: 10 }}>
            <button className="btn gold" onClick={() => go('ask')}>Ask the data →</button>
            <button className="btn ghost" onClick={() => go('budgets')}>Budgets & forecast</button>
          </div>
        </div>

        <div className="card">
          <div className="eyebrow">Coverage</div>
          <h3 style={{ marginBottom: 12 }}>What's loaded</h3>
          <table className="t">
            <tbody>
              <tr><td style={{ color: 'var(--muted)' }}>Months imported</td><td style={{ textAlign: 'right' }} className="money">{model.meta.count}</td></tr>
              <tr><td style={{ color: 'var(--muted)' }}>Range</td><td style={{ textAlign: 'right' }} className="small">{model.periods[0].label} → {latest.label}</td></tr>
              <tr><td style={{ color: 'var(--muted)' }}>Balance sheet</td><td style={{ textAlign: 'right' }} className="small">{balance ? balance.asAt : 'not imported'}</td></tr>
              <tr><td style={{ color: 'var(--muted)' }}>Money owed to us</td><td style={{ textAlign: 'right' }} className="money">{balance ? moneyShort(balance.debtors) : '—'}</td></tr>
              <tr><td style={{ color: 'var(--muted)' }}>Money we owe</td><td style={{ textAlign: 'right' }} className="money">{balance ? moneyShort(balance.creditors) : '—'}</td></tr>
            </tbody>
          </table>
          <button className="btn ghost sm" style={{ marginTop: 14 }} onClick={() => go('import')}>Import more →</button>
        </div>
      </div>
    </>
  );
}

interface Alert { text: string; tone: 'good' | 'bad' | 'flat'; }

function buildAlerts(model: FinanceModel, avgNet: number, runway: number | null): Alert[] {
  const out: Alert[] = [];
  const { latest, previous, balance } = model;
  if (!latest) return out;
  const cur = latest.totals, prv = previous?.totals;

  if (prv) {
    const dNet = delta(cur.netProfit, prv.netProfit);
    if (dNet.dir !== 'flat') {
      out.push({
        text: `Net profit ${dNet.dir === 'up' ? 'rose' : 'fell'} ${money(Math.abs(dNet.abs))} (${pctLabel(dNet)}) vs ${previous!.label}.`,
        tone: dNet.dir === 'up' ? 'good' : 'bad',
      });
    }
    const curCost = cur.opex + cur.cogs, prvCost = prv.opex + prv.cogs;
    const dCost = delta(curCost, prvCost);
    if (dCost.pct !== null && Math.abs(dCost.pct) >= 8) {
      out.push({
        text: `Total costs ${dCost.dir === 'up' ? 'up' : 'down'} ${money(Math.abs(dCost.abs))} on ${previous!.label}.`,
        tone: dCost.dir === 'up' ? 'bad' : 'good',
      });
    }
    if (cur.grossMargin !== null && prv.grossMargin !== null && Math.abs(cur.grossMargin - prv.grossMargin) >= 3) {
      const up = cur.grossMargin > prv.grossMargin;
      out.push({ text: `Gross margin ${up ? 'improved' : 'slipped'} to ${cur.grossMargin.toFixed(0)}% (from ${prv.grossMargin.toFixed(0)}%).`, tone: up ? 'good' : 'bad' });
    }
  }

  const biggest = [...latest.opex, ...latest.cogs].sort((a, b) => b.amount - a.amount)[0];
  if (biggest && cur.income > 0) {
    out.push({ text: `Biggest cost is ${biggest.account} at ${money(biggest.amount)} — ${(biggest.amount / cur.income * 100).toFixed(0)}% of revenue.`, tone: 'flat' });
  }

  if (balance) {
    if (runway !== null) {
      out.push({ text: `At the recent average, cash of ${money(balance.cash)} lasts about ${runway.toFixed(1)} months — plan ahead.`, tone: runway < 3 ? 'bad' : 'flat' });
    } else if (avgNet >= 0) {
      out.push({ text: `Cash-positive: averaging ${money(avgNet)}/month across the last ${Math.min(3, model.meta.count)} months.`, tone: 'good' });
    }
  }
  return out;
}

function EmptyState({ go }: { go: (v: string) => void }) {
  return (
    <div className="card accent" style={{ textAlign: 'center', padding: '48px 28px' }}>
      <div className="eyebrow" style={{ color: 'var(--magenta)' }}>Nothing loaded yet</div>
      <h2 style={{ fontSize: 26, margin: '10px 0 8px' }}>Bring your first Xero report in</h2>
      <p className="fade" style={{ maxWidth: 460, margin: '0 auto 20px' }}>
        Export a Profit &amp; Loss (and optionally a Balance Sheet) from Xero as CSV,
        drop it into Import, and this dashboard fills in — revenue, profit, cash and the trend.
      </p>
      <button className="btn gold" onClick={() => go('import')}>Go to Import →</button>
    </div>
  );
}
