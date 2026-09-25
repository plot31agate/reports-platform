/* 3.6 Opportunity estimator — percentage-point uplifts on the genuine funnel,
   plus client-agreed targets per KPI. No hardcoded benchmarks. */
import { UPLIFTS } from '../lib/model';
import type { Snapshot } from '../lib/model';
import { fmtGBP, fmtN, fmtPP, fmtPct, isNum, kpis, opportunity } from '../lib/calc';
import { NumInput, Section, Stat } from '../components/ui';
import { AbuserWarning } from './Overview';

export function Opportunity({ snap, update }: { snap: Snapshot; update: (fn: (s: Snapshot) => Snapshot) => void }) {
  const o = opportunity(snap);
  const hasG = isNum(snap.exclusions.abusers);
  const k = kpis(snap);
  return (
    <>
      <div className="estimate-banner">Estimate for discussion, not a forecast</div>
      {!hasG && <div className="note-strip warn" style={{ marginBottom: 14 }}>Based on genuine players only: enter a suspected abuser figure (Funnel inputs) to run the estimate. If there are none, enter 0.</div>}
      <AbuserWarning snap={snap} />

      <div className="grid g2" style={{ marginTop: 14 }}>
        <Section title="Uplift (percentage points)" sub="Applied to the genuine-players funnel. Each stage compounds into the next.">
          {UPLIFTS.map((u) => (
            <div className="slider-row" key={u.key}>
              <span className="small" style={{ color: 'var(--ink)', fontWeight: 500 }}>{u.label}</span>
              <input type="range" min={0} max={20} step={0.5} value={snap.uplifts[u.key]} onChange={(e) => update((s) => { s.uplifts[u.key] = Number(e.target.value); return s; })} />
              <NumInput value={snap.uplifts[u.key]} suffix="pts" onChange={(v) => update((s) => { s.uplifts[u.key] = v ?? 0; return s; })} />
            </div>
          ))}
          <div className="kpi-note">Reactivation applies to genuine depositors not active in the last 30 days ({fmtN(o.lapsedPool)}).</div>
        </Section>

        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', alignContent: 'start' }}>
          <Stat n={fmtN(o.extraVerified)} l="Extra verified players" />
          <Stat n={fmtN(o.extraDepositors)} l="Extra depositors" />
          <Stat n={fmtN(o.extraRepeat)} l="Extra repeat depositors" />
          <Stat n={fmtN(o.extraReactivated)} l="Extra reactivated players" />
        </div>
      </div>

      <Section
        title="Estimated extra monthly revenue"
        sub="(extra repeat depositors + extra reactivated) × avg monthly NGR per active player. Low = 50% of mid, high = 150%."
      >
        {isNum(o.revenue.mid) ? (
          <div className="grid g4">
            <Stat n={fmtGBP(o.revenue.low)} l="Low" />
            <Stat n={fmtGBP(o.revenue.mid)} l="Mid" />
            <Stat n={fmtGBP(o.revenue.high)} l="High" />
            <Stat n={fmtGBP(o.revenue.firstDepositValue)} l="One-off first-deposit value" hint="extra depositors × avg deposit" />
          </div>
        ) : <div className="fade">Fill the money inputs (client to confirm) to see a revenue range.</div>}
      </Section>

      <Section title="KPI targets" sub={`Agreed with the client. Current rates are ${hasG ? 'genuine players' : 'all players (no abuser figure yet)'}.`}>
        <div className="tscroll">
          <table className="t">
            <thead><tr><th>KPI</th><th style={{ textAlign: 'right' }}>Current</th><th style={{ width: 150 }}>Target</th><th style={{ textAlign: 'right' }}>Gap</th></tr></thead>
            <tbody>
              {k.map((r) => (
                <tr key={r.key}>
                  <td style={{ color: 'var(--ink)', fontWeight: 500, verticalAlign: 'middle' }}>{r.label}</td>
                  <td style={{ textAlign: 'right', verticalAlign: 'middle' }} className="money">{fmtPct(r.current)}</td>
                  <td><NumInput value={snap.targets[r.key] ?? null} suffix="%" onChange={(v) => update((s) => { s.targets[r.key] = v; return s; })} /></td>
                  <td style={{ textAlign: 'right', verticalAlign: 'middle', color: isNum(r.gap) ? (r.gap > 0 ? 'var(--fail)' : 'var(--pass)') : undefined }}>{fmtPP(r.gap)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}
