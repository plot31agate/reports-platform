/* MoneyIn.tsx — every client, on one screen: what they've paid this year,
   their typical month, when they last paid and whether their cadence has
   slipped. This is where the retainers feed in — a regular payer whose gap
   stretches shows up as "late" and then "quiet" without anyone having to
   remember to check. */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { PipelineData, Receivables, Retainer } from '../lib/api';
import { money, moneyShort } from '../lib/finance';
import { useBank } from '../lib/useBank';
import { clientRows, monthlyFlows, expectedThisMonth, invoicesFor, nameMatches } from '../lib/bank';
import type { ClientRow, Enriched, ExpectedRow, OutstandingInvoice } from '../lib/bank';
import { Stat, Working, OfflineNote, Empty, toast } from '../components/ui';

/** Same business? Alias parentheticals on either side. */
const sameClient = (a: string, b: string) => nameMatches(a, b) || nameMatches(b, a);

const STATUS_LABEL: Record<ClientRow['status'], string> = {
  ontrack: 'on track', late: 'late', quiet: 'gone quiet', oneoff: 'one-off',
};
const STATUS_PILL: Record<ClientRow['status'], string> = {
  ontrack: 'pass', late: 'warn', quiet: 'fail', oneoff: '',
};

export function MoneyIn({ go }: { go: (v: string) => void }) {
  const bank = useBank();
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [showSmall, setShowSmall] = useState(false);
  const [receivables, setReceivables] = useState<Receivables | null>(null);
  const [retainers, setRetainers] = useState<Retainer[]>([]);
  useEffect(() => {
    api.model().then((m) => m?.receivables && setReceivables(m.receivables));
    api.retainers().then((r) => r && setRetainers(r.retainers));
  }, []);

  if (bank.loading) return <Working label="Loading clients…" />;
  if (bank.offline) return <OfflineNote />;
  const txs = bank.txs ?? [];
  if (txs.length === 0) return (
    <div className="card" style={{ textAlign: 'center', padding: '44px 28px' }}>
      <div className="eyebrow">No bank data yet</div>
      <h3 style={{ margin: '10px 0 14px' }}>Import a bank statement to see clients here</h3>
      <button className="btn" onClick={() => go('import')}>Go to Import →</button>
    </div>
  );

  const { rows, asOf } = clientRows(txs);
  const totalRev = rows.reduce((s, r) => s + r.total, 0);
  const top = rows[0];
  const regulars = rows.filter((r) => r.cadence === 'monthly');
  const attention = rows.filter((r) => r.status === 'late' || r.status === 'quiet').length;
  const monthKeys = monthlyFlows(txs).map((f) => f.key);
  const visible = showSmall ? rows : rows.filter((r) => r.total >= 500);
  const hidden = rows.length - visible.length;

  // The agreed book on top of the bank rhythm: active entries the bank
  // doesn't see yet (a new signing before its first payment).
  const bookExtra = retainers.filter((r) =>
    r.status === 'active' && r.monthly > 0 && !rows.some((c) => sameClient(c.entity, r.client)));

  return (
    <>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Stat n={money(totalRev)} label="Client revenue this year" note={`${rows.length} paying clients`} />
        <Stat n={money(regulars.reduce((s, r) => s + r.medianMonthly, 0) + bookExtra.reduce((s, r) => s + r.monthly, 0))}
          label="Retainer run-rate / month"
          note={`${regulars.length} regular payers${bookExtra.length > 0 ? ` + ${bookExtra.length} from the book` : ''}`} />
        <Stat n={top ? `${Math.round((top.total / Math.max(1, totalRev)) * 100)}%` : '—'}
          label="Biggest client's share" note={top ? top.entity : undefined} />
        <Stat n={String(attention)} neg={attention > 0} label="Need attention" note="late or gone quiet" />
      </div>

      <RetainerBookCard retainers={retainers} bankRows={rows} onChange={setRetainers} />

      <ThisMonthCard txs={txs} retainers={retainers} go={go} />

      <div className="card">
        <div className="spread" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div className="eyebrow">Clients</div>
            <h3>Who pays, and on what rhythm</h3>
          </div>
          <span className="small fade">as of {asOf} · click a row for the month-by-month</span>
        </div>
        <table className="t clickable" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Client</th>
              <th style={{ textAlign: 'right' }}>This year</th>
              <th style={{ textAlign: 'right' }}>Typical / mo</th>
              <th>Cadence</th>
              <th style={{ textAlign: 'right' }}>Last paid</th>
              <th style={{ textAlign: 'right' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <ClientTr key={r.entity} r={r} monthKeys={monthKeys}
                invoices={invoicesFor(r.entity, receivables?.invoices)} asOf={asOf}
                open={openRow === r.entity}
                toggle={() => setOpenRow(openRow === r.entity ? null : r.entity)} />
            ))}
          </tbody>
        </table>
        {receivables?.scopeMissing && attention > 0 && (
          <div className="small fade" style={{ marginTop: 10 }}>
            Want the invoices behind the late payers? Reconnect Xero once in{' '}
            <button className="linky" onClick={() => go('import')}>Import</button> — the connection
            predates invoice access, and syncs will then pull each client's outstanding invoices in here.
          </div>
        )}
        {hidden > 0 && !showSmall && (
          <button className="linky" style={{ marginTop: 12 }} onClick={() => setShowSmall(true)}>
            show {hidden} smaller payer{hidden === 1 ? '' : 's'} (under £500 this year)
          </button>
        )}
        {rows.length === 0 && <Empty>No client payments found in the statement.</Empty>}
      </div>

      <div className="note-strip" style={{ marginTop: 16 }}>
        <b>How status works:</b> each client's usual gap between payments is measured from their own
        history. Stretch past ~1.6× the usual gap and they're <b>late</b>; past ~2.5× (or 70 days) and
        they've <b>gone quiet</b> — chase the invoice or reforecast the retainer. Won work that hasn't
        started paying yet belongs in <button className="linky" onClick={() => go('pipeline')}>Pipeline</button>.
      </div>
    </>
  );
}

/* ---- Coming in this month ----
   Regular payers projected at their typical month, netted against what has
   already landed — plus won pipeline work that hasn't started paying through
   the bank yet. Nothing here is automatic bookkeeping: it's the answer to
   "who is paying us what this month, and who hasn't yet?" */
function ThisMonthCard({ txs, retainers, go }: { txs: Enriched[]; retainers: Retainer[]; go: (v: string) => void }) {
  const [pipe, setPipe] = useState<PipelineData | null>(null);
  useEffect(() => { api.pipeline().then(setPipe); }, []);

  const exp = expectedThisMonth(txs);
  const monthName = exp.monthKey
    ? new Date(exp.monthKey + '-01').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    : '';

  // Layering order, no double counting: bank rhythm > retainer book > won
  // pipeline. Book entries the bank doesn't pay yet ride on top; won pipeline
  // only if it's in neither.
  const activeBook = retainers.filter((r) => r.status === 'active' && r.monthly > 0);
  const monthEnd = exp.monthKey ? exp.monthKey + '-31' : '9999-12-31';
  const bookRows: ExpectedRow[] = activeBook
    .filter((r) => !exp.rows.some((er) => sameClient(er.entity, r.client)))
    .filter((r) => r.startDate === '' || r.startDate <= monthEnd)
    .map((r) => ({
      entity: `${r.client} (retainer)`, expected: r.monthly, received: 0, due: r.monthly,
      status: 'due' as const, source: 'book' as const,
    }));
  const pipeRows: ExpectedRow[] = (pipe?.opps ?? [])
    .filter((o) => o.stage === 'won' && o.value > 0)
    .filter((o) => !exp.rows.some((er) => sameClient(er.entity, o.client)))
    .filter((o) => !activeBook.some((r) => sameClient(r.client, o.client)))
    .map((o) => ({
      entity: `${o.client} (won, ${o.type})`, expected: o.value, received: 0, due: o.value,
      status: 'due' as const, source: 'pipeline' as const,
    }));

  const extra = [...bookRows, ...pipeRows];
  const all = [...exp.rows, ...extra];
  const totalExpected = exp.expected + extra.reduce((s, r) => s + r.expected, 0);
  const totalDue = exp.due + extra.reduce((s, r) => s + r.due, 0);
  const stillDue = all.filter((r) => r.due > 0);
  const paid = all.filter((r) => r.due <= 0);

  if (all.length === 0) return null;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="spread" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div className="eyebrow">Coming in · {monthName}</div>
          <h3>Who's paying what this month</h3>
        </div>
        <div className="row" style={{ gap: 22 }}>
          <MiniTot label="expected" v={totalExpected} />
          <MiniTot label="already in" v={exp.received + exp.otherReceived} tone="var(--pass)" />
          <MiniTot label="still to come" v={totalDue} tone={totalDue > 0 ? 'var(--ink)' : undefined} />
        </div>
      </div>
      <table className="t" style={{ marginTop: 12 }}>
        <thead>
          <tr><th>Client</th><th style={{ textAlign: 'right' }}>Expected</th>
            <th style={{ textAlign: 'right' }}>Received</th>
            <th style={{ textAlign: 'right' }}>Still due</th><th style={{ textAlign: 'right' }}></th></tr>
        </thead>
        <tbody>
          {[...stillDue, ...paid].map((r) => (
            <tr key={r.entity}>
              <td style={{ fontWeight: 600, color: 'var(--ink)' }}>
                {r.entity}
                {r.source === 'pipeline' && <span className="tag-src fade"> pipeline</span>}
                {r.source === 'book' && <span className="tag-src fade"> retainer book</span>}
              </td>
              <td style={{ textAlign: 'right' }} className="money">{money(r.expected)}</td>
              <td style={{ textAlign: 'right' }} className="money">{r.received > 0 ? money(r.received) : '—'}</td>
              <td style={{ textAlign: 'right' }} className="money">{r.due > 0 ? money(r.due) : '—'}</td>
              <td style={{ textAlign: 'right' }}>
                <span className={`pill ${r.status === 'paid' ? 'pass' : r.status === 'partial' ? 'warn' : ''}`}>
                  {r.status === 'paid' ? 'paid' : r.status === 'partial' ? 'partial' : 'due'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="small fade" style={{ marginTop: 10 }}>
        Regular payers are projected at their typical month; agreed retainers from the book and won
        work from <button className="linky" onClick={() => go('pipeline')}>Pipeline</button> ride on
        top until they start paying through the bank{exp.otherReceived > 0 ? <> — plus {money(exp.otherReceived)} already in this month from one-off/irregular payers</> : null}.
        Gone-quiet retainers aren't counted as expected — they're on the watchlist instead.
      </div>
    </div>
  );
}

/* ---- The retainer book ----
   The AGREED ongoing retainers — a signed retainer lives here, not in the
   Pipeline (that's for work you might still win). Each entry reconciles
   against the bank rhythm by name: already paying → tracked from the bank
   automatically; not yet → it feeds this month's expectations and the
   13-week cash-flow floor from its start date. */
function RetainerBookCard({ retainers, bankRows, onChange }: {
  retainers: Retainer[]; bankRows: ClientRow[]; onChange: (r: Retainer[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [client, setClient] = useState('');
  const [monthly, setMonthly] = useState('');
  const [start, setStart] = useState('');

  async function add() {
    if (!client.trim()) { toast('Name the client'); return; }
    const r = await api.retainerAdd({ client, monthly: Number(monthly) || 0, startDate: start });
    if (r?.ok) { onChange(r.retainers); setClient(''); setMonthly(''); setStart(''); setOpen(false); toast('Added to the book — it feeds the cash flow now'); }
  }
  async function patch(id: string, fields: Partial<Retainer>) {
    const r = await api.retainerUpdate({ id, ...fields });
    if (r?.ok) onChange(r.retainers);
  }
  async function remove(id: string) {
    const r = await api.retainerDelete(id);
    if (r?.ok) onChange(r.retainers);
  }

  const agreed = retainers.filter((r) => r.status === 'active').reduce((s, r) => s + r.monthly, 0);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="spread" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div className="eyebrow">The agreed book</div>
          <h3>Retainer book</h3>
          <p className="small fade" style={{ margin: '4px 0 0', maxWidth: 560 }}>
            Ongoing retainers you've signed — this is their home, not Pipeline. One that already pays
            through the bank is tracked automatically; a new signing feeds the forecast from its start
            date until the first payment lands.
          </p>
        </div>
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          {agreed > 0 && <span className="small fade">Agreed: <span className="money">{money(agreed)}</span>/mo</span>}
          <button className="btn gold sm" onClick={() => setOpen((o) => !o)}>{open ? 'Close' : '+ Add retainer'}</button>
        </div>
      </div>

      {open && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <input className="inp" style={{ width: 200 }} placeholder="Client" value={client}
            onChange={(e) => setClient(e.target.value)} autoFocus />
          <input className="inp num" style={{ width: 110 }} placeholder="£ / month" value={monthly}
            onChange={(e) => setMonthly(e.target.value)} />
          <input className="inp" style={{ width: 'auto' }} type="date" value={start}
            onChange={(e) => setStart(e.target.value)} title="Start date (blank = already running)" />
          <button className="btn gold sm" onClick={add}>Add</button>
        </div>
      )}

      {retainers.length > 0 && (
        <table className="t" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Client</th><th style={{ textAlign: 'right' }}>Agreed / mo</th><th>Start</th>
              <th>Status</th><th>Bank tracking</th><th></th>
            </tr>
          </thead>
          <tbody>
            {retainers.map((r) => <RetainerTr key={r.id} r={r} bankRows={bankRows} patch={patch} remove={remove} />)}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RetainerTr({ r, bankRows, patch, remove }: {
  r: Retainer; bankRows: ClientRow[];
  patch: (id: string, f: Partial<Retainer>) => void; remove: (id: string) => void;
}) {
  const [monthly, setMonthly] = useState(String(r.monthly || ''));
  const match = bankRows.find((c) => sameClient(c.entity, r.client));
  const ended = r.status === 'ended';
  return (
    <tr style={ended ? { opacity: 0.5 } : undefined}>
      <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{r.client}</td>
      <td style={{ textAlign: 'right' }}>
        <input className="inp cell num" value={monthly} onChange={(e) => setMonthly(e.target.value)}
          onBlur={() => Number(monthly) !== r.monthly && patch(r.id, { monthly: Number(monthly) || 0 })} />
      </td>
      <td className="small">{r.startDate || '—'}</td>
      <td>
        <select className="inp cell" value={r.status} onChange={(e) => patch(r.id, { status: e.target.value as Retainer['status'] })}>
          <option value="active">Active</option><option value="paused">Paused</option><option value="ended">Ended</option>
        </select>
      </td>
      <td className="small">
        {match ? (
          <>
            <span className={`pill ${match.status === 'ontrack' ? 'pass' : match.status === 'late' ? 'warn' : 'fail'}`}>
              via bank · {match.status === 'ontrack' ? 'on track' : match.status === 'late' ? 'late' : 'gone quiet'}
            </span>
            <span className="fade"> typical {money(match.medianMonthly)}/mo</span>
            {r.monthly > 0 && match.medianMonthly > 0 && Math.abs(match.medianMonthly - r.monthly) > Math.max(50, r.monthly * 0.1) && (
              <span style={{ color: 'var(--warn)' }}> — bank pays {money(match.medianMonthly)} vs {money(r.monthly)} agreed</span>
            )}
          </>
        ) : (
          <span className="fade">not in the bank yet — feeds the forecast{r.startDate ? ` from ${r.startDate}` : ''}</span>
        )}
      </td>
      <td style={{ textAlign: 'right' }}><button className="linky" onClick={() => remove(r.id)}>remove</button></td>
    </tr>
  );
}

function MiniTot({ label, v, tone }: { label: string; v: number; tone?: string }) {
  return (
    <div style={{ textAlign: 'right' }}>
      <div className="money" style={{ fontSize: 19, color: tone }}>{money(v)}</div>
      <div className="small fade">{label}</div>
    </div>
  );
}

function ClientTr({ r, monthKeys, invoices, asOf, open, toggle }: {
  r: ClientRow; monthKeys: string[]; invoices: OutstandingInvoice[]; asOf: string;
  open: boolean; toggle: () => void;
}) {
  const owed = invoices.reduce((s, i) => s + i.amountDue, 0);
  const overdueDays = (due: string) =>
    due ? Math.floor((new Date(asOf).getTime() - new Date(due).getTime()) / 86400000) : 0;
  return (
    <>
      <tr onClick={toggle} style={{ cursor: 'pointer' }}>
        <td style={{ fontWeight: 600, color: 'var(--ink)' }}>
          {r.entity}
          {owed > 0 && <span className="pill warn" style={{ marginLeft: 8 }}>{money(owed)} invoiced</span>}
        </td>
        <td style={{ textAlign: 'right' }} className="money">{money(r.total)}</td>
        <td style={{ textAlign: 'right' }} className="money">{r.cadence === 'one-off' ? '—' : money(r.medianMonthly)}</td>
        <td className="small">{r.cadence}</td>
        <td style={{ textAlign: 'right' }} className="small">{r.lastPaid} <span className="fade">({r.daysSince}d)</span></td>
        <td style={{ textAlign: 'right' }}><span className={`pill ${STATUS_PILL[r.status]}`}>{STATUS_LABEL[r.status]}</span></td>
      </tr>
      {open && (
        <tr className="expand">
          <td colSpan={6}>
            <div className="monthgrid">
              {monthKeys.map((k) => (
                <div className="mg" key={k}>
                  <div className="mg-m">{k.slice(5)}</div>
                  <div className={`mg-v ${r.months[k] ? '' : 'none'}`}>{r.months[k] ? moneyShort(r.months[k]) : '—'}</div>
                </div>
              ))}
              <div className="small fade" style={{ alignSelf: 'center', marginLeft: 8 }}>{r.payments} payments</div>
            </div>
            {invoices.length > 0 && (
              <div className="small" style={{ marginTop: 10 }}>
                <b>Outstanding in Xero:</b>{' '}
                {invoices.map((i, idx) => {
                  const od = overdueDays(i.dueDate);
                  return (
                    <span key={idx}>
                      {idx > 0 && ' · '}
                      {i.number || 'no number'} <span className="money">{money(i.amountDue)}</span>
                      {i.dueDate && <span className={od > 0 ? '' : 'fade'}>
                        {' '}due {i.dueDate}{od > 0 ? ` (${od}d overdue)` : ''}
                      </span>}
                    </span>
                  );
                })}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
