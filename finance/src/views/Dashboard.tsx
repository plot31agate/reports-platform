/* Dashboard.tsx — the Overview: one screen that ties the two sources of truth
   together. The bank statement is the cash truth (what actually arrived and
   left), Xero is the accounting truth (P&L). Headlines, the flow trend, the
   watchlist of clients gone quiet, and the questions the data raises this
   week all come from the bank; the P&L strip beneath reconciles it against
   the imported Xero months when they exist. */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { FinanceModel, Space, SpaceKind } from '../lib/api';
import { money, moneyShort, delta, pctLabel } from '../lib/finance';
import { useBank } from '../lib/useBank';
import {
  monthlyFlows, clientRows, spendGroups, loans, computeQuestions, buildDigest,
} from '../lib/bank';
import type { Enriched, BankExtras } from '../lib/bank';
import { Stat, IncomeCostChart, SpendBars, Working, OfflineNote, Empty, toast } from '../components/ui';
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
  const extras: BankExtras = { spaces: bank.spaces, events: bank.events, answers: bank.answers };

  return (
    <>
      <BankHeadlines txs={txs} spaces={bank.spaces} />
      <div className="grid g2" style={{ alignItems: 'start', marginBottom: 16 }}>
        <div className="card">
          <div className="eyebrow">Cash flow · actuals</div>
          <h3 style={{ marginBottom: 14 }}>Money in vs out, by month</h3>
          <FlowChart txs={txs} />
        </div>
        <QuestionsCard txs={txs} extras={extras} onSaved={bank.refresh} go={go} />
      </div>
      <div className="grid g2" style={{ alignItems: 'start', marginBottom: 16 }}>
        <WatchlistCard txs={txs} go={go} />
        <SpendGroupsCard txs={txs} go={go} />
      </div>
      <div className="grid g2" style={{ alignItems: 'start', marginBottom: 16 }}>
        <SpacesCard txs={txs} spaces={bank.spaces} events={bank.events} onSaved={bank.refresh} />
        {model && model.meta.count > 0 ? <XeroStrip model={model} go={go} /> : <div />}
      </div>
    </>
  );
}

/* ---- KPI row from the bank data ---- */
function BankHeadlines({ txs, spaces }: { txs: Enriched[]; spaces: Space[] }) {
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

  const ringFenced = spaces.reduce((s, x) => s + x.balance, 0);

  return (
    <div className="grid g4" style={{ marginBottom: 16 }}>
      <Stat n={money(cash)} label={`Cash in bank · ${asOf}`}
        note={ringFenced > 0
          ? `+ ${moneyShort(ringFenced)} ring-fenced in Spaces`
          : (avgNet < 0 ? `~${(cash / -avgNet).toFixed(1)} mo at current burn` : 'cash-positive on average')} />
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

/* ---- The questions the data raises — end to end ----
   A question isn't the deliverable; the decision is. Each one can be
   interrogated right here (Claude, grounded in the imported figures) and then
   answered — the answer files into a decisions log that persists, silences
   the question, and feeds the Ask digest as ground truth. */
function QuestionsCard({ txs, extras, onSaved, go }: {
  txs: Enriched[]; extras: BankExtras; onSaved: () => void; go: (v: string) => void;
}) {
  const answers = extras.answers ?? {};
  const qs = computeQuestions(txs, extras);
  const openQs = qs.filter((q) => !answers[q.key]);
  const doneQs = qs.filter((q) => !!answers[q.key]);
  const [open, setOpen] = useState<string | null>(openQs[0]?.key ?? null);
  const [draft, setDraft] = useState('');
  const [writing, setWriting] = useState(false);
  const [askBusy, setAskBusy] = useState(false);
  const [aiAnswer, setAiAnswer] = useState<{ key: string; text: string; figures: { label: string; value: string }[] } | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  function toggle(key: string) {
    setOpen(open === key ? null : key);
    setWriting(false); setDraft(''); setAiAnswer(null);
  }

  async function askClaude(q: { key: string; q: string; why: string }) {
    setAskBusy(true); setAiAnswer(null);
    const r = await api.ask(`${q.q}\nContext behind the question: ${q.why}\nGive a concrete recommended next action.`);
    setAskBusy(false);
    if (!r?.ok || !r.result) { toast(r?.error || 'Claude isn’t reachable — is the API key on the server?'); return; }
    setAiAnswer({ key: q.key, text: r.result.answer, figures: r.result.figures ?? [] });
  }

  async function fileAnswer(q: { key: string; q: string }, text: string) {
    const t = text.trim();
    if (t === '') { toast('Write the decision first'); return; }
    const r = await api.bankAnswer(q.key, q.q, t);
    if (!r?.ok) { toast('Could not save'); return; }
    await api.bankDigest(buildDigest(txs, { ...extras, answers: r.answers }));
    toast('Filed — Claude will treat this as ground truth');
    setWriting(false); setDraft(''); setAiAnswer(null);
    onSaved();
  }

  async function reopen(key: string) {
    const r = await api.bankAnswer(key, '', '');
    if (r?.ok) { await api.bankDigest(buildDigest(txs, { ...extras, answers: r.answers })); onSaved(); }
  }

  return (
    <div className="card">
      <div className="eyebrow">Oversight</div>
      <h3 style={{ marginBottom: 12 }}>Questions to ask this week</h3>
      {openQs.length === 0 ? <Empty>Nothing open — every question the data raises has a filed decision.</Empty> : (
        <div>
          {openQs.map((q) => (
            <div className="qrow" key={q.key}>
              <button className="qhead" onClick={() => toggle(q.key)}>
                <span className={`dot ${q.tone === 'bad' ? 'down' : q.tone === 'warn' ? 'warn' : 'idle'}`} />
                <span className="qtext">{q.q}</span>
                <span className="qcaret">{open === q.key ? '−' : '+'}</span>
              </button>
              {open === q.key && (
                <div className="qwhy">
                  {q.why}
                  {aiAnswer?.key === q.key && (
                    <div className="qai">
                      <div className="eyebrow" style={{ marginBottom: 6 }}>Claude · from your figures</div>
                      {aiAnswer.text}
                      {aiAnswer.figures.length > 0 && (
                        <div className="row" style={{ gap: 14, flexWrap: 'wrap', marginTop: 8 }}>
                          {aiAnswer.figures.map((f, i) => (
                            <span key={i} className="small"><span className="money">{f.value}</span> <span className="fade">{f.label}</span></span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {writing ? (
                    <div style={{ marginTop: 10 }}>
                      <textarea className="inp" rows={3} autoFocus value={draft}
                        placeholder="The decision — e.g. Spoke to Vivo 4 Sep: invoices 4290–4310 confirmed, paying w/c 15 Sep. Chase again if not."
                        onChange={(e) => setDraft(e.target.value)} />
                      <div className="row" style={{ gap: 8, marginTop: 8 }}>
                        <button className="btn sm" onClick={() => fileAnswer(q, draft)}>File the decision</button>
                        <button className="btn ghost sm" onClick={() => { setWriting(false); setDraft(''); }}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                      <button className="btn ghost sm" disabled={askBusy} onClick={() => askClaude(q)}>
                        {askBusy ? 'Asking…' : 'Ask Claude'}
                      </button>
                      <button className="btn ghost sm" onClick={() => { setWriting(true); setDraft(aiAnswer?.key === q.key ? aiAnswer.text : ''); }}>
                        {aiAnswer?.key === q.key ? 'File this as the decision' : 'Answer & file'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {(doneQs.length > 0 || Object.keys(answers).length > 0) && (
        <div style={{ marginTop: 14 }}>
          <button className="linky" onClick={() => setLogOpen(!logOpen)}>
            {logOpen ? 'Hide' : 'Show'} decisions log ({Object.keys(answers).length})
          </button>
          {logOpen && (
            <div style={{ marginTop: 8 }}>
              {Object.entries(answers).sort((a, b) => b[1].savedAt - a[1].savedAt).map(([key, a]) => (
                <div className="qdone" key={key}>
                  <div className="small" style={{ fontWeight: 600, color: 'var(--ink)' }}>{a.question}</div>
                  <div className="small" style={{ marginTop: 3 }}>{a.answer}</div>
                  <div className="small fade" style={{ marginTop: 3 }}>
                    {new Date(a.savedAt * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    {' · '}<button className="linky" onClick={() => reopen(key)}>reopen</button>
                  </div>
                </div>
              ))}
            </div>
          )}
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

/* ---- Ring-fenced money: Starling Spaces ----
   Spaces don't export statements, so the VAT pot and any other set-asides are
   invisible to the imported CSV. Track them here; the VAT total also syncs
   into the Cash flow room's set-aside so available cash reads true. */
function SpacesCard({ txs, spaces, events, onSaved }: {
  txs: Enriched[]; spaces: Space[]; events: BankExtras['events']; onSaved: () => void;
}) {
  const [rows, setRows] = useState<Space[]>(spaces);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setRows(spaces); setDirty(false); }, [spaces]);

  const upd = (i: number, patch: Partial<Space>) => {
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const total = rows.reduce((s, r) => s + (r.balance || 0), 0);

  async function save() {
    const clean = rows.filter((r) => r.name.trim() !== '');
    const r = await api.bankSpaces(clean);
    if (!r?.ok) { toast('Could not save'); return; }
    const vat = clean.filter((s) => s.kind === 'vat').reduce((s, x) => s + x.balance, 0);
    if (vat > 0) await api.cashflowSettings({ vatSetAside: vat });
    await api.bankDigest(buildDigest(txs, { spaces: clean, events }));
    toast(vat > 0 ? 'Spaces saved — VAT set-aside synced to Cash flow' : 'Spaces saved');
    onSaved();
  }

  return (
    <div className="card">
      <div className="eyebrow">Ring-fenced money</div>
      <h3 style={{ marginBottom: 6 }}>Starling Spaces &amp; set-asides</h3>
      <p className="small fade" style={{ margin: '0 0 12px' }}>
        Spaces don't appear in the statement export — keep their balances here so cash reads true.
        VAT spaces sync into the Cash flow set-aside automatically.
      </p>
      {rows.map((r, i) => (
        <div className="row" key={i} style={{ gap: 8, marginBottom: 8 }}>
          <input className="inp" style={{ flex: 2 }} placeholder="e.g. VAT pot"
            value={r.name} onChange={(e) => upd(i, { name: e.target.value })} />
          <select className="inp" style={{ flex: 1 }} value={r.kind}
            onChange={(e) => upd(i, { kind: e.target.value as SpaceKind })}>
            <option value="vat">VAT</option>
            <option value="tax">Tax</option>
            <option value="savings">Savings</option>
            <option value="other">Other</option>
          </select>
          <input className="inp num" style={{ width: 110 }} placeholder="0"
            value={r.balance || ''} onChange={(e) => upd(i, { balance: Number(e.target.value) || 0 })} />
          <button className="linky" onClick={() => { setRows(rows.filter((_, j) => j !== i)); setDirty(true); }}>remove</button>
        </div>
      ))}
      <div className="spread" style={{ marginTop: 12, flexWrap: 'wrap', gap: 10 }}>
        <button className="btn ghost sm"
          onClick={() => { setRows([...rows, { name: '', kind: 'vat', balance: 0 }]); setDirty(true); }}>
          + Add a space
        </button>
        <div className="row" style={{ gap: 12 }}>
          {total > 0 && <span className="small fade">Total set aside: <span className="money">{money(total)}</span></span>}
          {dirty && <button className="btn sm" onClick={save}>Save spaces</button>}
        </div>
      </div>
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
