/* 3.8 Client summary — one printable page (browser print → PDF) plus a
   Markdown copy, with a compare block when an earlier snapshot is loaded. */
import { FUNNEL_STAGES } from '../lib/model';
import type { Snapshot } from '../lib/model';
import { audience, biggestDrop, dataRequests, fmtGBP, fmtN, genuineFunnel, isNum, opportunity, roadmap, topSegments } from '../lib/calc';
import { delta, fmtH, headlines, markdown } from '../lib/summary';
import { download, exportName, pickJSON } from '../lib/store';
import { CopyButton, toast } from '../components/ui';
import { FunnelChart } from '../components/FunnelChart';
import dfLogo from '../assets/df/logo-white.png';

// Keeps the printed page to one sheet; the Markdown copy always has the full list.
const REQ_CAP = 10;

export function Summary({ snap, compare, setCompare }: { snap: Snapshot; compare: Snapshot | null; setCompare: (s: Snapshot | null) => void }) {
  const h = headlines(snap);
  const prev = compare ? headlines(compare) : null;
  const drop = biggestDrop(snap.funnel.total);
  const hasG = isNum(snap.exclusions.abusers);
  const g = genuineFunnel(snap);
  const o = opportunity(snap);
  const reqs = dataRequests(snap);
  const { phases, blocked } = roadmap(snap);
  const aud = audience(snap);
  const top = topSegments(snap);
  const key = ['registered', 'ftd', 'active30', 'verify', 'ftdRate', 'second', 'marketable', 'abusers'];

  return (
    <>
      <div className="row no-print" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <button className="btn" onClick={() => window.print()}>Print / save as PDF</button>
        <CopyButton text={() => markdown(snap, compare)} label="Copy Markdown" small={false} />
        <button className="btn ghost" onClick={() => download(exportName(snap, 'md'), markdown(snap, compare), 'text/markdown')}>Download .md</button>
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={() => pickJSON().then((c) => { setCompare(c); toast(`Comparing with ${c.meta.snapshotDate || 'earlier snapshot'}`); }).catch((e) => e?.message !== 'No file' && toast(e.message))}>
          {compare ? 'Change comparison…' : 'Compare with earlier snapshot…'}
        </button>
        {compare && <button className="btn ghost" onClick={() => setCompare(null)}>Clear comparison</button>}
      </div>

      <div className="onepager">
        <div className="op-head">
          <img src={dfLogo} alt="Digital Footprints" style={{ height: 22 }} />
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontWeight: 650, fontSize: 16 }}>{snap.meta.client}: CRM snapshot</div>
            <div style={{ fontSize: 11, opacity: 0.75 }}>{snap.meta.snapshotDate || 'undated'}</div>
          </div>
        </div>
        {snap.meta.isExample && <div className="example-flag">EXAMPLE DATA: dummy figures for demo only</div>}

        <div className="op-kpis">
          {key.map((k) => {
            const x = h.find((y) => y.key === k)!;
            const p = prev?.find((y) => y.key === k);
            return (
              <div key={k} className="op-kpi">
                <div className="n">{fmtH(x)}</div>
                <div className="l">{x.label}</div>
                {prev && <div className="d">{delta(x, p)} vs {compare!.meta.snapshotDate || 'prev'}</div>}
              </div>
            );
          })}
        </div>

        <div className="op-cols">
          <div>
            <div className="op-h">Funnel{hasG ? ' (bars: all players · figures below: genuine)' : ''}</div>
            <FunnelChart compact row={snap.funnel.total} highlight={drop?.step.to ?? null} />
            {hasG && <div className="op-small">Genuine: {FUNNEL_STAGES.slice(0, 5).map((st) => `${st.label.replace(' (FTD)', '')} ${fmtN(g[st.key])}`).join(' · ')}{snap.exclusions.abuserSource !== 'system' ? ' (abuser figure is an estimate)' : ''}</div>}
            {drop && <div className="op-drop"><b>Biggest drop-off: {drop.step.label}.</b> {drop.text}</div>}

            <div className="op-h">Marketable audience (offer sends)</div>
            <div className="op-small">{aud.map((a) => `${a.label} ${fmtN(a.offer)}`).join(' · ')}</div>

            <div className="op-h">Opportunity <span className="op-tag">Estimate for discussion, not a forecast</span></div>
            <div className="op-small">
              +{fmtN(o.extraVerified)} verified · +{fmtN(o.extraDepositors)} depositors · +{fmtN(o.extraRepeat)} repeat depositors · +{fmtN(o.extraReactivated)} reactivated
              {isNum(o.revenue.mid) && <> · <b>{fmtGBP(o.revenue.low)}–{fmtGBP(o.revenue.high)}/month</b> (mid {fmtGBP(o.revenue.mid)})</>}
              <br />Genuine players; uplift {snap.uplifts.verify}/{snap.uplifts.ftd}/{snap.uplifts.second}/{snap.uplifts.reactivation} pts (verify/FTD/2nd deposit/reactivation).
            </div>
          </div>

          <div>
            <div className="op-h">Top 5 priority segments</div>
            <table className="op-t">
              <tbody>
                {top.map((t, i) => (
                  <tr key={t.def.id}>
                    <td>{i + 1}</td>
                    <td><b>{t.def.id}</b> {t.def.name}<div className="op-small">{t.def.workflow}</div></td>
                    <td style={{ textAlign: 'right' }}>{fmtN(t.size.size)}</td>
                    <td>{t.ready.ready ? <span className="pill pass">Ready</span> : <span className="pill fail">Blocked</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="op-h">Data requests for Swifty ({reqs.length})</div>
            <div className="op-small">
              {reqs.length ? reqs.slice(0, REQ_CAP).map((r) => r.label).join(' · ') : 'None outstanding'}
              {reqs.length > REQ_CAP && <i> · +{reqs.length - REQ_CAP} more (full list in the Markdown copy)</i>}
            </div>

            <div className="op-h">Roadmap</div>
            {phases.map((p) => (
              <div key={p.key} className="op-small"><b>{p.title.replace('Phase ', 'P').replace(': data fixes', '')} · {p.when}:</b> {[...p.items.map((i) => i.id), ...(p.key === 'p0' ? [`${reqs.length} data requests`] : p.extras)].join(', ') || '—'}</div>
            ))}
            {blocked.length > 0 && <div className="op-small"><b>After data fix:</b> {blocked.map((i) => i.id).join(', ')}</div>}
          </div>
        </div>

        {compare && prev && (
          <>
            <div className="op-h">Compared with previous snapshot ({compare.meta.snapshotDate || 'undated'})</div>
            <div className="op-small" style={{ margin: '0 22px' }}>
              Changes for the headline figures are under each tile above. Also: {h.filter((x) => !key.includes(x.key)).map((x) => {
                const p = prev.find((y) => y.key === x.key);
                return `${x.label} ${p ? fmtH(p) : '—'} → ${fmtH(x)} (${delta(x, p)})`;
              }).join(' · ')}
            </div>
          </>
        )}
        <div className="op-foot">Digital Footprints · Counts only, no personal data · Prepared {snap.meta.snapshotDate}</div>
      </div>
    </>
  );
}
