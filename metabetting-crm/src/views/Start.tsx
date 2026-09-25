/* Start here — why this exists, the step-by-step checklist, and the glossary. */
import type { Snapshot } from '../lib/model';
import { STAGES, progress, stepDone } from '../lib/checklist';
import { GLOSSARY } from '../lib/guide';

export function Start({ snap, update, go }: { snap: Snapshot; update: (fn: (s: Snapshot) => Snapshot) => void; go: (v: string) => void }) {
  const p = progress(snap);
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const tick = (id: string, v: boolean) => update((s) => { if (v) s.checklist[id] = true; else delete s.checklist[id]; return s; });

  return (
    <>
      <div className="card why-card">
        <div className="eyebrow">Why we’re doing this</div>
        <p className="why-lead">
          Meta Betting has about 30,000 registered players and already uses Customer.io, but we don’t yet know what player data it holds,
          where players drop out, or who we’re legally allowed to message. This tool is how we find out, <b>before</b> we build anything.
        </p>
        <div className="why-grid">
          <div><b>1. What have we got?</b><span>Audit the data in Customer.io and list what’s missing for Swifty Global to supply.</span></div>
          <div><b>2. Where are players leaking?</b><span>Enter the funnel counts and find the biggest drop-off, with bonus abusers taken out.</span></div>
          <div><b>3. What do we build first?</b><span>A ranked list of segments and ready-made journeys, each marked Ready or Blocked by missing data.</span></div>
          <div><b>4. What’s it worth, and when?</b><span>An opportunity estimate, KPI targets and a week-by-week roadmap on one page for the client.</span></div>
        </div>
        <div className="small fade" style={{ marginTop: 12 }}>
          Counts only: no names, emails or player records go in here. Everything is saved in this browser; use Export JSON to keep a copy.
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="spread" style={{ flexWrap: 'wrap' }}>
          <div>
            <h3>Your checklist</h3>
            <div className="small fade">Work top to bottom. Steps with a grey label tick themselves as you fill the tool in; tick the rest yourself.</div>
          </div>
          <div style={{ minWidth: 220 }}>
            <div className="small" style={{ fontWeight: 600, color: 'var(--ink)' }}>{p.done} of {p.total} steps done</div>
            <div className="progress"><div style={{ width: `${pct}%` }} /></div>
          </div>
        </div>
        {p.next && (
          <div className="next-up">
            <span className="eyebrow" style={{ color: 'var(--cyan)' }}>Next up</span>
            <b>{p.next.title}</b>
            <span className="small fade">{p.next.detail}</span>
            {p.next.go !== 'start'
              ? <button className="btn sm" onClick={() => go(p.next!.go)}>Go →</button>
              : <button className="btn ghost sm" onClick={() => tick(p.next!.id, true)}>Mark done</button>}
          </div>
        )}
      </div>

      {STAGES.map((stage) => {
        const done = stage.steps.filter((st) => stepDone(snap, st).done).length;
        return (
          <div className="card stage" key={stage.key}>
            <div className="spread" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div>
                <h3>{stage.title}</h3>
                <div className="small fade">{stage.why}</div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <span className="pill">{stage.when}</span>
                <span className={`pill ${done === stage.steps.length ? 'pass' : ''}`}>{done}/{stage.steps.length}</span>
              </div>
            </div>
            <div className="steps">
              {stage.steps.map((st) => {
                const d = stepDone(snap, st);
                return (
                  <div className={`step ${d.done ? 'done' : ''}`} key={st.id}>
                    <label className="tick">
                      <input type="checkbox" checked={d.done} onChange={(e) => tick(st.id, e.target.checked)} />
                    </label>
                    <div style={{ flex: 1 }}>
                      <div className="step-title">
                        {st.title}
                        {st.optional && <span className="pill" style={{ marginLeft: 8 }}>optional</span>}
                        {st.auto && d.note && <span className="auto-note">{d.note}</span>}
                      </div>
                      <div className="small fade">{st.detail}</div>
                    </div>
                    {st.go !== 'start' && <button className="btn ghost sm" onClick={() => go(st.go)}>Open</button>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="card" style={{ marginTop: 14 }}>
        <h3>What the words mean</h3>
        <div className="glossary">
          {GLOSSARY.map((g) => (
            <div key={g.term}><b>{g.term}</b><span>{g.means}</span></div>
          ))}
        </div>
      </div>
    </>
  );
}
