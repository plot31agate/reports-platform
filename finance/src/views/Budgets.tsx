/* Budgets.tsx — three things that work off the same imported figures:
   1. Spend layers — "what we should spend on X" vs what Xero actually shows.
   2. Cash runway — a straight-line projection from the balance and recent net.
   3. What-if — sliders that re-model revenue/cost, plus a free-text scenario
      Claude assesses against the real numbers.
   Deterministic maths on-screen; judgement from Claude, on the same numbers. */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { FinanceModel, BudgetsData, Layer, ForecastResult } from '../lib/api';
import { money, moneyShort, runwayMonths } from '../lib/finance';
import { CashLine, Working, NeedsKey, Empty, toast } from '../components/ui';

export function Budgets() {
  const [model, setModel] = useState<FinanceModel | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => { api.model().then((m) => m === null ? setOffline(true) : setModel(m)); }, []);

  if (offline) return <div className="card accent"><p>The API is unreachable here.</p></div>;
  if (!model) return <Working label="Loading…" />;
  if (model.meta.count === 0) return (
    <div className="card accent" style={{ textAlign: 'center', padding: 40 }}>
      <div className="eyebrow">No data yet</div>
      <p className="fade" style={{ margin: '10px 0 0' }}>Import a Xero Profit &amp; Loss first — budgets and forecasts run off it.</p>
    </div>
  );

  return (
    <>
      <SpendLayers model={model} />
      <Runway model={model} />
      <WhatIf model={model} />
    </>
  );
}

/* ============================================================
   1. Spend layers
   ============================================================ */
function SpendLayers({ model }: { model: FinanceModel }) {
  const [month, setMonth] = useState(model.meta.last ?? '');
  const [data, setData] = useState<BudgetsData | null>(null);
  const load = () => api.budgets(month).then(setData);
  useEffect(() => { load(); }, [month]);

  async function seed() { await api.budgetSeed(); toast('Starter layers added'); load(); }
  async function addLayer() {
    const name = prompt('Spend layer name (e.g. Travel):');
    if (!name) return;
    await api.budgetAdd({ name });
    load();
  }
  async function setBudget(l: Layer) {
    const v = prompt(`Monthly budget for ${l.name} (£):`, String(l.monthly));
    if (v === null) return;
    await api.budgetUpdate({ id: l.id, monthly: Number(v) || 0 });
    load();
  }
  async function setMatch(l: Layer) {
    const v = prompt(`Match ${l.name} against account names containing (comma-separated):`, l.match);
    if (v === null) return;
    await api.budgetUpdate({ id: l.id, match: v });
    load();
  }
  async function del(l: Layer) { await api.budgetDelete(l.id); load(); }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="spread" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div className="eyebrow">Spend layers</div>
          <h3>What we should be spending — vs what we are</h3>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <select className="inp" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)}>
            {model.periods.slice().reverse().map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          <button className="btn ghost sm" onClick={addLayer}>Add layer</button>
        </div>
      </div>

      {!data ? <Working label="…" /> : data.layers.length === 0 ? (
        <div style={{ marginTop: 14 }}>
          <Empty>No spend layers yet.</Empty>
          <button className="btn gold sm" onClick={seed}>Add starter layers</button>
        </div>
      ) : (
        <>
          <div className="row" style={{ gap: 18, marginTop: 12, marginBottom: 6, flexWrap: 'wrap' }}>
            <Tot label="Budgeted / mo" v={data.totalBudget} />
            <Tot label={`Actual · ${data.monthLabel}`} v={data.totalActual} />
            <Tot label="Variance" v={data.totalActual - data.totalBudget} signed />
          </div>
          <div style={{ marginTop: 12 }}>
            {data.layers.map((l) => <LayerRow key={l.id} l={l} onBudget={() => setBudget(l)} onMatch={() => setMatch(l)} onDelete={() => del(l)} />)}
          </div>
          <p className="small fade" style={{ marginTop: 10 }}>
            Actuals are summed from cost accounts whose name contains a layer’s match words. Tap <b>match</b> to tune them to your Xero chart of accounts.
          </p>
        </>
      )}
    </div>
  );
}

function Tot({ label, v, signed }: { label: string; v: number; signed?: boolean }) {
  const neg = v < 0;
  return (
    <div>
      <div className={`money${signed && !neg ? '' : ''}`} style={{ fontSize: 22, color: signed ? (neg ? 'var(--pass)' : 'var(--fail)') : 'var(--navy)' }}>
        {signed && v > 0 ? '+' : ''}{money(v)}
      </div>
      <div className="small fade">{label}</div>
    </div>
  );
}

function LayerRow({ l, onBudget, onMatch, onDelete }: { l: Layer; onBudget: () => void; onMatch: () => void; onDelete: () => void }) {
  const track = Math.max(l.monthly, l.actual, 1);
  const fill = Math.min(100, (l.actual / track) * 100);
  const mark = l.monthly > 0 ? Math.min(100, (l.monthly / track) * 100) : null;
  const cls = l.status === 'over' ? 'over' : l.status === 'near' ? 'near' : 'under';
  return (
    <div style={{ padding: '12px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <div className="spread" style={{ marginBottom: 8 }}>
        <div>
          <span style={{ fontWeight: 700, color: 'var(--ink)' }}>{l.name}</span>
          {' '}<button className="linky" onClick={onMatch}>match</button>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <span className="money small">{money(l.actual)} <span className="fade">/ {l.monthly > 0 ? money(l.monthly) : 'no budget'}</span></span>
          <span className={`pill ${l.status === 'over' ? 'fail' : l.status === 'near' ? 'warn' : 'pass'}`}>
            {l.monthly > 0 ? (l.variance > 0 ? `+${moneyShort(l.variance)}` : moneyShort(l.variance)) : 'set budget'}
          </span>
        </div>
      </div>
      <div className="varbar">
        <span className={cls} style={{ width: `${fill}%` }} />
        {mark !== null && <span className="mark" style={{ left: `${mark}%` }} />}
      </div>
      <div className="row" style={{ gap: 12, marginTop: 6 }}>
        <button className="linky" onClick={onBudget}>set budget</button>
        <button className="linky" onClick={onDelete}>remove</button>
      </div>
    </div>
  );
}

/* ============================================================
   2. Cash runway
   ============================================================ */
function Runway({ model }: { model: FinanceModel }) {
  const recent = model.periods.slice(-3);
  const avgNet = recent.reduce((s, p) => s + p.totals.netProfit, 0) / recent.length;
  const cash = model.balance?.cash ?? null;

  if (cash === null) return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="eyebrow">Cash runway</div>
      <h3 style={{ marginBottom: 8 }}>Import a balance sheet to project cash</h3>
      <p className="fade small" style={{ margin: 0 }}>Add today’s bank figure in Import, and this projects it forward at your recent average net.</p>
    </div>
  );

  const runway = runwayMonths(cash, avgNet);
  const series = [{ label: 'now', value: cash }];
  for (let i = 1; i <= 12; i++) series.push({ label: `+${i}`, value: cash + avgNet * i });

  return (
    <div className="card accent-cyan" style={{ marginBottom: 16 }}>
      <div className="eyebrow">Cash runway</div>
      <div className="spread" style={{ flexWrap: 'wrap', gap: 12 }}>
        <h3>Projected cash, next 12 months</h3>
        <div className="row" style={{ gap: 18 }}>
          <Tot label="Recent net / mo" v={avgNet} signed={false} />
          <div>
            <div className="money" style={{ fontSize: 22, color: avgNet >= 0 ? 'var(--pass)' : (runway && runway < 3 ? 'var(--fail)' : 'var(--navy)') }}>
              {avgNet >= 0 ? 'Growing' : runway !== null ? `${runway.toFixed(1)} mo` : '—'}
            </div>
            <div className="small fade">{avgNet >= 0 ? 'cash-positive' : 'runway'}</div>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 14 }}><CashLine series={series} /></div>
    </div>
  );
}

/* ============================================================
   3. What-if
   ============================================================ */
function WhatIf({ model }: { model: FinanceModel }) {
  const base = model.latest!.totals;
  const baseCost = base.cogs + base.opex + base.otherExpense;
  const cash = model.balance?.cash ?? null;

  const [rev, setRev] = useState(0);   // % change to revenue
  const [cost, setCost] = useState(0); // % change to costs
  const [scenario, setScenario] = useState('');
  const [busy, setBusy] = useState(false);
  const [advice, setAdvice] = useState<ForecastResult | null>(null);
  const [needsKey, setNeedsKey] = useState(false);
  const [err, setErr] = useState('');

  const newIncome = base.income * (1 + rev / 100);
  const newCost = baseCost * (1 + cost / 100);
  const newNet = newIncome - newCost;
  const newRunway = cash !== null ? runwayMonths(cash, newNet) : null;
  const netDelta = newNet - base.netProfit;

  async function assess() {
    if (!scenario.trim()) { toast('Describe the scenario first'); return; }
    setBusy(true); setAdvice(null); setErr('');
    const r = await api.forecast(scenario, {
      revenueChangePct: rev, costChangePct: cost,
      modelledMonthlyNet: Math.round(newNet), currentCash: cash ?? 'unknown',
      projectedRunwayMonths: newRunway !== null ? Number(newRunway.toFixed(1)) : 'n/a',
    });
    setBusy(false);
    if (!r) setErr('The API is unreachable.');
    else if (r.needsKey) setNeedsKey(true);
    else if (!r.ok) setErr(r.error || 'Something went wrong.');
    else setAdvice(r.result!);
  }

  if (needsKey) return <div style={{ marginTop: 0 }}><div className="card" style={{ marginBottom: 16 }}><div className="eyebrow">What-if</div><h3 style={{ marginBottom: 12 }}>Scenario planning</h3><NeedsKey /></div></div>;

  return (
    <div className="card accent" style={{ marginBottom: 16 }}>
      <div className="eyebrow">What-if</div>
      <h3 style={{ marginBottom: 4 }}>Model a change, then ask Claude what it means</h3>
      <p className="fade small" style={{ marginTop: 0 }}>Based on {model.latest!.label}: revenue {money(base.income)}, costs {money(baseCost)}, net {money(base.netProfit)}.</p>

      <div className="grid g2" style={{ alignItems: 'start', marginTop: 12 }}>
        <div>
          <div className="slider-row">
            <label className="f" style={{ margin: 0 }}>Revenue</label>
            <input className="rng" type="range" min={-50} max={100} value={rev} onChange={(e) => setRev(Number(e.target.value))} />
            <span className="val">{rev > 0 ? '+' : ''}{rev}%</span>
          </div>
          <div className="slider-row">
            <label className="f" style={{ margin: 0 }}>Costs</label>
            <input className="rng" type="range" min={-50} max={100} value={cost} onChange={(e) => setCost(Number(e.target.value))} />
            <span className="val">{cost > 0 ? '+' : ''}{cost}%</span>
          </div>

          <div className="grid g3" style={{ marginTop: 14 }}>
            <div><div className="money" style={{ fontSize: 20 }}>{money(newIncome)}</div><div className="small fade">Revenue / mo</div></div>
            <div><div className="money" style={{ fontSize: 20, color: newNet < 0 ? 'var(--fail)' : 'var(--navy)' }}>{money(newNet)}</div><div className="small fade">Net / mo</div></div>
            <div>
              <div className="money" style={{ fontSize: 20, color: netDelta >= 0 ? 'var(--pass)' : 'var(--fail)' }}>{netDelta >= 0 ? '+' : ''}{money(netDelta)}</div>
              <div className="small fade">vs now</div>
            </div>
          </div>
          {cash !== null && (
            <p className="small" style={{ marginTop: 12, color: 'var(--muted)' }}>
              Projected runway: <b style={{ color: newRunway !== null && newRunway < 3 ? 'var(--fail)' : 'var(--navy)' }}>
                {newNet >= 0 ? 'cash-positive' : newRunway !== null ? `${newRunway.toFixed(1)} months` : '—'}</b> on {money(cash)} cash.
            </p>
          )}
        </div>

        <div>
          <label className="f">Describe the scenario</label>
          <textarea className="inp" rows={4} value={scenario} onChange={(e) => setScenario(e.target.value)}
            placeholder="e.g. Hire a second developer at £4k/month and increase marketing spend by 50% to win two new retainers." />
          <button className="btn gold" style={{ marginTop: 12 }} disabled={busy} onClick={assess}>
            {busy ? 'Assessing…' : 'Assess this scenario'}
          </button>
          {err && <p className="small" style={{ color: 'var(--fail)', marginTop: 10 }}>{err}</p>}
        </div>
      </div>

      {busy && <Working label="Thinking it through…" />}
      {advice && <Advice a={advice} />}
    </div>
  );
}

function Advice({ a }: { a: ForecastResult }) {
  return (
    <div style={{ marginTop: 18, borderTop: '1px solid var(--line-soft)', paddingTop: 16 }}>
      <p style={{ marginTop: 0, lineHeight: 1.55, fontWeight: 500, color: 'var(--ink)' }}>{a.summary}</p>
      {a.impacts.length > 0 && (
        <div className="grid g3" style={{ gap: 10, marginBottom: 14 }}>
          {a.impacts.map((f, i) => (
            <div key={i} style={{ background: 'var(--navy-100)', borderRadius: 10, padding: '10px 12px' }}>
              <div className="money" style={{ fontSize: 18 }}>{f.value}</div>
              <div className="small fade">{f.label}</div>
            </div>
          ))}
        </div>
      )}
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <Col title="Watch" tone="var(--warn)" items={a.risks} />
        <Col title="Do" tone="var(--pass)" items={a.actions} />
      </div>
    </div>
  );
}

function Col({ title, tone, items }: { title: string; tone: string; items: string[] }) {
  if (!items?.length) return null;
  return (
    <div>
      <div className="eyebrow" style={{ color: tone }}>{title}</div>
      <ul style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.6, color: 'var(--body)' }}>
        {items.map((x, i) => <li key={i}>{x}</li>)}
      </ul>
    </div>
  );
}
