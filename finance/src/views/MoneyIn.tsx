/* MoneyIn.tsx — every client, on one screen: what they've paid this year,
   their typical month, when they last paid and whether their cadence has
   slipped. This is where the retainers feed in — a regular payer whose gap
   stretches shows up as "late" and then "quiet" without anyone having to
   remember to check. */
import { useState } from 'react';
import { money, moneyShort } from '../lib/finance';
import { useBank } from '../lib/useBank';
import { clientRows, monthlyFlows } from '../lib/bank';
import type { ClientRow } from '../lib/bank';
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
