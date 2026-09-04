/* Spending.tsx — where the money actually goes, and what to DO about it.
   Groups and payees are cash figures (VAT-inclusive where the supplier bills
   UK VAT); the subscription audit estimates the ex-VAT cost too, since
   reclaimable VAT isn't real cost to a VAT-registered business — and every
   service carries a suggested action, rolled up into concrete next steps.
   Conference/event activity lives here as planned spend the statement can't
   see yet, with a push into the 13-week cash-flow forecast. */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money, moneyShort } from '../lib/finance';
import { useBank } from '../lib/useBank';
import {
  spendGroups, topSuppliers, subscriptions, subscriptionNextSteps, monthlyFlows,
  eventGross, eventNet, eventActuals, buildDigest,
} from '../lib/bank';
import type { BizEvent } from '../lib/bank';
import { Stat, SpendBars, Working, OfflineNote, Empty, toast } from '../components/ui';

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
  const steps = subscriptionNextSteps(subs.rows);
  const flows = monthlyFlows(txs);
  const asOfMonth = txs[txs.length - 1].date.slice(0, 7);
  const complete = flows.filter((f) => f.key !== asOfMonth);
  const recent = complete.slice(-3);
  const avgOut = recent.length ? recent.reduce((s, f) => s + f.out, 0) / recent.length : 0;
  const totalOut = flows.reduce((s, f) => s + f.out, 0);

  return (
    <>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Stat n={money(totalOut)} label="Spent this year" note="cash out, VAT-inclusive" />
        <Stat n={money(avgOut)} label="Spending / month · 3-mo avg" />
        <Stat n={money(subs.monthlyTotal)} label="Subscriptions / month"
          note={`~${moneyShort(subs.exVatMonthlyTotal)} ex-VAT · ${subs.rows.length} services`} />
        <Stat n={groups[0] ? money(groups[0].total) : '—'} label="Biggest group"
          note={groups[0]?.group} />
      </div>

      <EventsCard bank={bank} txs={txs} onSaved={bank.refresh} />

      {steps.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="eyebrow">Do these</div>
          <h3 style={{ marginBottom: 10 }}>Next steps on spending</h3>
          {steps.map((s, i) => (
            <div className="checkrow" key={i}>
              <span className="num-step">{i + 1}</span>
              <span className="name" style={{ fontWeight: 450 }}>{s}</span>
            </div>
          ))}
        </div>
      )}

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
            <h3>Recurring services · {money(subs.monthlyTotal)}/mo gross, ~{money(subs.exVatMonthlyTotal)}/mo ex-VAT</h3>
          </div>
          <button className="btn ghost sm" onClick={() => setSubsOpen((o) => !o)}>{subsOpen ? 'Hide' : 'Show'}</button>
        </div>
        {subsOpen && (subs.rows.length === 0 ? <Empty>No recurring subscriptions detected.</Empty> : (
          <table className="t" style={{ marginTop: 12 }}>
            <thead>
              <tr><th>Service</th>
                <th style={{ textAlign: 'right' }}>Charges</th>
                <th style={{ textAlign: 'right' }}>Gross / mo</th>
                <th style={{ textAlign: 'right' }}>Ex-VAT / mo</th>
                <th>Suggested action</th></tr>
            </thead>
            <tbody>
              {subs.rows.map((s) => (
                <tr key={s.entity}>
                  <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{s.entity}</td>
                  <td style={{ textAlign: 'right' }} className="money">{s.charges}</td>
                  <td style={{ textAlign: 'right' }} className="money">{moneyShort(s.avgMonthly)}</td>
                  <td style={{ textAlign: 'right' }} className="money">
                    {moneyShort(s.exVatMonthly)}{!s.ukVat && <span className="fade small"> *</span>}
                  </td>
                  <td className="small fade">{s.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
        <div className="small fade" style={{ marginTop: 12 }}>
          Ex-VAT assumes 20% UK VAT in the price where the supplier bills it — reclaimable if you're
          VAT-registered, so it's the truer cost. * marked services bill from overseas under reverse
          charge (no UK VAT in the price). Estimates from the statement, not invoices — your accountant's
          VAT return is the authority.
        </div>
      </div>
    </>
  );
}

/* ---- Conference & event activity ----
   Planned spend (flights, hotel, ticket) with a client contribution, a net
   cost, actuals matched from the statement once the dates pass, and a
   one-click push of the lines into the 13-week cash-flow forecast. */
function EventsCard({ bank, txs, onSaved }: {
  bank: ReturnType<typeof useBank>;
  txs: NonNullable<ReturnType<typeof useBank>['txs']>;
  onSaved: () => void;
}) {
  const [events, setEvents] = useState<BizEvent[]>(bank.events);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setEvents(bank.events); setDirty(false); }, [bank.events]);

  const upd = (i: number, patch: Partial<BizEvent>) => {
    setEvents(events.map((e, j) => (j === i ? { ...e, ...patch } : e)));
    setDirty(true);
  };

  function addEvent() {
    setEvents([...events, {
      id: Array.from(crypto.getRandomValues(new Uint8Array(6))).map((b) => b.toString(16).padStart(2, '0')).join(''),
      name: '', location: '', start: '', end: '', client: '', clientContribution: 0,
      items: [{ label: 'Flights', amount: 0 }, { label: 'Hotel', amount: 0 }, { label: 'Ticket / stand', amount: 0 }],
    }]);
    setDirty(true);
  }

  async function save() {
    const clean = events.filter((e) => e.name.trim() !== '');
    const r = await api.bankEvents(clean);
    if (!r?.ok) { toast('Could not save'); return; }
    await api.bankDigest(buildDigest(txs, { spaces: bank.spaces, events: r.events, answers: bank.answers }));
    toast('Events saved');
    onSaved();
  }

  async function pushToCashflow(e: BizEvent) {
    if (!e.start) { toast('Set a start date first'); return; }
    let added = 0;
    for (const it of e.items) {
      if (it.amount <= 0) continue;
      await api.cashflowAdd('payment', {
        label: `${e.name}: ${it.label}`, category: 'Event', client: '',
        amount: it.amount, cadence: 'once', date: e.start, until: '', note: e.location,
      });
      added++;
    }
    if (e.clientContribution > 0) {
      await api.cashflowAdd('receipt', {
        label: `${e.name}: ${e.client || 'client'} contribution`, category: 'Event', client: e.client,
        amount: e.clientContribution, cadence: 'once', date: e.end || e.start, until: '', note: 'invoice after the event',
      });
      added++;
    }
    toast(added > 0 ? `${added} lines pushed to the 13-week cash flow` : 'Nothing to push — add amounts first');
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="spread" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div className="eyebrow">Conference &amp; event activity</div>
          <h3>Planned events</h3>
        </div>
        <button className="btn ghost sm" onClick={addEvent}>+ Add an event</button>
      </div>
      {events.length === 0 && (
        <Empty>
          Track a conference or trip here: budget the flights/hotel/ticket, record what a client
          covers, push the lines into the cash-flow forecast — and the Overview will chase the
          booking and the invoice at the right moments.
        </Empty>
      )}
      {events.map((e, i) => {
        const past = e.end && e.end < txs[txs.length - 1].date;
        const actual = past ? eventActuals(txs, e) : 0;
        return (
          <div className="eventblock" key={e.id}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input className="inp" style={{ flex: 2, minWidth: 180 }} placeholder="Event name"
                value={e.name} onChange={(ev) => upd(i, { name: ev.target.value })} />
              <input className="inp" style={{ flex: 1, minWidth: 120 }} placeholder="Location"
                value={e.location} onChange={(ev) => upd(i, { location: ev.target.value })} />
              <input className="inp" style={{ width: 140 }} type="date"
                value={e.start} onChange={(ev) => upd(i, { start: ev.target.value })} />
              <input className="inp" style={{ width: 140 }} type="date"
                value={e.end} onChange={(ev) => upd(i, { end: ev.target.value })} />
            </div>
            <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              {e.items.map((it, j) => (
                <div key={j} style={{ width: 130 }}>
                  <label className="f">{it.label}</label>
                  <input className="inp num" placeholder="0" value={it.amount || ''}
                    onChange={(ev) => upd(i, { items: e.items.map((x, k) => k === j ? { ...x, amount: Number(ev.target.value) || 0 } : x) })} />
                </div>
              ))}
              <div style={{ width: 150 }}>
                <label className="f">Client covers</label>
                <input className="inp num" placeholder="0" value={e.clientContribution || ''}
                  onChange={(ev) => upd(i, { clientContribution: Number(ev.target.value) || 0 })} />
              </div>
              <div style={{ width: 150 }}>
                <label className="f">Which client</label>
                <input className="inp" placeholder="e.g. Vivo" value={e.client}
                  onChange={(ev) => upd(i, { client: ev.target.value })} />
              </div>
            </div>
            <div className="spread" style={{ marginTop: 10, flexWrap: 'wrap', gap: 10 }}>
              <div className="small">
                Budget <span className="money">{money(eventGross(e))}</span>
                {e.clientContribution > 0 && <> · client covers <span className="money">{money(e.clientContribution)}</span> · net <span className="money">{money(eventNet(e))}</span></>}
                {past ? <> · actual travel/marketing spend around the dates: <span className="money">{money(actual)}</span></> : null}
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn ghost sm" onClick={() => pushToCashflow(e)}>Push to cash flow →</button>
                <button className="linky" onClick={() => { setEvents(events.filter((_, j) => j !== i)); setDirty(true); }}>remove</button>
              </div>
            </div>
          </div>
        );
      })}
      {dirty && <button className="btn sm" style={{ marginTop: 4 }} onClick={save}>Save events</button>}
    </div>
  );
}
