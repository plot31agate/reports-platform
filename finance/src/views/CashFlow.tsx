/* CashFlow.tsx — a 13-week rolling forecast of the bank. Opening balance →
   expected receipts → committed payments → closing balance, week by week. The
   headline is the closing line; two figures sit above it — Total cash and
   Available cash (total minus the ring-fenced VAT set-aside, shown separately so
   it never flatters the position). Won pipeline work is the receipts floor; open
   opportunities toggled into the forecast draw the dashed scenario line. */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { CashflowData, CashItem, Cadence } from '../lib/api';
import { money, moneyShort } from '../lib/finance';
import { CashFlowChart, Working, Empty, OfflineNote, toast } from '../components/ui';
import type { CashWeekPoint } from '../components/ui';

const CADENCES: [Cadence, string][] = [
  ['once', 'One-off'], ['weekly', 'Weekly'], ['fortnightly', 'Fortnightly'],
  ['4weekly', '4-weekly'], ['monthly', 'Monthly'], ['quarterly', 'Quarterly'],
];
const PAY_CATEGORIES = ['payroll', 'contractors', 'vat', 'paye', 'hmrc-ttp', 'ccs', 'lease', 'software', 'other'];

export function CashFlow({ go }: { go: (v: string) => void }) {
  const [data, setData] = useState<CashflowData | null>(null);
  const [offline, setOffline] = useState(false);
  useEffect(() => { api.cashflow().then((d) => d === null ? setOffline(true) : setData(d)); }, []);

  if (offline) return <OfflineNote />;
  if (!data) return <Working label="Building the forecast…" />;

  const h = data.headline;
  const hasScenario = data.included.length > 0;
  const points: CashWeekPoint[] = data.weeks.map((w) => ({ label: w.label, committed: w.closingCommitted, scenario: w.closingScenario }));

  return (
    <>
      {/* Headline: total vs available, VAT shown separately, runway */}
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Tile n={money(h.totalCash)} label="Total cash" note={data.settings.usingBalanceCash ? 'from balance sheet' : 'set manually'} />
        <Tile n={money(h.availableCash)} label="Available cash" note="total − VAT set-aside" />
        <Tile n={money(h.vatSetAside)} label="VAT set-aside" note="ring-fenced (Starling Space)" />
        <Tile n={h.runwayWeeks !== null ? `${h.runwayWeeks} wk` : '13+ wk'} label="Runway" note={h.runwayNote}
          neg={h.runwayWeeks !== null && h.runwayWeeks <= 6} />
      </div>

      <Settings data={data} onSaved={setData} />

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="spread" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="eyebrow">13-week forecast</div>
            <h3>Projected closing cash</h3>
          </div>
          <div className="row" style={{ gap: 18 }}>
            <Mini label="End of week 13 (committed)" v={h.endCommitted} />
            {hasScenario && <Mini label="With selected pipeline" v={h.endScenario} tone="var(--cyan)" />}
          </div>
        </div>
        <div style={{ marginTop: 14 }}><CashFlowChart weeks={points} hasScenario={hasScenario} /></div>
        {hasScenario ? (
          <p className="small fade" style={{ marginTop: 8 }}>
            Scenario line adds: {data.included.map((o) => `${o.client} (${money(o.value)}${o.type === 'retainer' ? '/mo' : ''})`).join(', ')}.
            {' '}Toggle these in <button className="linky" onClick={() => go('pipeline')}>Pipeline</button>.
          </p>
        ) : (
          <p className="small fade" style={{ marginTop: 8 }}>
            The floor uses won work + committed payments. In <button className="linky" onClick={() => go('pipeline')}>Pipeline</button>, tick an open opportunity's <b>Forecast</b> box to model winning it.
          </p>
        )}
      </div>

      {/* Weekly grid */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="eyebrow">Week by week</div>
        <h3 style={{ marginBottom: 12 }}>Opening → receipts → payments → closing</h3>
        <div style={{ overflowX: 'auto' }}>
          <table className="t" style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th>Week of</th>
                <th style={{ textAlign: 'right' }}>Opening</th>
                <th style={{ textAlign: 'right' }}>Receipts</th>
                <th style={{ textAlign: 'right' }}>Payments</th>
                <th style={{ textAlign: 'right' }}>Closing</th>
                {hasScenario && <th style={{ textAlign: 'right' }}>+ Pipeline</th>}
              </tr>
            </thead>
            <tbody>
              {data.weeks.map((w) => (
                <tr key={w.index}>
                  <td style={{ fontWeight: 600 }}>{w.label}</td>
                  <td style={{ textAlign: 'right' }} className="money small">{moneyShort(w.openingCommitted)}</td>
                  <td style={{ textAlign: 'right' }} className="money small" >{w.receipts ? `+${moneyShort(w.receipts)}` : '—'}</td>
                  <td style={{ textAlign: 'right' }} className="money small">{w.payments ? `−${moneyShort(w.payments)}` : '—'}</td>
                  <td style={{ textAlign: 'right' }} className="money">
                    <span style={{ color: w.closingCommitted < 0 ? 'var(--fail)' : 'var(--navy)', fontWeight: 600 }}>{money(w.closingCommitted)}</span>
                  </td>
                  {hasScenario && <td style={{ textAlign: 'right' }} className="money small"><span style={{ color: 'var(--cyan)' }}>{money(w.closingScenario)}</span></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid g2" style={{ alignItems: 'start' }}>
        <ItemEditor kind="payment" title="Committed payments" items={data.payments}
          hint="Obligations Xero can't future-date: tax plans (HMRC TTP), CCS, VAT, PAYE, lease, payroll, contractors." onChange={setData} categories={PAY_CATEGORIES} />
        <ItemEditor kind="receipt" title="Expected receipts" items={data.receipts}
          hint="Income not already in the pipeline — ad-hoc invoices, deposits, grants. Won retainers are added automatically." onChange={setData} />
      </div>
    </>
  );
}

function Tile({ n, label, note, neg }: { n: string; label: string; note?: string; neg?: boolean }) {
  return (
    <div className="card stat">
      <div className={`n${neg ? ' neg' : ''}`}>{n}</div>
      <div className="l">{label}</div>
      {note && <div className="foot"><span className="kpi-note">{note}</span></div>}
    </div>
  );
}

function Mini({ label, v, tone }: { label: string; v: number; tone?: string }) {
  return (
    <div style={{ textAlign: 'right' }}>
      <div className="money" style={{ fontSize: 22, color: v < 0 ? 'var(--fail)' : (tone ?? 'var(--navy)') }}>{money(v)}</div>
      <div className="small fade">{label}</div>
    </div>
  );
}

function Settings({ data, onSaved }: { data: CashflowData; onSaved: (d: CashflowData) => void }) {
  const [total, setTotal] = useState(data.settings.usingBalanceCash ? '' : String(data.settings.totalCash));
  const [vat, setVat] = useState(String(data.settings.vatSetAside));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const r = await api.cashflowSettings({ totalCash: total, vatSetAside: vat });
    setBusy(false);
    if (r) { onSaved(r); toast('Cash position saved'); }
  }
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="eyebrow">Cash position</div>
      <div className="row" style={{ gap: 18, marginTop: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <label className="f">Total cash (opening)</label>
          <input className="inp num" style={{ width: 150 }} value={total} onChange={(e) => setTotal(e.target.value)}
            placeholder={data.settings.usingBalanceCash ? `${data.settings.totalCash} (balance sheet)` : ''} />
        </div>
        <div>
          <label className="f">VAT set-aside (Starling Space)</label>
          <input className="inp num" style={{ width: 150 }} value={vat} onChange={(e) => setVat(e.target.value)} placeholder="0" />
        </div>
        <button className="btn gold" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        <span className="small fade">Leave total blank to track the imported balance-sheet cash.</span>
      </div>
    </div>
  );
}

function ItemEditor({ kind, title, hint, items, categories, onChange }:
{ kind: 'payment' | 'receipt'; title: string; hint: string; items: CashItem[]; categories?: string[]; onChange: (d: CashflowData) => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [cadence, setCadence] = useState<Cadence>('monthly');
  const [cat, setCat] = useState('');
  const [date, setDate] = useState('');

  async function add() {
    if (!label.trim()) { toast('Add a label'); return; }
    const r = await api.cashflowAdd(kind, { label, amount: Number(amount) || 0, cadence, category: cat, date });
    if (r) { onChange(r); setLabel(''); setAmount(''); setCat(''); setDate(''); setOpen(false); }
  }
  async function edit(it: CashItem, fields: Partial<CashItem>) {
    const r = await api.cashflowUpdate(kind, { id: it.id, ...fields }); if (r) onChange(r);
  }
  async function del(id: string) { const r = await api.cashflowDelete(kind, id); if (r) onChange(r); }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="spread" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div><div className="eyebrow">{kind === 'payment' ? 'Money out' : 'Money in'}</div><h3>{title}</h3></div>
        <button className="btn ghost sm" onClick={() => setOpen((o) => !o)}>{open ? 'Close' : '+ Add'}</button>
      </div>
      <p className="small fade" style={{ margin: '6px 0 0' }}>{hint}</p>

      {open && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <input className="inp" style={{ width: 150 }} placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
          <input className="inp num" style={{ width: 90 }} placeholder="£" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <select className="inp" style={{ width: 'auto' }} value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
            {CADENCES.map(([c, l]) => <option key={c} value={c}>{l}</option>)}
          </select>
          {categories && (
            <select className="inp" style={{ width: 'auto' }} value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">Category…</option>{categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          <input className="inp" style={{ width: 'auto' }} type="date" value={date} onChange={(e) => setDate(e.target.value)} title="First due date (blank = from this week)" />
          <button className="btn gold sm" onClick={add}>Add</button>
        </div>
      )}

      {items.length === 0 ? <div style={{ marginTop: 12 }}><Empty>Nothing yet.</Empty></div> : (
        <table className="t" style={{ marginTop: 12 }}>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{it.label}{it.category && <span className="pill" style={{ marginLeft: 8 }}>{it.category}</span>}</td>
                <td style={{ textAlign: 'right' }} className="money small">{money(it.amount)}</td>
                <td>
                  <select className="inp cell" value={it.cadence} onChange={(e) => edit(it, { cadence: e.target.value as Cadence })}>
                    {CADENCES.map(([c, l]) => <option key={c} value={c}>{l}</option>)}
                  </select>
                </td>
                <td style={{ textAlign: 'right' }}><button className="linky" onClick={() => del(it.id)}>remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
