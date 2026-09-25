/* 3.7 Roadmap — generated from readiness and priority. Blocked lifecycle
   segments move to "after data fix" with the missing fields named. */
import type { Snapshot } from '../lib/model';
import { roadmap } from '../lib/calc';
import type { RoadItem } from '../lib/calc';
import { ReadyPill } from '../components/ui';

const STATUS: Record<string, string> = { not_started: 'Not started', building: 'Building', live: 'Live' };

function Item({ i }: { i: RoadItem }) {
  return (
    <div className="kancard">
      <div className="spread">
        <span style={{ color: 'var(--ink)', fontWeight: 600, fontSize: 13 }}><span className="mono fade" style={{ marginRight: 6 }}>{i.id}</span>{i.name}</span>
      </div>
      <div className="row" style={{ gap: 6, marginTop: 6 }}>
        <ReadyPill ready={i.ready} />
        <span className={`pill ${i.status === 'live' ? 'pass' : i.status === 'building' ? 'gold' : ''}`}>{STATUS[i.status]}</span>
      </div>
      {!i.ready && <div className="small" style={{ color: 'var(--fail)', marginTop: 6 }}>Needs: {i.missing.join('; ')}</div>}
    </div>
  );
}

export function Roadmap({ snap }: { snap: Snapshot }) {
  const { phases, blocked } = roadmap(snap);
  return (
    <>
      <div className="roadmap">
        {phases.map((p) => (
          <div className="kancol" key={p.key}>
            <div className="eyebrow">{p.when}</div>
            <div style={{ fontWeight: 650, color: 'var(--ink)', margin: '2px 0 10px' }}>{p.title}</div>
            {p.items.map((i) => <Item key={i.id} i={i} />)}
            {p.extras.map((e) => <div key={e} className="kancard small">{e}</div>)}
          </div>
        ))}
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h3>After data fix</h3>
        <div className="small fade" style={{ marginBottom: 10 }}>Lifecycle segments blocked by missing data. They move into their phase as soon as the audit marks every required field Present.</div>
        {blocked.length === 0 ? <div className="fade">Nothing blocked.</div> : (
          <div className="grid g3">{blocked.map((i) => <Item key={i.id} i={i} />)}</div>
        )}
      </div>
    </>
  );
}
