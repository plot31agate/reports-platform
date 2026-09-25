/* 3.2 Funnel inputs — counts only. Every field can stay blank. */
import { CONSENT_KEYS, FUNNEL_STAGES, SCOPES } from '../lib/model';
import type { AbuserSource, Snapshot } from '../lib/model';
import type { ReactNode } from 'react';
import { NumInput, Section } from '../components/ui';

export function Inputs({ snap, update }: { snap: Snapshot; update: (fn: (s: Snapshot) => Snapshot) => void }) {
  return (
    <>
      <Section title="Funnel counts" sub="Player counts from Customer.io. Fill what you have: sportsbook and casino splits are optional, and blanks show as —.">
        <div className="tscroll">
          <table className="t">
            <thead><tr><th>Stage</th>{SCOPES.map((sc) => <th key={sc.key}>{sc.label}</th>)}</tr></thead>
            <tbody>
              {FUNNEL_STAGES.map((st) => (
                <tr key={st.key}>
                  <td style={{ color: 'var(--ink)', fontWeight: 500, verticalAlign: 'middle' }}>{st.label}</td>
                  {SCOPES.map((sc) => (
                    <td key={sc.key}>
                      <NumInput value={snap.funnel[sc.key][st.key]} onChange={(v) => update((s) => { s.funnel[sc.key][st.key] = v; return s; })} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <div className="grid g2">
        <Section title="Exclusions" sub="Who we must, or should, leave out">
          <div className="formgrid">
            <label className="f">Self-excluded / GAMSTOP</label>
            <NumInput value={snap.exclusions.selfExcluded} onChange={(v) => update((s) => { s.exclusions.selfExcluded = v; return s; })} />
            <label className="f">Suspected bonus abusers</label>
            <NumInput value={snap.exclusions.abusers} onChange={(v) => update((s) => { s.exclusions.abusers = v; return s; })} />
            <label className="f">Abuser figure source</label>
            <select className="inp" value={snap.exclusions.abuserSource} onChange={(e) => update((s) => { s.exclusions.abuserSource = e.target.value as AbuserSource; return s; })}>
              <option value="system">System flag</option>
              <option value="rules">Rule-based</option>
              <option value="estimate">Manual estimate</option>
            </select>
            <label className="f">…of which made 2+ deposits</label>
            <NumInput value={snap.exclusions.abusersPastFtd} onChange={(v) => update((s) => { s.exclusions.abusersPastFtd = v; return s; })} />
          </div>
          <div className="kpi-note" style={{ marginTop: 10 }}>
            The genuine-players funnel assumes abusers reach FTD (they deposit to claim), and only the "2+ deposits" figure comes off later stages. Leave it blank if unknown (treated as 0).
          </div>
        </Section>

        <Section title="Marketing opt-ins" sub="UKGC: consent is per product and per channel, so each is counted separately">
          <div className="formgrid">
            {CONSENT_KEYS.map((c) => (
              <FragmentRow key={c.key} label={c.label}>
                <NumInput value={snap.consent[c.key]} onChange={(v) => update((s) => { s.consent[c.key] = v; return s; })} />
              </FragmentRow>
            ))}
          </div>
        </Section>
      </div>

      <Section title="Money inputs" sub={<><span className="pill warn">client to confirm</span> <span style={{ marginLeft: 6 }}>Optional. Only used for the revenue range in the opportunity estimate.</span></>}>
        <div className="formgrid" style={{ maxWidth: 560 }}>
          <label className="f">Average deposit</label>
          <NumInput prefix="£" value={snap.money.avgDeposit} onChange={(v) => update((s) => { s.money.avgDeposit = v; return s; })} />
          <label className="f">Avg monthly NGR per active player</label>
          <NumInput prefix="£" value={snap.money.ngrPerActive} onChange={(v) => update((s) => { s.money.ngrPerActive = v; return s; })} />
        </div>
      </Section>
    </>
  );
}

function FragmentRow({ label, children }: { label: string; children: ReactNode }) {
  return <><label className="f">{label}</label>{children}</>;
}
