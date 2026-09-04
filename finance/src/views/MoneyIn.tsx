/* MoneyIn.tsx — every client, on one screen: what they've paid this year,
   their typical month, when they last paid and whether their cadence has
   slipped. This is where the retainers feed in — a regular payer whose gap
   stretches shows up as "late" and then "quiet" without anyone having to
   remember to check. */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { PipelineData } from '../lib/api';
import { money, moneyShort } from '../lib/finance';
import { useBank } from '../lib/useBank';
import { clientRows, monthlyFlows, expectedThisMonth } from '../lib/bank';
import type { ClientRow, Enriched, ExpectedRow } from '../lib/bank';
import { Stat, Working, OfflineNote, Empty } from '../components/ui';

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

  return (
    <>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Stat n={money(totalRev)} label="Client revenue this year" note={`${rows.length} paying clients`} />
        <Stat n={money(regulars.reduce((s, r) => s + r.medianMonthly, 0))} label="Retainer run-rate / month"
          note={`${regulars.length} regular payers`} />
        <Stat n={top ? `${Math.round((top.total / Math.max(1, totalRev)) * 100)}%` : '—'}
          label="Biggest client's share" note={top ? top.entity : undefined} />
        <Stat n={String(attention)} neg={attention > 0} label="Need attention" note="late or gone quiet" />
      </div>

      <ThisMonthCard txs={txs} go={go} />

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
                open={openRow === r.entity}
                toggle={() => setOpenRow(openRow === r.entity ? null : r.entity)} />
            ))}
          </tbody>
        </table>
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
function ThisMonthCard({ txs, go }: { txs: Enriched[]; go: (v: string) => void }) {
  const [pipe, setPipe] = useState<PipelineData | null>(null);
  useEffect(() => { api.pipeline().then(setPipe); }, []);

  const exp = expectedThisMonth(txs);
  const monthName = exp.monthKey
    ? new Date(exp.monthKey + '-01').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    : '';

  // Won pipeline retainers that aren't already regular bank payers: expected
  // money the bank history can't see yet.
  const bankNames = new Set(exp.rows.map((r) => r.entity.toLowerCase()));
  const pipeRows: ExpectedRow[] = (pipe?.opps ?? [])
    .filter((o) => o.stage === 'won' && o.value > 0)
    .filter((o) => ![...bankNames].some((n) => n.includes(o.client.toLowerCase()) || o.client.toLowerCase().includes(n.split(' (')[0])))
    .map((o) => ({
      entity: `${o.client} (won, ${o.type})`, expected: o.value, received: 0, due: o.value,
      status: 'due' as const, source: 'pipeline' as const,
    }));

  const all = [...exp.rows, ...pipeRows];
  const totalExpected = exp.expected + pipeRows.reduce((s, r) => s + r.expected, 0);
  const totalDue = exp.due + pipeRows.reduce((s, r) => s + r.due, 0);
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
        Regular payers are projected at their typical month; won work from{' '}
        <button className="linky" onClick={() => go('pipeline')}>Pipeline</button> rides on top until it
        starts paying through the bank{exp.otherReceived > 0 ? <> — plus {money(exp.otherReceived)} already in this month from one-off/irregular payers</> : null}.
        Gone-quiet retainers aren't counted as expected — they're on the watchlist instead.
      </div>
    </div>
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

function ClientTr({ r, monthKeys, open, toggle }: {
  r: ClientRow; monthKeys: string[]; open: boolean; toggle: () => void;
}) {
  return (
    <>
      <tr onClick={toggle} style={{ cursor: 'pointer' }}>
        <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{r.entity}</td>
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
          </td>
        </tr>
      )}
    </>
  );
}
