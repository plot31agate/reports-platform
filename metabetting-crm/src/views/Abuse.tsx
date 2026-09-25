/* 3.5 Bonus abuse rules worksheet — signals, weights, data availability,
   and the suggested abuse_risk rule that falls out of them. */
import { ABUSE_RULES } from '../lib/model';
import type { Snapshot } from '../lib/model';
import { abuseRuleText } from '../lib/calc';
import { CopyButton, NumInput, Section } from '../components/ui';
import { AbuserWarning } from './Overview';

export function Abuse({ snap, update }: { snap: Snapshot; update: (fn: (s: Snapshot) => Snapshot) => void }) {
  const setRule = (id: string, fn: (r: Snapshot['abuseRules'][number]) => void) => update((s) => { fn(s.abuseRules.find((r) => r.id === id)!); return s; });
  const out = abuseRuleText(snap);
  return (
    <>
      <div className="note-strip" style={{ marginBottom: 14 }}>
        Final abuse decisions sit with the client's risk team. The CRM flag only controls <b>who gets offers</b>: flagged players still receive service and safer gambling messages.
      </div>
      <AbuserWarning snap={snap} />

      <Section title="Abuse signals" sub="Switch signals on or off, weight them, and mark whether the data exists today. Signals without data join the Swifty request list.">
        <div className="tscroll">
          <table className="t">
            <thead><tr><th>On</th><th>Signal</th><th>Needs</th><th style={{ width: 110 }}>Weight</th><th>Data available?</th></tr></thead>
            <tbody>
              {ABUSE_RULES.map((d) => {
                const r = snap.abuseRules.find((x) => x.id === d.id)!;
                return (
                  <tr key={d.id} style={{ opacity: r.enabled ? 1 : 0.5 }}>
                    <td><input type="checkbox" checked={r.enabled} onChange={(e) => setRule(d.id, (x) => { x.enabled = e.target.checked; })} /></td>
                    <td>
                      <div style={{ color: 'var(--ink)', fontWeight: 500 }}>{d.label}</div>
                      {d.param && (
                        <div className="row small" style={{ marginTop: 6, gap: 8 }}>
                          <span className="fade">{d.param.label}</span>
                          <NumInput width={110} value={r.param} suffix="days" onChange={(v) => setRule(d.id, (x) => { x.param = v; })} />
                        </div>
                      )}
                    </td>
                    <td className="small fade">{d.data}</td>
                    <td><NumInput value={r.weight} onChange={(v) => setRule(d.id, (x) => { x.weight = v ?? 0; })} /></td>
                    <td>
                      <div className="seg3">
                        <button className={`st-present ${r.dataAvailable ? 'on' : ''}`} onClick={() => setRule(d.id, (x) => { x.dataAvailable = true; })}>Yes</button>
                        <button className={`st-missing ${!r.dataAvailable ? 'on' : ''}`} onClick={() => setRule(d.id, (x) => { x.dataAvailable = false; })}>No</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ marginTop: 14, gap: 18, flexWrap: 'wrap' }}>
          <span className="small fade">Risk bands, as % of max score:</span>
          <span className="row small" style={{ gap: 6 }}>Medium from <NumInput width={90} value={snap.abuseBands.medium} suffix="%" onChange={(v) => update((s) => { s.abuseBands.medium = v ?? 0; return s; })} /></span>
          <span className="row small" style={{ gap: 6 }}>High from <NumInput width={90} value={snap.abuseBands.high} suffix="%" onChange={(v) => update((s) => { s.abuseBands.high = v ?? 0; return s; })} /></span>
        </div>
      </Section>

      <Section
        title="Suggested abuse_risk rule"
        sub={out.usable < out.max ? `${out.usable} of ${out.max} points scoreable today: request the rest from Swifty, or build from what exists` : 'Every enabled signal has data'}
        right={<CopyButton text={out.text} />}
      >
        <pre className="spec">{out.text}</pre>
      </Section>
    </>
  );
}
