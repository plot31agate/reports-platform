/* Pipeline.tsx — the lead pipeline: agreed (committed) work vs potential,
   weighted by stage. Committed retainers are the MRR floor and feed the cash
   forecast automatically; open opportunities can be toggled into the forecast's
   scenario line. Supporting tiles: MRR, recurring-vs-project split, weighted
   pipeline, and client concentration. All maths is server-side (planning.php). */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { PipelineData, Opp, Stage } from '../lib/api';
import { money, moneyShort } from '../lib/finance';
import { Working, Empty, OfflineNote, toast } from '../components/ui';

const STAGE_LABEL: Record<Stage, string> = {
  lead: 'Lead', qualified: 'Qualified', proposal: 'Proposal', verbal: 'Verbal', won: 'Won', lost: 'Lost',
};

export function Pipeline({ go }: { go: (v: string) => void }) {
  const [data, setData] = useState<PipelineData | null>(null);
  const [offline, setOffline] = useState(false);
  const load = () => api.pipeline().then((d) => d === null ? setOffline(true) : setData(d));
  useEffect(() => { load(); }, []);

  if (offline) return <OfflineNote />;
  if (!data) return <Working label="Loading the pipeline…" />;

  const s = data.summary;

  return (
    <>
      {/* Supporting tiles */}
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Tile n={money(s.committedMrr)} unit="/mo" label="Recurring revenue (MRR)" note={`${s.wonCount} agreed`} />
        <Tile n={money(s.committedProject)} label="Won projects (one-off)" note="agreed" />
        <Tile n={money(s.weightedMrr)} unit="/mo" label="Weighted pipeline" note={`${money(s.weightedProject)} one-off`} accent />
        <Tile n={s.topClientShare !== null ? `${s.topClientShare.toFixed(0)}%` : '—'} label="Client concentration"
          note={s.topClient ? `${s.topClient} of committed book` : 'no committed work yet'} />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="spread" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="eyebrow">Pipeline</div>
            <h3>Opportunities — agreed vs potential</h3>
          </div>
          <div className="row" style={{ gap: 10 }}>
            {data.opps.length === 0 && <button className="btn ghost sm" onClick={async () => { await api.pipelineSeed(); toast('Example rows added'); load(); }}>Add examples</button>}
            <AddOpp onAdd={load} />
          </div>
        </div>

        {data.opps.length === 0 ? (
          <div style={{ marginTop: 14 }}><Empty>No opportunities yet. Add one — committed (won) work becomes your cash-flow floor.</Empty></div>
        ) : (
          <div style={{ overflowX: 'auto', marginTop: 12 }}>
            <table className="t" style={{ minWidth: 860 }}>
              <thead>
                <tr>
                  <th>Client / opportunity</th><th>Type</th><th style={{ textAlign: 'right' }}>Value</th>
                  <th>Stage</th><th style={{ textAlign: 'right' }}>Win %</th><th style={{ textAlign: 'right' }}>Weighted</th>
                  <th>Start</th><th>Next action</th><th style={{ textAlign: 'center' }}>Forecast</th><th></th>
                </tr>
              </thead>
              <tbody>
                {data.opps.map((o) => <OppRow key={o.id} o={o} onChange={load} />)}
              </tbody>
            </table>
          </div>
        )}
        <p className="small fade" style={{ marginTop: 10 }}>
          Weighted value = value × win probability (auto from stage, override by typing a %). Won retainers feed
          the <button className="linky" onClick={() => go('cashflow')}>cash flow</button> as the floor; tick <b>Forecast</b> to add an open opportunity to the scenario line.
        </p>
      </div>
    </>
  );
}

function Tile({ n, unit, label, note, accent }: { n: string; unit?: string; label: string; note?: string; accent?: boolean }) {
  return (
    <div className="card stat">
      <div className="n" style={accent ? { color: 'var(--navy)' } : undefined}>
        {n}{unit && <span style={{ fontSize: 15, color: 'var(--muted)', fontWeight: 600 }}> {unit}</span>}
      </div>
      <div className="l">{label}</div>
      {note && <div className="foot"><span className="kpi-note">{note}</span></div>}
    </div>
  );
}

/* One editable opportunity row. Draft state commits on blur / change. */
function OppRow({ o, onChange }: { o: Opp; onChange: () => void }) {
  const [value, setValue] = useState(String(o.value));
  const [prob, setProb] = useState(o.probabilityAuto ? '' : String(o.probability));
  const [start, setStart] = useState(o.startDate);
  const [next, setNext] = useState(o.nextAction);

  async function patch(fields: Partial<Opp>) { await api.pipelineUpdate({ id: o.id, ...fields }); onChange(); }
  const committed = o.stage === 'won';
  const dead = o.stage === 'lost';

  return (
    <tr style={dead ? { opacity: 0.5 } : undefined}>
      <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{o.client}</td>
      <td>
        <select className="inp cell" value={o.type} onChange={(e) => patch({ type: e.target.value as Opp['type'] })}>
          <option value="retainer">Retainer</option><option value="project">Project</option>
        </select>
      </td>
      <td style={{ textAlign: 'right' }}>
        <input className="inp cell num" value={value} onChange={(e) => setValue(e.target.value)}
          onBlur={() => Number(value) !== o.value && patch({ value: Number(value) || 0 })} />
        <span className="fade small" style={{ marginLeft: 2 }}>{o.type === 'retainer' ? '/mo' : ''}</span>
      </td>
      <td>
        <select className={`inp cell stage-${o.stage}`} value={o.stage} onChange={(e) => patch({ stage: e.target.value as Stage })}>
          {(Object.keys(STAGE_LABEL) as Stage[]).map((st) => <option key={st} value={st}>{STAGE_LABEL[st]}</option>)}
        </select>
      </td>
      <td style={{ textAlign: 'right' }}>
        <input className="inp cell num sm" value={prob} placeholder={o.probabilityAuto ? String(o.probability) : ''}
          onChange={(e) => setProb(e.target.value)}
          onBlur={() => { const v = prob.trim(); patch({ probability: (v === '' ? null : Number(v)) as unknown as number }); }} />
      </td>
      <td style={{ textAlign: 'right' }} className="money small">{moneyShort(o.weighted)}{o.type === 'retainer' ? '/mo' : ''}</td>
      <td>
        <input className="inp cell" type="date" value={start} onChange={(e) => { setStart(e.target.value); }}
          onBlur={() => start !== o.startDate && patch({ startDate: start })} />
      </td>
      <td>
        <input className="inp cell wide" value={next} onChange={(e) => setNext(e.target.value)}
          onBlur={() => next !== o.nextAction && patch({ nextAction: next })} placeholder="—" />
      </td>
      <td style={{ textAlign: 'center' }}>
        {committed ? <span className="pill pass" title="Won work is always in the floor">floor</span>
          : dead ? <span className="fade small">—</span>
            : <input type="checkbox" checked={o.includeInForecast} onChange={(e) => patch({ includeInForecast: e.target.checked })} />}
      </td>
      <td style={{ textAlign: 'right' }}><button className="linky" onClick={async () => { await api.pipelineDelete(o.id); onChange(); }}>remove</button></td>
    </tr>
  );
}

function AddOpp({ onAdd }: { onAdd: () => void }) {
  const [open, setOpen] = useState(false);
  const [client, setClient] = useState('');
  const [type, setType] = useState<'retainer' | 'project'>('retainer');
  const [value, setValue] = useState('');
  const [stage, setStage] = useState<Stage>('lead');

  async function add() {
    if (!client.trim()) { toast('Name the client'); return; }
    await api.pipelineAdd({ client, type, value: Number(value) || 0, stage });
    setClient(''); setValue(''); setStage('lead'); setOpen(false); onAdd();
  }
  if (!open) return <button className="btn gold sm" onClick={() => setOpen(true)}>+ Add opportunity</button>;
  return (
    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      <input className="inp" style={{ width: 180 }} placeholder="Client / opportunity" value={client} onChange={(e) => setClient(e.target.value)} autoFocus />
      <select className="inp" style={{ width: 'auto' }} value={type} onChange={(e) => setType(e.target.value as 'retainer' | 'project')}>
        <option value="retainer">Retainer</option><option value="project">Project</option>
      </select>
      <input className="inp num" style={{ width: 100 }} placeholder="£" value={value} onChange={(e) => setValue(e.target.value)} />
      <select className="inp" style={{ width: 'auto' }} value={stage} onChange={(e) => setStage(e.target.value as Stage)}>
        {(Object.keys(STAGE_LABEL) as Stage[]).map((st) => <option key={st} value={st}>{STAGE_LABEL[st]}</option>)}
      </select>
      <button className="btn gold sm" onClick={add}>Add</button>
      <button className="btn ghost sm" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}
