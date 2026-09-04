/* Dashboard.tsx — the Overview: one screen that ties the two sources of truth
   together. The bank statement is the cash truth (what actually arrived and
   left), Xero is the accounting truth (P&L). Headlines, the flow trend, the
   watchlist of clients gone quiet, and the questions the data raises this
   week all come from the bank; the P&L strip beneath reconciles it against
   the imported Xero months when they exist. */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { FinanceModel } from '../lib/api';
import { money, moneyShort, delta, pctLabel } from '../lib/finance';
import { useBank } from '../lib/useBank';
import {
  monthlyFlows, clientRows, spendGroups, loans, computeQuestions,
} from '../lib/bank';
import type { Enriched } from '../lib/bank';
import { Stat, IncomeCostChart, SpendBars, Working, OfflineNote, Empty } from '../components/ui';
import type { MonthPoint } from '../components/ui';

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

export function Dashboard({ go }: { go: (v: string) => void }) {
  const bank = useBank();
  const [model, setModel] = useState<FinanceModel | null>(null);
  useEffect(() => { api.model().then((m) => m && setModel(m)); }, []);

  if (bank.loading) return <Working label="Loading the numbers…" />;
  if (bank.offline) return <OfflineNote />;
  const txs = bank.txs ?? [];
  if (txs.length === 0) return <EmptyState go={go} hasXero={!!model && model.meta.count > 0} model={model} />;

  return (
    <>
      <BankHeadlines txs={txs} />
      <div className="grid g2" style={{ alignItems: 'start', marginBottom: 16 }}>
        <div className="card">
          <div className="eyebrow">Cash flow · actuals</div>
          <h3 style={{ marginBottom: 14 }}>Money in vs out, by month</h3>
          <FlowChart txs={txs} />
        </div>
        <QuestionsCard txs={txs} go={go} />
      </div>
      <div className="grid g2" style={{ alignItems: 'start', marginBottom: 16 }}>
        <WatchlistCard txs={txs} go={go} />
        <SpendGroupsCard txs={txs} go={go} />
      </div>
      {model && model.meta.count > 0 && <XeroStrip model={model} go={go} />}
    </>
  );
}

/* ---- KPI row from the bank data ---- */
function BankHeadlines({ txs }: { txs: Enriched[] }) {
  const flows = monthlyFlows(txs);
  const asOf = txs[txs.length - 1].date;
  const asOfMonth = asOf.slice(0, 7);
  const complete = flows.filter((f) => f.key !== asOfMonth);
  const latest = complete[complete.length - 1];
  const prev = complete[complete.length - 2];
  const recent = complete.slice(-3);
  const avgNet = recent.length ? recent.reduce((s, f) => s + f.net, 0) / recent.length : 0;
  const ls = loans(txs);
  const debtMonthly = ls.reduce((s, l) => s + l.recentMonthly, 0);
  const cash = txs[txs.length - 1].balance;

  return (
    <div className="grid g4" style={{ marginBottom: 16 }}>
      <Stat n={money(cash)} label={`Cash in bank · ${asOf}`}
        note={avgNet < 0 ? `~${(cash / -avgNet).toFixed(1)} mo at current burn` : 'cash-positive on average'} />
      <Stat n={latest ? money(latest.in) : '—'} label={`Client revenue · ${latest ? monthLabel(latest.key) : ''}`}
        delta={latest && prev ? { d: delta(latest.in, prev.in), label: pctLabel(delta(latest.in, prev.in)), good: latest.in >= prev.in } : undefined} />
      <Stat n={money(avgNet)} neg={avgNet < 0} label="Net cash / month · 3-mo avg"
        note={recent.length ? recent.map((f) => moneyShort(f.net)).join(' · ') : undefined} />
      <Stat n={money(debtMonthly)} label="Debt service / month"
        note={latest && latest.out > 0 ? `${Math.round((debtMonthly / (recent.reduce((s, f) => s + f.out, 0) / Math.max(1, recent.length))) * 100)}% of spending` : undefined} />
    </div>
  );
}

function FlowChart({ txs }: { txs: Enriched[] }) {
  const flows = monthlyFlows(txs).slice(-12);
  const points: MonthPoint[] = flows.map((f) => ({
    key: f.key, label: monthLabel(f.key), income: f.in, cost: f.out, profit: f.net,
  }));
  return <IncomeCostChart points={points} labels={['Money in', 'Money out', 'Net']} />;
}

/* ---- The questions the data raises ---- */
function QuestionsCard({ txs, go }: { txs: Enriched[]; go: (v: string) => void }) {
  const qs = computeQuestions(txs);
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="card">
      <div className="eyebrow">Oversight</div>
      <h3 style={{ marginBottom: 12 }}>Questions to ask this week</h3>
      {qs.length === 0 ? <Empty>Nothing pressing — the data raises no flags right now.</Empty> : (
        <div>
          {qs.map((q, i) => (
            <div className="qrow" key={i}>
              <button className="qhead" onClick={() => setOpen(open === i ? null : i)}>
                <span className={`dot ${q.tone === 'bad' ? 'down' : q.tone === 'warn' ? 'warn' : 'idle'}`} />
                <span className="qtext">{q.q}</span>
                <span className="qcaret">{open === i ? '−' : '+'}</span>
              </button>
              {open === i && <div className="qwhy">{q.why}</div>}
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ marginTop: 14, gap: 10 }}>
        <button className="btn" onClick={() => go('ask')}>Interrogate the data →</button>
      </div>
    </div>
  );
}

/* ---- Clients gone quiet / late ---- */
function WatchlistCard({ txs, go }: { txs: Enriched[]; go: (v: string) => void }) {
  const { rows } = clientRows(txs);
  const watch = rows.filter((r) => (r.status === 'quiet' || r.status === 'late') && r.medianMonthly >= 200);
  const fine = rows.filter((r) => r.status === 'ontrack').length;
  return (
    <div className="card">
      <div className="eyebrow">Watchlist</div>
      <h3 style={{ marginBottom: 12 }}>Clients gone quiet</h3>
      {watch.length === 0 ? <Empty>Every regular payer is on their usual cadence.</Empty> : (
        <table className="t">
          <thead><tr><th>Client</th><th style={{ textAlign: 'right' }}>Typical / mo</th><th style={{ textAlign: 'right' }}>Last paid</th><th></th></tr></thead>
          <tbody>
            {watch.map((r) => (
              <tr key={r.entity}>
                <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{r.entity}</td>
                <td style={{ textAlign: 'right' }} className="money">{money(r.medianMonthly)}</td>
                <td style={{ textAlign: 'right' }} className="small">{r.lastPaid} <span className="fade">({r.daysSince}d)</span></td>
                <td style={{ textAlign: 'right' }}><span className={`pill ${r.status === 'quiet' ? 'fail' : 'warn'}`}>{r.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="small fade" style={{ marginTop: 10 }}>{fine} client{fine === 1 ? '' : 's'} paying on their usual cadence.</div>
      <button className="btn ghost sm" style={{ marginTop: 12 }} onClick={() => go('moneyin')}>All clients →</button>
    </div>
  );
}

/* ---- Where the money goes ---- */
function SpendGroupsCard({ txs, go }: { txs: Enriched[]; go: (v: string) => void }) {
  const groups = spendGroups(txs).slice(0, 8);
  return (
    <div className="card">
      <div className="eyebrow">Where the money goes</div>
      <h3 style={{ marginBottom: 14 }}>Spending this year, by group</h3>
      <SpendBars rows={groups.map((g) => ({ cap: g.group, amount: g.total }))} />
      <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => go('spending')}>Full breakdown →</button>
    </div>
  );
}

/* ---- Xero reconciliation strip ---- */
function XeroStrip({ model, go }: { model: FinanceModel; go: (v: string) => void }) {
  const latest = model.latest;
  if (!latest) return null;
  const t = latest.totals;
  return (
    <div className="card">
      <div className="spread" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div className="eyebrow">Accounting view · Xero</div>
          <h3>P&amp;L · {latest.label}</h3>
        </div>
        <div className="row" style={{ gap: 28, flexWrap: 'wrap' }}>
          <MiniKpi label="Revenue" v={money(t.income)} />
          <MiniKpi label="Gross profit" v={money(t.grossProfit)} note={t.grossMargin !== null ? `${t.grossMargin.toFixed(0)}%` : undefined} />
          <MiniKpi label="Net profit" v={money(t.netProfit)} neg={t.netProfit < 0} note={t.netMargin !== null ? `${t.netMargin.toFixed(0)}%` : undefined} />
          <button className="btn ghost sm" onClick={() => go('reports')}>Board report →</button>
        </div>
      </div>
      <div className="small fade" style={{ marginTop: 10 }}>
        The bank view above is cash (when money moved); this is the accounting view (when it was earned).
        Differences are timing — unpaid invoices, VAT set aside, accruals.
      </div>
    </div>
  );
}

function MiniKpi({ label, v, note, neg }: { label: string; v: string; note?: string; neg?: boolean }) {
  return (
    <div>
      <div className="money" style={{ fontSize: 20, color: neg ? 'var(--fail)' : undefined }}>{v}</div>
      <div className="small fade">{label}{note ? ` · ${note}` : ''}</div>
    </div>
  );
}

function EmptyState({ go, hasXero, model }: { go: (v: string) => void; hasXero: boolean; model: FinanceModel | null }) {
  return (
    <>
      <div className="card" style={{ textAlign: 'center', padding: '48px 28px', marginBottom: 16 }}>
        <div className="eyebrow">No bank data yet</div>
        <h2 style={{ fontSize: 24, margin: '10px 0 8px' }}>Import a bank statement to switch this on</h2>
        <p className="fade" style={{ maxWidth: 520, margin: '0 auto 20px' }}>
          Export a CSV statement from Starling (Home → Statements), drop it into Import, and this
          overview fills in: cash, client payment patterns, spending groups, debt service and the
          questions worth asking each week.
        </p>
        <button className="btn" onClick={() => go('import')}>Go to Import →</button>
      </div>
      {hasXero && model && <XeroStrip model={model} go={go} />}
    </>
  );
}
