/* Debt.tsx — every borrowing facility on one screen. The statement shows what
   each one costs per month; the owner adds the two facts a statement can't
   know (balance and rate) and the view turns that into clearance dates, the
   effect of overpaying, and the real decision on the table right now:
   replace the leaver, or pay debt down faster. */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { LoanMeta } from '../lib/api';
import { money, moneyShort } from '../lib/finance';
import { useBank } from '../lib/useBank';
import { loans, monthlyFlows } from '../lib/bank';
import type { LoanRow } from '../lib/bank';
import { Stat, Working, OfflineNote, toast } from '../components/ui';

/** Months to clear a balance at `monthly`, with optional APR. Null = never
    (payment doesn't cover interest). */
function monthsToClear(balance: number, monthly: number, apr: number): number | null {
  if (balance <= 0) return 0;
  if (monthly <= 0) return null;
  const r = apr > 0 ? apr / 100 / 12 : 0;
  if (r === 0) return balance / monthly;
  if (monthly <= balance * r) return null;
  return -Math.log(1 - (r * balance) / monthly) / Math.log(1 + r);
}

function clearDateLabel(from: string, months: number | null): string {
  if (months === null) return 'never at this rate';
  if (months <= 0) return 'cleared';
  const d = new Date(from);
  d.setMonth(d.getMonth() + Math.ceil(months));
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

export function Debt({ go }: { go: (v: string) => void }) {
  const bank = useBank();
  const [meta, setMeta] = useState<Record<string, LoanMeta>>({});
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setMeta(bank.loanMeta); }, [bank.loanMeta]);

  const txs = bank.txs ?? [];
  const rows = useMemo(() => loans(txs), [txs]);
  if (bank.loading) return <Working label="Loading facilities…" />;
  if (bank.offline) return <OfflineNote />;
  if (txs.length === 0) return (
    <div className="card" style={{ textAlign: 'center', padding: '44px 28px' }}>
      <div className="eyebrow">No bank data yet</div>
      <h3 style={{ margin: '10px 0 14px' }}>Import a bank statement to see borrowing here</h3>
      <button className="btn" onClick={() => go('import')}>Go to Import →</button>
    </div>
  );

  const asOf = txs[txs.length - 1].date;
  const flows = monthlyFlows(txs);
  const complete = flows.filter((f) => f.key !== asOf.slice(0, 7));
  const recent = complete.slice(-3);
  const avgNet = recent.length ? recent.reduce((s, f) => s + f.net, 0) / recent.length : 0;
  const avgOut = recent.length ? recent.reduce((s, f) => s + f.out, 0) / recent.length : 0;
  const debtMonthly = rows.reduce((s, l) => s + l.recentMonthly, 0);
  const paidYtd = rows.reduce((s, l) => s + l.paidTotal, 0);
  const balancesKnown = rows.every((l) => (meta[l.entity]?.balance ?? 0) > 0);
  const totalBalance = rows.reduce((s, l) => s + (meta[l.entity]?.balance ?? 0), 0);

  async function save() {
    const r = await api.bankLoans(meta);
    if (r?.ok) { toast('Facility details saved'); setDirty(false); }
    else toast('Could not save');
  }

  return (
    <>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Stat n={money(paidYtd)} label="Repaid this year" note={`across ${rows.length} facilities`} />
        <Stat n={money(debtMonthly)} label="Debt service / month"
          note={avgOut > 0 ? `${Math.round((debtMonthly / avgOut) * 100)}% of all spending` : undefined} />
        <Stat n={balancesKnown && totalBalance > 0 ? money(totalBalance) : '—'} label="Owed today"
          note={balancesKnown ? 'from balances entered below' : 'enter balances below'} />
        <Stat n={money(avgNet)} neg={avgNet < 0} label="Monthly surplus · 3-mo avg"
          note="what's available to overpay or hire with" />
      </div>

      <div className="grid g3" style={{ marginBottom: 16, alignItems: 'stretch' }}>
        {rows.map((l) => (
          <LoanCard key={l.entity} l={l} asOf={asOf}
            meta={meta[l.entity] ?? { balance: 0, apr: 0, note: '' }}
            onChange={(m) => { setMeta({ ...meta, [l.entity]: m }); setDirty(true); }} />
        ))}
      </div>
      {dirty && (
        <div className="row" style={{ marginBottom: 16 }}>
          <button className="btn" onClick={save}>Save facility details</button>
          <span className="small fade">Balance and rate are stored so payoff dates persist.</span>
        </div>
      )}

      <DecisionCard avgNet={avgNet} debtMonthly={debtMonthly} rows={rows} meta={meta} asOf={asOf} go={go} />
    </>
  );
}

function LoanCard({ l, meta, asOf, onChange }: {
  l: LoanRow; meta: LoanMeta; asOf: string; onChange: (m: LoanMeta) => void;
}) {
  const revolving = l.drawnTotal > 0;
  const months = meta.balance > 0 ? monthsToClear(meta.balance, l.recentMonthly, meta.apr) : null;
  const monthsOver = meta.balance > 0 ? monthsToClear(meta.balance, l.recentMonthly + 250, meta.apr) : null;
  return (
    <div className="card">
      <div className="spread">
        <div className="eyebrow">{revolving ? 'Revolving credit' : 'Loan'}</div>
        {l.recentMonthly > 0 && <span className="pill">{moneyShort(l.recentMonthly)}/mo</span>}
      </div>
      <h3 style={{ margin: '6px 0 10px', fontSize: 16 }}>{l.entity}</h3>
      <table className="t compact">
        <tbody>
          <tr><td className="fade">Repaid this year</td><td style={{ textAlign: 'right' }} className="money">{money(l.paidTotal)}</td></tr>
          {revolving && <tr><td className="fade">Drawn this year</td><td style={{ textAlign: 'right' }} className="money">{money(l.drawnTotal)}</td></tr>}
          <tr><td className="fade">Last payment</td><td style={{ textAlign: 'right' }} className="small">{l.lastPayment || '—'}</td></tr>
        </tbody>
      </table>
      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <div style={{ flex: 1 }}>
          <label className="f">Balance today</label>
          <input className="inp num" value={meta.balance || ''} placeholder="0"
            onChange={(e) => onChange({ ...meta, balance: Number(e.target.value) || 0 })} />
        </div>
        <div style={{ width: 90 }}>
          <label className="f">APR %</label>
          <input className="inp num" value={meta.apr || ''} placeholder="0"
            onChange={(e) => onChange({ ...meta, apr: Number(e.target.value) || 0 })} />
        </div>
      </div>
      {meta.balance > 0 && (
        <div className="payoff">
          <div>Clears <b>{clearDateLabel(asOf, months)}</b>{months !== null && months > 0 ? ` (~${Math.ceil(months)} mo at ${moneyShort(l.recentMonthly)}/mo)` : ''}</div>
          {months !== null && monthsOver !== null && months - monthsOver >= 1 && (
            <div className="small fade" style={{ marginTop: 4 }}>
              +£250/month brings that forward to <b>{clearDateLabel(asOf, monthsOver)}</b>.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DecisionCard({ avgNet, debtMonthly, rows, meta, asOf, go }: {
  avgNet: number; debtMonthly: number; rows: LoanRow[];
  meta: Record<string, LoanMeta>; asOf: string; go: (v: string) => void;
}) {
  const [hireCost, setHireCost] = useState('2100');
  const hire = Number(hireCost) || 0;
  const afterHire = avgNet - hire;
  // Best use of an overpayment: the facility with a known balance that clears
  // soonest — clearing it frees its whole monthly payment.
  const candidates = rows
    .map((l) => ({ l, m: meta[l.entity], months: (meta[l.entity]?.balance ?? 0) > 0 ? monthsToClear(meta[l.entity].balance, l.recentMonthly, meta[l.entity].apr) : null }))
    .filter((c) => c.months !== null && c.months! > 0)
    .sort((a, b) => a.months! - b.months!);
  const quickest = candidates[0];

  return (
    <div className="card">
      <div className="eyebrow">The decision on the table</div>
      <h3 style={{ marginBottom: 12 }}>Replace the leaver, or pay debt down faster?</h3>
      <div className="grid g3" style={{ alignItems: 'start' }}>
        <div>
          <label className="f">Monthly cost of the new hire (net + NI + pension)</label>
          <input className="inp num" value={hireCost} onChange={(e) => setHireCost(e.target.value)} />
          <div className="small fade" style={{ marginTop: 8 }}>
            The role that ended was paying ~£1,700/month net; with employer NI and
            pension a like-for-like replacement is nearer £2,100–£2,400/month all-in.
          </div>
        </div>
        <div className="decision">
          <div className="d-l">If you hire</div>
          <div className={`d-n money ${afterHire < 0 ? 'neg' : ''}`}>{money(afterHire)}<span className="d-u">/mo surplus left</span></div>
          <div className="small fade">
            {afterHire < 0
              ? 'The hire pushes the average month negative — it needs new revenue to fund it, not just the surplus.'
              : 'The average month still clears — but the buffer for a slow month shrinks.'}
          </div>
        </div>
        <div className="decision">
          <div className="d-l">If you overpay debt instead</div>
          <div className="d-n money">{money(debtMonthly)}<span className="d-u">/mo current service</span></div>
          <div className="small fade">
            {quickest
              ? <>Putting the same money at <b>{quickest.l.entity}</b> clears it around <b>{clearDateLabel(asOf, monthsToClear(quickest.m.balance, quickest.l.recentMonthly + hire, quickest.m.apr))}</b> — and then its {moneyShort(quickest.l.recentMonthly)}/month comes back for good, which itself part-funds a hire.</>
              : 'Enter balances above and this shows which facility to clear first, and when its monthly payment comes back.'}
          </div>
        </div>
      </div>
      <div className="note-strip" style={{ marginTop: 16 }}>
        Neither answer is wrong — the sequencing is the decision. If the pipeline says revenue is coming
        (<button className="linky" onClick={() => go('pipeline')}>check Pipeline</button>), hiring first buys capacity;
        if it doesn't, clearing the quickest facility first permanently lowers the cost base and makes the
        hire safer in three to six months. Ask the data to model both.
      </div>
    </div>
  );
}
