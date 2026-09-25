/* 3.4 Segment priority table — size, marketable size, readiness from the
   audit, editable thresholds, status, and a Customer.io build spec per row. */
import { Fragment, useState } from 'react';
import { AUDIT_BY_ID, SEGMENTS } from '../lib/model';
import type { SegStatus, Snapshot } from '../lib/model';
import { buildSpec, fmtN, readiness, segmentSize } from '../lib/calc';
import { CopyButton, NumInput, ReadyPill, Section } from '../components/ui';

export function Segments({ snap, update }: { snap: Snapshot; update: (fn: (s: Snapshot) => Snapshot) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const setSeg = (id: string, fn: (g: Snapshot['segments'][number]) => void) => update((s) => { const g = s.segments.find((x) => x.id === id)!; fn(g); return s; });
  const move = (id: string, dir: -1 | 1) => update((s) => {
    const kind = SEGMENTS.find((d) => d.id === id)!.kind;
    const list = s.segments.filter((g) => SEGMENTS.find((d) => d.id === g.id)!.kind === kind).sort((a, b) => a.priority - b.priority);
    const i = list.findIndex((g) => g.id === id), j = i + dir;
    if (j < 0 || j >= list.length) return s;
    const p = list[i].priority; list[i].priority = list[j].priority; list[j].priority = p;
    return s;
  });

  const table = (kind: 'exclusion' | 'lifecycle') => {
    const rows = SEGMENTS.filter((d) => d.kind === kind)
      .map((d) => ({ def: d, st: snap.segments.find((g) => g.id === d.id)! }))
      .sort((a, b) => a.st.priority - b.st.priority);
    return (
      <div className="tscroll">
        <table className="t segt">
          <thead>
            <tr>
              <th style={{ width: 54 }}>#</th><th>Segment</th><th style={{ textAlign: 'right' }}>Size</th>
              {kind === 'lifecycle' && <th style={{ textAlign: 'right' }}>Marketable</th>}
              <th>Readiness</th>{kind === 'lifecycle' && <th>Quick win?</th>}<th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ def, st }, idx) => {
              const r = readiness(snap, def);
              const sz = segmentSize(snap, def.id);
              const isOpen = open === def.id;
              return (
                <Fragment key={def.id}>
                  <tr className={isOpen ? 'openrow' : ''}>
                    <td>
                      <div className="row" style={{ gap: 2 }}>
                        <span className="mono small">{idx + 1}</span>
                        <button className="mv" title="Move up" onClick={() => move(def.id, -1)}>▲</button>
                        <button className="mv" title="Move down" onClick={() => move(def.id, 1)}>▼</button>
                      </div>
                    </td>
                    <td>
                      <div style={{ color: 'var(--ink)', fontWeight: 600 }}><span className="mono fade" style={{ marginRight: 6 }}>{def.id}</span>{def.name}</div>
                      <div className="small fade">{def.rule}{def.kind === 'lifecycle' ? ` · ${def.workflow}` : ''}</div>
                      {def.product !== 'both' && <span className="pill" style={{ marginTop: 4 }}>{def.product}</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="money">{fmtN(sz.size)}</div>
                      <div className="kpi-note">{sz.source === 'entered' ? 'entered' : sz.source === 'calculated' ? 'calculated' : ''}</div>
                    </td>
                    {kind === 'lifecycle' && <td style={{ textAlign: 'right' }}>{fmtN(sz.marketable)}</td>}
                    <td>
                      <ReadyPill ready={r.ready} />
                      {!r.ready && <div className="small" style={{ color: 'var(--fail)', marginTop: 4, maxWidth: 240 }}>Needs: {r.missing.map((m) => m.label).join('; ')}</div>}
                    </td>
                    {kind === 'lifecycle' && <td className="small">{def.quickWin}</td>}
                    <td>
                      <select className={`inp status-${st.status}`} value={st.status} onChange={(e) => setSeg(def.id, (g) => { g.status = e.target.value as SegStatus; })} style={{ minWidth: 118 }}>
                        <option value="not_started">Not started</option>
                        <option value="building">Building</option>
                        <option value="live">Live</option>
                      </select>
                    </td>
                    <td><button className="btn ghost sm" onClick={() => setOpen(isOpen ? null : def.id)}>{isOpen ? 'Close' : 'Details & spec'}</button></td>
                  </tr>
                  {isOpen && (
                    <tr className="expand">
                      <td colSpan={kind === 'lifecycle' ? 8 : 6}>
                        <div className="grid g2" style={{ gap: 18 }}>
                          <div>
                            <div className="formgrid">
                              <label className="f">Size (override)</label>
                              <NumInput value={st.size} placeholder={sz.source === 'calculated' ? `calc: ${fmtN(sz.size)}` : '—'} onChange={(v) => setSeg(def.id, (g) => { g.size = v; })} />
                              {def.thresholds.map((t) => (
                                <Fragment key={t.key}>
                                  <label className="f">{t.label}</label>
                                  <NumInput value={st.thresholds[t.key] ?? null} prefix={t.unit === '£' ? '£' : undefined} suffix={t.unit === 'days' ? 'days' : undefined} onChange={(v) => setSeg(def.id, (g) => { g.thresholds[t.key] = v; })} />
                                </Fragment>
                              ))}
                            </div>
                            {sz.basis && <div className="kpi-note" style={{ marginTop: 8 }}>Calculated size: {sz.basis}. Enter a size from Customer.io to override.</div>}
                            {def.kind === 'lifecycle' && <div className="kpi-note">Marketable = size × not self-excluded × best-channel consent share for {def.product === 'both' ? 'the matched product' : def.product}{def.offer ? ' × not abuser (offer send)' : ''}.</div>}
                            <div className="small" style={{ marginTop: 10 }}><b>Required data:</b> {def.requiredFields.map((f) => {
                              const ok = snap.audit[f]?.status === 'present';
                              return <span key={f} className={`pill ${ok ? 'pass' : 'fail'}`} style={{ margin: '2px 4px 2px 0' }}>{AUDIT_BY_ID[f]?.label ?? f}</span>;
                            })}</div>
                          </div>
                          <div>
                            <div className="spread" style={{ marginBottom: 6 }}>
                              <span className="eyebrow">Customer.io build spec</span>
                              <CopyButton text={() => buildSpec(snap, def.id)} label="Copy spec" />
                            </div>
                            <pre className="spec">{buildSpec(snap, def.id)}</pre>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <>
      <Section title="Exclusion segments" sub="Build first. Used as filters on everything.">{table('exclusion')}</Section>
      <Section title="Lifecycle segments" sub="Priority order: use ▲▼ to re-rank. Readiness updates as soon as the audit changes.">{table('lifecycle')}</Section>
    </>
  );
}
