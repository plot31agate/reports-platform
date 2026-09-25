/* 3.3 Calculated overview — conversion, biggest drop-off, genuine players,
   marketable audience, funnel chart. */
import { useState } from 'react';
import { FUNNEL_STAGES, SCOPES } from '../lib/model';
import type { Scope, Snapshot } from '../lib/model';
import { STEPS, audience, biggestDrop, fmtN, fmtPct, genuineFunnel, isNum, rates } from '../lib/calc';
import { FunnelChart } from '../components/FunnelChart';
import { Section, Stat } from '../components/ui';

export function AbuserWarning({ snap }: { snap: Snapshot }) {
  if (!isNum(snap.exclusions.abusers)) return null;
  const src = snap.exclusions.abuserSource;
  if (src === 'system') return <div className="note-strip ok">Abuser figure is <b>system-backed</b> (platform flag).</div>;
  return (
    <div className="note-strip warn">
      Abuser figure is a <b>{src === 'estimate' ? 'manual estimate' : 'rule-based estimate'}</b>. Check it before it drives decisions: every "genuine players" number depends on it.
    </div>
  );
}

export function Overview({ snap }: { snap: Snapshot }) {
  const [scope, setScope] = useState<Scope>('total');
  const row = snap.funnel[scope];
  const r = rates(row);
  const drop = biggestDrop(row);
  const g = genuineFunnel(snap);
  const gr = rates(g);
  const gdrop = biggestDrop(g);
  const hasG = isNum(snap.exclusions.abusers);
  const aud = audience(snap);

  return (
    <>
      <div className="row" style={{ marginBottom: 14, gap: 6 }}>
        {SCOPES.map((sc) => (
          <button key={sc.key} className={`btn sm ${scope === sc.key ? '' : 'ghost'}`} onClick={() => setScope(sc.key)}>{sc.label}</button>
        ))}
      </div>

      <div className="grid g4" style={{ marginBottom: 14 }}>
        <Stat n={fmtN(row.registered)} l="Registered" />
        <Stat n={fmtPct(r.verify)} l="Verify rate" hint="verified ÷ registered" />
        <Stat n={fmtPct(r.ftd)} l="FTD rate" hint="FTD ÷ verified" />
        <Stat n={fmtPct(r.second)} l="Second-deposit rate" hint="2+ deposits ÷ FTD" />
      </div>

      {drop && (
        <div className="card dropcard" style={{ marginBottom: 14 }}>
          <div className="eyebrow" style={{ color: 'var(--fail)' }}>Biggest drop-off · {drop.step.label}</div>
          <div style={{ marginTop: 6, color: 'var(--ink)', fontWeight: 500 }}>{drop.text}</div>
        </div>
      )}

      <div className="grid g2">
        <Section title={`Funnel: ${SCOPES.find((s) => s.key === scope)!.label.toLowerCase()}`} sub="All players, abusers included">
          <FunnelChart row={row} highlight={drop?.step.to ?? null} />
          <table className="t compact" style={{ marginTop: 12 }}>
            <tbody>
              {STEPS.map((s) => <tr key={s.key}><td>{s.label}</td><td style={{ textAlign: 'right' }} className="money">{fmtPct(r[s.key])}</td></tr>)}
              <tr><td>30-day active rate (of depositors)</td><td style={{ textAlign: 'right' }} className="money">{fmtPct(r.active30)}</td></tr>
              <tr><td>7-day active rate (of depositors)</td><td style={{ textAlign: 'right' }} className="money">{fmtPct(r.active7)}</td></tr>
            </tbody>
          </table>
        </Section>

        <Section title="Funnel: genuine players" sub="Total funnel with suspected bonus abusers removed">
          <AbuserWarning snap={snap} />
          {!hasG ? <div className="fade" style={{ marginTop: 8 }}>Enter a suspected abuser figure in Funnel inputs to see this.</div> : (
            <>
              <div style={{ marginTop: 10 }}><FunnelChart row={g} highlight={gdrop?.step.to ?? null} /></div>
              <table className="t compact" style={{ marginTop: 12 }}>
                <tbody>
                  {STEPS.map((s) => <tr key={s.key}><td>{s.label}</td><td style={{ textAlign: 'right' }} className="money">{fmtPct(gr[s.key])}</td></tr>)}
                  <tr><td>30-day active rate (of depositors)</td><td style={{ textAlign: 'right' }} className="money">{fmtPct(gr.active30)}</td></tr>
                </tbody>
              </table>
              {gdrop && <div className="small" style={{ marginTop: 10 }}><b>Biggest genuine drop-off:</b> {gdrop.text}</div>}
            </>
          )}
        </Section>
      </div>

      <Section
        title="Marketable audience"
        sub="Opted in, minus self-excluded (every send) and minus suspected abusers (offer sends). With totals only, both are removed pro rata to their share of the registered base."
      >
        <div className="tscroll">
          <table className="t">
            <thead><tr><th>Product × channel</th><th style={{ textAlign: 'right' }}>Opted in</th><th style={{ textAlign: 'right' }}>Service &amp; content sends</th><th style={{ textAlign: 'right' }}>Offer sends</th><th style={{ textAlign: 'right' }}>% of registered</th></tr></thead>
            <tbody>
              {aud.map((a) => (
                <tr key={a.key}>
                  <td style={{ color: 'var(--ink)', fontWeight: 500 }}>{a.label}</td>
                  <td style={{ textAlign: 'right' }}>{fmtN(a.optedIn)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtN(a.nonOffer)}</td>
                  <td style={{ textAlign: 'right' }} className="money">{fmtN(a.offer)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtPct(isNum(a.offer) && isNum(snap.funnel.total.registered) && snap.funnel.total.registered > 0 ? a.offer / snap.funnel.total.registered : null, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="kpi-note" style={{ marginTop: 8 }}>
          Betting and casino are never combined in one promotion. Self-excluded / GAMSTOP players (X1) are never marketed to on any channel.
        </div>
      </Section>

      <Section title="Stage counts" sub="As entered, all three scopes">
        <div className="tscroll">
          <table className="t">
            <thead><tr><th>Stage</th>{SCOPES.map((s) => <th key={s.key} style={{ textAlign: 'right' }}>{s.label}</th>)}<th style={{ textAlign: 'right' }}>Genuine (total)</th></tr></thead>
            <tbody>
              {FUNNEL_STAGES.map((st) => (
                <tr key={st.key}>
                  <td>{st.label}</td>
                  {SCOPES.map((s) => <td key={s.key} style={{ textAlign: 'right' }}>{fmtN(snap.funnel[s.key][st.key])}</td>)}
                  <td style={{ textAlign: 'right' }}>{fmtN(g[st.key])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}
