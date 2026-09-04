/* Spending.tsx — where the money actually goes, in language an owner uses:
   analytic groups (debt service, people, premises…) rather than the bank's
   own categories, the biggest suppliers, and the recurring-subscription
   audit that quietly accumulates money nobody remembers approving. */
import { useState } from 'react';
import { money, moneyShort } from '../lib/finance';
import { useBank } from '../lib/useBank';
import { spendGroups, topSuppliers, subscriptions, monthlyFlows } from '../lib/bank';
import { Stat, SpendBars, Working, OfflineNote, Empty } from '../components/ui';

export function Spending({ go }: { go: (v: string) => void }) {
  const bank = useBank();
  const [subsOpen, setSubsOpen] = useState(true);

  if (bank.loading) return <Working label="Loading spending…" />;
  if (bank.offline) return <OfflineNote />;
  const txs = bank.txs ?? [];
  if (txs.length === 0) return (
    <div className="card" style={{ textAlign: 'center', padding: '44px 28px' }}>
      <div className="eyebrow">No bank data yet</div>
      <h3 style={{ margin: '10px 0 14px' }}>Import a bank statement to see spending here</h3>
      <button className="btn" onClick={() => go('import')}>Go to Import →</button>
    </div>
  );

  const groups = spendGroups(txs);
  const suppliers = topSuppliers(txs, 15);
  const subs = subscriptions(txs);
  const flows = monthlyFlows(txs);
  const asOfMonth = txs[txs.length - 1].date.slice(0, 7);
  const complete = flows.filter((f) => f.key !== asOfMonth);
  const recent = complete.slice(-3);
  const avgOut = recent.length ? recent.reduce((s, f) => s + f.out, 0) / recent.length : 0;
  const totalOut = flows.reduce((s, f) => s + f.out, 0);

  return (
    <>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Stat n={money(totalOut)} label="Spent this year" />
        <Stat n={money(avgOut)} label="Spending / month · 3-mo avg" />
        <Stat n={money(subs.monthlyTotal)} label="Subscriptions / month"
          note={`${subs.rows.length} recurring services`} />
        <Stat n={groups[0] ? money(groups[0].total) : '—'} label="Biggest group"
          note={groups[0]?.group} />
      </div>

      <div className="grid g2" style={{ alignItems: 'start', marginBottom: 16 }}>
        <div className="card">
          <div className="eyebrow">Groups</div>
          <h3 style={{ marginBottom: 14 }}>Spending by group, this year</h3>
          <SpendBars rows={groups.map((g) => ({ cap: g.group, amount: g.total }))} />
        </div>

        <div className="card">
          <div className="eyebrow">Suppliers</div>
          <h3 style={{ marginBottom: 12 }}>Biggest payees</h3>
          <table className="t">
            <thead><tr><th>Payee</th><th>Group</th><th style={{ textAlign: 'right' }}>This year</th></tr></thead>
            <tbody>
              {suppliers.map((s) => (
                <tr key={s.entity}>
                  <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{s.entity}</td>
                  <td className="small fade">{s.group}</td>
                  <td style={{ textAlign: 'right' }} className="money">{money(s.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="spread" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div className="eyebrow">Subscription audit</div>
            <h3>Recurring services · ~{money(subs.monthlyTotal)}/month</h3>
          </div>
          <button className="btn ghost sm" onClick={() => setSubsOpen((o) => !o)}>{subsOpen ? 'Hide' : 'Show'}</button>
        </div>
        {subsOpen && (subs.rows.length === 0 ? <Empty>No recurring subscriptions detected.</Empty> : (
          <table className="t" style={{ marginTop: 12 }}>
            <thead>
              <tr><th>Service</th><th style={{ textAlign: 'right' }}>Charges</th>
                <th style={{ textAlign: 'right' }}>Avg / month</th>
                <th style={{ textAlign: 'right' }}>This year</th>
                <th style={{ textAlign: 'right' }}>Last charged</th></tr>
            </thead>
            <tbody>
              {subs.rows.map((s) => (
                <tr key={s.entity}>
                  <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{s.entity}</td>
                  <td style={{ textAlign: 'right' }} className="money">{s.charges}</td>
                  <td style={{ textAlign: 'right' }} className="money">{moneyShort(s.avgMonthly)}</td>
                  <td style={{ textAlign: 'right' }} className="money">{money(s.total)}</td>
                  <td style={{ textAlign: 'right' }} className="small">{s.lastSeen}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
        <div className="small fade" style={{ marginTop: 12 }}>
          Detected from card-subscription charges and suppliers billing in three or more months.
          The fastest saving in most agencies is cancelling three of these.
        </div>
      </div>
    </>
  );
}
