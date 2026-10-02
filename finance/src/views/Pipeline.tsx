/* Pipeline.tsx — three blocks: ongoing retainers (agreed), single projects by
   start month (agreed), and leads / weighted pipeline (potential). Weighted by stage. Committed retainers are the MRR floor and feed the cash
   forecast automatically; open opportunities can be toggled into the forecast's
   scenario line. Supporting tiles: MRR, recurring-vs-project split, weighted
   pipeline, and client concentration. All maths is server-side (planning.php). */
import { Fragment, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { PipelineData, Opp, Stage } from '../lib/api';
import { money, moneyShort } from '../lib/finance';
import { Working, Empty, OfflineNote, toast } from '../components/ui';

const STAGE_LABEL: Record<Stage, string> = {
  lead: 'Lead', qualified: 'Qualified', proposal: 'Proposal', verbal: 'Verbal', won: 'Won', lost: 'Lost',
};

const STAGE_ORDER: Stage[] = ['verbal', 'proposal', 'qualified', 'lead'];

function monthKey(d: string) { return /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : ''; }
function monthLabel(k: string) {
  if (!k) return 'No start date yet';
  const [y, m] = k.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

export function Pipeline({ go }: { go: (v: string) => void }) {
  const [data, setData] = useState<PipelineData | null>(null);
  const [offline, setOffline] = useState(false);
  const [showLost, setShowLost] = useState(false);
  const load = () => api.pipeline().then((d) => d === null ? setOffline(true) : setData(d));
  useEffect(() => { load(); }, []);

  if (offline) return <OfflineNote />;
  if (!data) return <Working label="Loading the pipeline…" />;

  const s = data.summary;
  const byClient = (a: Opp, b: Opp) => a.client.localeCompare(b.client);

  // Three blocks: signed retainers, signed one-off projects, everything still open.
  const retainers = data.opps.filter((o) => o.stage === 'won' && o.type === 'retainer').sort(byClient);
  const projects = data.opps.filter((o) => o.stage === 'won' && o.type === 'project');
  const open = data.opps.filter((o) => o.stage !== 'won' && o.stage !== 'lost')
    .sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || b.weighted - a.weighted);
  const lost = data.opps.filter((o) => o.stage === 'lost').sort(byClient);

  const months = new Map<string, Opp[]>();
  projects.forEach((o) => { const k = monthKey(o.startDate); months.set(k, [...(months.get(k) ?? []), o]); });
  const monthKeys = [...months.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  const thisMonth = new Date().toISOString().slice(0, 7);

  const openMrr = open.filter((o) => o.type === 'retainer').reduce((t, o) => t + o.weighted, 0);
  const openOneOff = open.filter((o) => o.type === 'project').reduce((t, o) => t + o.weighted, 0);

  return (
    <>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Tile n={money(s.committedMrr)} unit="/mo" label="Recurring revenue (MRR)" note={`${retainers.length} retainers`} />
        <Tile n={money(s.committedProject)} label="Won projects (one-off)" note={`${projects.length} projects`} />
        <Tile n={money(s.weightedMrr)} unit="/mo" label="Weighted pipeline" note={`${money(s.weightedProject)} one-off`} accent />
        <Tile n={s.topClientShare !== null ? `${s.topClientShare.toFixed(0)}%` : '—'} label="Client concentration"
          note={s.topClient ? `${s.topClient} of committed book` : 'no committed work yet'} />
      </div>

      {/* 1 — Ongoing retainers */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="spread" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="eyebrow">1 · Agreed</div>
            <h3>Ongoing retainers <span className="fade small">— {money(s.committedMrr)}/mo · {retainers.length} clients</span></h3>
          </div>
          <AddOpp label="+ Add retainer" type="retainer" stage="won" onAdd={load} />
        </div>
        {retainers.length === 0 ? (
          <div style={{ marginTop: 14 }}><Empty>No signed retainers yet. Mark an opportunity <b>Won</b> and it lands here.</Empty></div>
        ) : (
          <div style={{ overflowX: 'auto', marginTop: 12 }}>
            <table className="t" style={{ minWidth: 640 }}>
              <thead><tr>
                <th>Client</th><th style={{ textAlign: 'right' }}>Per month</th><th>Started</th><th>Next action</th><th>Stage</th><th></th>
              </tr></thead>
              <tbody>{retainers.map((o) => <OppRow key={o.id} o={o} variant="won" onChange={load} />)}</tbody>
            </table>
          </div>
        )}
      </div>

      {/* 2 — Single projects, by month */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="spread" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="eyebrow">2 · Agreed</div>
            <h3>Single projects <span className="fade small">— {money(s.committedProject)} one-off · by start month</span></h3>
          </div>
          <AddOpp label="+ Add project" type="project" stage="won" onAdd={load} />
        </div>
        {projects.length === 0 ? (
          <div style={{ marginTop: 14 }}><Empty>No won projects yet.</Empty></div>
        ) : (
          <div style={{ overflowX: 'auto', marginTop: 12 }}>
            <table className="t" style={{ minWidth: 640 }}>
              <thead><tr>
                <th>Client / project</th><th style={{ textAlign: 'right' }}>Value</th><th>Start</th><th>Next action</th><th>Stage</th><th></th>
              </tr></thead>
              <tbody>
                {monthKeys.map((k) => {
                  const rows = months.get(k)!.sort(byClient);
                  const total = rows.reduce((t, o) => t + o.value, 0);
                  return (
                    <Fragment key={k || 'none'}>
                      <tr className="month-head">
                        <td colSpan={6} style={{ background: 'var(--line-soft)', fontWeight: 600, color: 'var(--ink)' }}>
                          {monthLabel(k)}{k === thisMonth && <span className="pill gold" style={{ marginLeft: 8 }}>this month</span>}
                          <span className="fade small" style={{ float: 'right' }}>{money(total)} · {rows.length} {rows.length === 1 ? 'project' : 'projects'}</span>
                        </td>
                      </tr>
                      {rows.map((o) => <OppRow key={o.id} o={o} variant="won" onChange={load} />)}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 3 — Leads and weighted pipeline */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="spread" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="eyebrow">3 · Potential</div>
            <h3>Leads &amp; pipeline <span className="fade small">— {money(openMrr)}/mo + {money(openOneOff)} one-off weighted · {open.length} open</span></h3>
          </div>
          <div className="row" style={{ gap: 10 }}>
            {data.opps.length === 0 && <button className="btn ghost sm" onClick={async () => { await api.pipelineSeed(); toast('Example rows added'); load(); }}>Add examples</button>}
            <AddOpp label="+ Add lead" type="project" stage="lead" showType onAdd={load} />
          </div>
        </div>
        {open.length === 0 ? (
          <div style={{ marginTop: 14 }}><Empty>No open leads. Add one to start weighting your pipeline.</Empty></div>
        ) : (
          <div style={{ overflowX: 'auto', marginTop: 12 }}>
            <table className="t" style={{ minWidth: 860 }}>
              <thead><tr>
                <th>Client / opportunity</th><th>Type</th><th style={{ textAlign: 'right' }}>Value</th>
                <th>Stage</th><th style={{ textAlign: 'right' }}>Win %</th><th style={{ textAlign: 'right' }}>Weighted</th>
                <th>Start</th><th>Next action</th><th style={{ textAlign: 'center' }}>Forecast</th><th></th>
              </tr></thead>
              <tbody>{open.map((o) => <OppRow key={o.id} o={o} variant="open" onChange={load} />)}</tbody>
            </table>
          </div>
        )}
        {lost.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <button className="linky" onClick={() => setShowLost(!showLost)}>{showLost ? 'Hide' : 'Show'} {lost.length} lost</button>
            {showLost && (
              <div style={{ overflowX: 'auto', marginTop: 6 }}>
                <table className="t" style={{ minWidth: 860 }}>
                  <tbody>{lost.map((o) => <OppRow key={o.id} o={o} variant="open" onChange={load} />)}</tbody>
                </table>
              </div>
            )}
          </div>
        )}
        <p className="small fade" style={{ marginTop: 10 }}>
          Weighted = value × win probability (auto from stage, override by typing a %). Set a lead to <b>Won</b> and it
          moves up into retainers or projects and becomes the <button className="linky" onClick={() => go('cashflow')}>cash flow</button> floor;
          tick <b>Forecast</b> to add an open lead to the scenario line. Retainers already reconciled against the bank
          live in the <button className="linky" onClick={() => go('moneyin')}>Retainer book</button> — don't list them twice.
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
function OppRow({ o, variant, onChange }: { o: Opp; variant: 'won' | 'open'; onChange: () => void }) {
  const [value, setValue] = useState(String(o.value));
  const [prob, setProb] = useState(o.probabilityAuto ? '' : String(o.probability));
  const [start, setStart] = useState(o.startDate);
  const [next, setNext] = useState(o.nextAction);

  async function patch(fields: Partial<Opp>) { await api.pipelineUpdate({ id: o.id, ...fields }); onChange(); }
  const dead = o.stage === 'lost';

  const valueCell = (
    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
      <input className="inp cell num" value={value} onChange={(e) => setValue(e.target.value)}
        onBlur={() => Number(value) !== o.value && patch({ value: Number(value) || 0 })} />
      <span className="fade small" style={{ marginLeft: 2 }}>{o.type === 'retainer' ? '/mo' : ''}</span>
    </td>
  );
  const startCell = (
    <td>
      <input className="inp cell" type="date" value={start} onChange={(e) => { setStart(e.target.value); }}
        onBlur={() => start !== o.startDate && patch({ startDate: start })} />
    </td>
  );
  const nextCell = (
    <td>
      <input className="inp cell wide" value={next} onChange={(e) => setNext(e.target.value)}
        onBlur={() => next !== o.nextAction && patch({ nextAction: next })} placeholder="—" />
    </td>
  );
  const stageCell = (
    <td>
      <select className={`inp cell stage-${o.stage}`} value={o.stage} onChange={(e) => patch({ stage: e.target.value as Stage })}>
        {(Object.keys(STAGE_LABEL) as Stage[]).map((st) => <option key={st} value={st}>{STAGE_LABEL[st]}</option>)}
      </select>
    </td>
  );
  const removeCell = (
    <td style={{ textAlign: 'right' }}><button className="linky" onClick={async () => { await api.pipelineDelete(o.id); onChange(); }}>remove</button></td>
  );

  if (variant === 'won') {
    return (
      <tr>
        <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{o.client}</td>
        {valueCell}{startCell}{nextCell}{stageCell}{removeCell}
      </tr>
    );
  }
  return (
    <tr style={dead ? { opacity: 0.5 } : undefined}>
      <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{o.client}</td>
      <td>
        <select className="inp cell" value={o.type} onChange={(e) => patch({ type: e.target.value as Opp['type'] })}>
          <option value="retainer">Retainer</option><option value="project">Project</option>
        </select>
      </td>
      {valueCell}{stageCell}
      <td style={{ textAlign: 'right' }}>
        <input className="inp cell num sm" value={prob} placeholder={o.probabilityAuto ? String(o.probability) : ''}
          onChange={(e) => setProb(e.target.value)}
          onBlur={() => { const v = prob.trim(); patch({ probability: (v === '' ? null : Number(v)) as unknown as number }); }} />
      </td>
      <td style={{ textAlign: 'right' }} className="money small">{moneyShort(o.weighted)}{o.type === 'retainer' ? '/mo' : ''}</td>
      {startCell}{nextCell}
      <td style={{ textAlign: 'center' }}>
        {dead ? <span className="fade small">—</span>
          : <input type="checkbox" checked={o.includeInForecast} onChange={(e) => patch({ includeInForecast: e.target.checked })} />}
      </td>
      {removeCell}
    </tr>
  );
}

function AddOpp({ label, type: defType, stage: defStage, showType, onAdd }: {
  label: string; type: 'retainer' | 'project'; stage: Stage; showType?: boolean; onAdd: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [client, setClient] = useState('');
  const [type, setType] = useState<'retainer' | 'project'>(defType);
  const [value, setValue] = useState('');

  async function add() {
    if (!client.trim()) { toast('Name the client'); return; }
    await api.pipelineAdd({ client, type, value: Number(value) || 0, stage: defStage });
    setClient(''); setValue(''); setOpen(false); onAdd();
  }
  if (!open) return <button className="btn gold sm" onClick={() => setOpen(true)}>{label}</button>;
  return (
    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      <input className="inp" style={{ width: 180 }} placeholder="Client / opportunity" value={client} onChange={(e) => setClient(e.target.value)} autoFocus />
      {showType && (
        <select className="inp" style={{ width: 'auto' }} value={type} onChange={(e) => setType(e.target.value as 'retainer' | 'project')}>
          <option value="retainer">Retainer</option><option value="project">Project</option>
        </select>
      )}
      <input className="inp num" style={{ width: 100 }} placeholder={type === 'retainer' ? '£ / month' : '£'} value={value} onChange={(e) => setValue(e.target.value)} />
      <button className="btn gold sm" onClick={add}>Add</button>
      <button className="btn ghost sm" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}
