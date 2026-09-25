/* Suggested journeys — a starting-point journey per lifecycle segment, with
   readiness and thresholds pulled live from the snapshot. */
import { SEGMENT_BY_ID } from '../lib/model';
import type { Snapshot } from '../lib/model';
import { fmtN, readiness, segmentSize } from '../lib/calc';
import { JOURNEYS, JOURNEY_BY_SEG, fill, journeyText } from '../lib/journeys';
import { CopyButton, ReadyPill } from '../components/ui';

export function Journeys({ snap, selected, select }: { snap: Snapshot; selected: string; select: (id: string) => void }) {
  const ordered = [...JOURNEYS].sort((a, b) =>
    (snap.segments.find((g) => g.id === a.segment)?.priority ?? 0) - (snap.segments.find((g) => g.id === b.segment)?.priority ?? 0));
  const cur = JOURNEY_BY_SEG[selected] ? selected : ordered[0].segment;
  const j = JOURNEY_BY_SEG[cur];
  const def = SEGMENT_BY_ID[cur];
  const r = readiness(snap, def);
  const sz = segmentSize(snap, cur);

  return (
    <div className="jgrid">
      <div className="card jlist">
        <div className="eyebrow" style={{ marginBottom: 8 }}>In priority order</div>
        {ordered.map((x) => {
          const rr = readiness(snap, SEGMENT_BY_ID[x.segment]);
          return (
            <button key={x.segment} className={`jitem ${x.segment === cur ? 'on' : ''}`} onClick={() => select(x.segment)}>
              <span className={`dot ${rr.ready ? 'up' : 'down'}`} />
              <span className="mono fade" style={{ width: 30 }}>{x.segment}</span>
              <span style={{ flex: 1 }}>{x.name}</span>
            </button>
          );
        })}
        <div className="kpi-note" style={{ marginTop: 10 }}>Green = ready to build. Red = waiting on data.</div>
      </div>

      <div>
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="spread" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <div className="eyebrow">Segment {def.id} · {def.name} · {def.product === 'both' ? 'matched to player’s product' : def.product}</div>
              <h2 style={{ fontSize: 19, marginTop: 4 }}>{j.name}</h2>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <ReadyPill ready={r.ready} />
              <CopyButton text={() => journeyText(snap, cur)} label="Copy journey" />
            </div>
          </div>
          {!r.ready && <div className="note-strip warn" style={{ marginTop: 10 }}>Can’t be built yet. Missing: {r.missing.map((m) => m.label).join('; ')}. These are on the Swifty request list.</div>}

          <div className="jfacts">
            <div><span>Goal</span>{j.goal}</div>
            <div><span>How we measure it</span>{j.measure}</div>
            <div><span>Who enters</span>{fill(snap, cur, j.trigger)}</div>
            <div><span>When they leave</span>{fill(snap, cur, j.exit)}</div>
            <div><span>Audience</span>{fmtN(sz.size)} in segment · {fmtN(sz.marketable)} marketable (est.)</div>
            <div><span>Always excluded</span>X1 self-excluded / GAMSTOP, X5 safer gambling hold. Offer steps also exclude X4 suspected abusers.</div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 14 }}>
          <h3 style={{ marginBottom: 10 }}>Steps</h3>
          <div className="timeline">
            {j.steps.map((st, i) => (
              <div className="tl-step" key={i}>
                <div className="tl-dot">{i + 1}</div>
                <div style={{ flex: 1 }}>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <b style={{ color: 'var(--ink)' }}>{st.when}</b>
                    <span className={`pill ch-${st.channel.replace(/\W/g, '').toLowerCase()}`}>{st.channel}</span>
                    {st.offer && <span className="pill warn">offer: excludes X4</span>}
                    <span className="small fade">{st.purpose}</span>
                  </div>
                  <div style={{ marginTop: 4 }}>{st.content}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 6 }}>Notes</h3>
          <ul className="jnotes">{j.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
          <div className="kpi-note">A starting point to adapt with the client: timings, wording and offers need their approval. SMS and push steps only go to players opted in to that channel for that product.</div>
        </div>
      </div>
    </div>
  );
}
