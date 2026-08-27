/* Reports.tsx — board reports. Generate a Claude-written board pack over a
   month's figures, read it here, and copy a read-only share link a director can
   open without a login (board.php, HMAC-guarded). Past reports are listed and
   re-openable. */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { FinanceModel, BoardReport, BoardListItem } from '../lib/api';
import { money } from '../lib/finance';
import { Working, NeedsKey, Empty, toast } from '../components/ui';

export function Reports() {
  const [model, setModel] = useState<FinanceModel | null>(null);
  const [list, setList] = useState<BoardListItem[]>([]);
  const [month, setMonth] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsKey, setNeedsKey] = useState(false);
  const [err, setErr] = useState('');
  const [active, setActive] = useState<{ report: BoardReport; shareUrl: string } | null>(null);

  const loadList = () => api.reports().then((r) => r && setList(r.reports));
  useEffect(() => {
    api.model().then((m) => { if (m) { setModel(m); setMonth(m.meta.last ?? ''); } });
    loadList();
  }, []);

  async function generate() {
    if (!month) return;
    setBusy(true); setErr(''); setActive(null);
    const r = await api.reportGenerate(month);
    setBusy(false);
    if (!r) { setErr('The API is unreachable.'); return; }
    if (r.needsKey) { setNeedsKey(true); return; }
    if (!r.ok || !r.report) { setErr(r.error || 'Could not generate the report.'); return; }
    setActive({ report: r.report, shareUrl: r.shareUrl || '' });
    toast('Board report ready');
    loadList();
  }

  async function open(id: string) {
    const r = await api.report(id);
    if (r?.ok) { setActive({ report: r.report, shareUrl: r.shareUrl }); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  }
  async function del(id: string) {
    if (!confirm('Delete this board report? The share link stops working.')) return;
    const r = await api.reportDelete(id);
    if (r?.ok) { toast('Deleted'); loadList(); if (active?.report.id === id) setActive(null); }
  }

  if (needsKey) return <NeedsKey />;
  if (!model) return <Working label="Loading…" />;
  if (model.meta.count === 0) return (
    <div className="card accent" style={{ textAlign: 'center', padding: 40 }}>
      <div className="eyebrow">No data yet</div>
      <p className="fade" style={{ margin: '10px 0 0' }}>Import a Xero Profit &amp; Loss first — a board report is written from it.</p>
    </div>
  );

  return (
    <>
      <div className="card accent" style={{ marginBottom: 16 }}>
        <div className="spread" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="eyebrow">Generate</div>
            <h3>A board pack, written from your numbers</h3>
            <p className="fade small" style={{ margin: '4px 0 0', maxWidth: 460 }}>
              Executive summary, performance, cash, risks, recommendations, a UK tax note and an outlook — then a link to share.
            </p>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <select className="inp" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)}>
              {model.periods.slice().reverse().map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
            <button className="btn gold" disabled={busy} onClick={generate}>{busy ? 'Writing…' : 'Generate report'}</button>
          </div>
        </div>
        {err && <p className="small" style={{ color: 'var(--fail)', marginTop: 10 }}>{err}</p>}
      </div>

      {busy && <div className="card" style={{ marginBottom: 16 }}><Working label="Writing the board report…" /></div>}

      {active && <BoardView data={active} />}

      <div className="card">
        <div className="eyebrow">History</div>
        <h3 style={{ marginBottom: 12 }}>Past reports</h3>
        {list.length === 0 ? <Empty>No reports yet.</Empty> : (
          <table className="t">
            <thead><tr><th>Report</th><th>Period</th><th>Generated</th><th></th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{r.title}</td>
                  <td>{r.periodLabel}</td>
                  <td className="small fade">{new Date(r.generatedAt * 1000).toLocaleDateString('en-GB')}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="linky" onClick={() => open(r.id)}>open</button>
                    {' · '}<button className="linky" onClick={() => del(r.id)}>delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

interface KpiShape { revenue?: number; grossProfit?: number; netProfit?: number; cash?: number; grossMargin?: number | null; runwayMonths?: number | null; }

function BoardView({ data }: { data: { report: BoardReport; shareUrl: string } }) {
  const { report, shareUrl } = data;
  const n = report.narrative;
  const k = report.kpis as KpiShape;

  function copy() {
    if (!shareUrl) { toast('Share link needs the server key'); return; }
    navigator.clipboard?.writeText(shareUrl).then(() => toast('Share link copied'), () => toast('Copy failed'));
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="spread" style={{ flexWrap: 'wrap', gap: 12, marginBottom: 8 }}>
        <div>
          <div className="eyebrow">Board Report · {report.periodLabel}</div>
          <h2 style={{ fontSize: 24, marginTop: 4 }}>{report.title}</h2>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <button className="btn ghost sm" onClick={copy}>Copy share link</button>
          {shareUrl && <a className="btn sm" href={shareUrl} target="_blank" rel="noreferrer">Open shareable page →</a>}
        </div>
      </div>

      <div className="grid g4" style={{ marginBottom: 16 }}>
        <MiniKpi label="Revenue" v={k.revenue} />
        <MiniKpi label="Gross profit" v={k.grossProfit} note={k.grossMargin != null ? `${Math.round(k.grossMargin)}% margin` : undefined} />
        <MiniKpi label="Net profit" v={k.netProfit} />
        <MiniKpi label="Cash" v={k.cash} note={k.runwayMonths != null ? `~${k.runwayMonths} mo runway` : undefined} />
      </div>

      <Section title="Executive summary" body={n.summary} />
      <Section title="Performance" body={n.performance} />
      <Section title="Costs & efficiency" body={n.costs} />
      <Section title="Cash position" body={n.cashPosition} />
      <div className="grid g2" style={{ alignItems: 'start', margin: '4px 0' }}>
        <ListSection title="Risks & watch items" items={n.risks} tone="var(--warn)" />
        <ListSection title="Recommendations" items={n.recommendations} tone="var(--pass)" />
      </div>
      <Section title="Outlook" body={n.outlook} />
      <div className="pc-note" style={{ marginTop: 6 }}><b>Tax &amp; compliance note.</b> {n.taxNote}</div>
    </div>
  );
}

function MiniKpi({ label, v, note }: { label: string; v?: number; note?: string }) {
  return (
    <div className="card stat" style={{ boxShadow: 'var(--shadow-sm)' }}>
      <div className="n" style={{ fontSize: 26 }}>{money(v ?? null)}</div>
      <div className="l">{label}</div>
      {note && <div className="kpi-note" style={{ marginTop: 6 }}>{note}</div>}
    </div>
  );
}

function Section({ title, body }: { title: string; body: string }) {
  if (!body) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="eyebrow">{title}</div>
      <p style={{ margin: '6px 0 0', lineHeight: 1.6, color: 'var(--body)' }}>{body}</p>
    </div>
  );
}

function ListSection({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  if (!items?.length) return null;
  return (
    <div>
      <div className="eyebrow" style={{ color: tone }}>{title}</div>
      <ul style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.6, color: 'var(--body)' }}>
        {items.map((x, i) => <li key={i}>{x}</li>)}
      </ul>
    </div>
  );
}
