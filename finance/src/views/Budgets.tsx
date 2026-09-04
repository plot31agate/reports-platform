/* Budgets.tsx — spend layers, cash runway and what-ifs, now grounded in the
   bank statement. The old version could only sum Xero account names (mostly
   empty here), which made "set budget" a guess into a blank prompt. Now:
   - a GUIDED SETUP walks each spend area with its real last-3-months bank
     actuals and a suggested budget to accept or adjust;
   - layer actuals fall back to the bank group when Xero has nothing, so the
     variance bars mean something from day one;
   - runway and what-if use bank figures when no Xero P&L is imported. */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { FinanceModel, BudgetsData, Layer, ForecastResult } from '../lib/api';
import { money, moneyShort, runwayMonths } from '../lib/finance';
import { useBank } from '../lib/useBank';
import { spendGroups, monthlyFlows } from '../lib/bank';
import type { Enriched, GroupRow } from '../lib/bank';
import { CashLine, Working, NeedsKey, Empty, toast } from '../components/ui';

/* ---- Bank group ↔ budget layer wiring ---- */

/** Legacy seeded layer names → the bank group that holds their actuals. */
const LAYER_GROUP_MAP: Record<string, string> = {
  'marketing': 'Marketing',
  'salaries & wages': 'People',
  'software & tools': 'Software & admin',
  'office & premises': 'Premises & utilities',
  'professional fees': 'Professional & insurance',
};

/** Xero match tokens per group, so layers keep working if Xero fills in later. */
const GROUP_MATCH: Record<string, string> = {
  'People': 'wages, salaries, payroll, employer, pension',
  'Premises & utilities': 'rent, rates, office, utilities, electricity, gas',
  'Software & admin': 'software, subscriptions, saas, hosting',
  'Phones & internet': 'telephone, phone, internet, broadband, mobile',
  'Marketing': 'advertising, marketing, ads, promotion',
  'Travel & entertaining': 'travel, entertainment, subsistence, mileage',
  'Professional & insurance': 'accountancy, legal, professional, insurance',
  'Equipment': 'equipment, hardware, computer',
};

/** What each area is, and how to think about the number. Shown in the wizard. */
const GROUP_TIPS: Record<string, string> = {
  'People': 'Salaries, pension and employer costs. This should be your contracted payroll plus any planned hire — it shouldn’t wobble month to month, so budget the commitment, not the average.',
  'Premises & utilities': 'Rent, energy, water, business rates. Mostly fixed — budget the known contracts and watch for the annual energy catch-up bills.',
  'Software & admin': 'SaaS, hosting, domains and admin services. Budget BELOW the current actual — the Spending room’s subscription audit lists what to cut to get there.',
  'Phones & internet': 'BT, EE, O2 and friends. Fixed contracts — if the actual drifts above the budget, someone added a line or a device plan.',
  'Marketing': 'Your own marketing, not client spend. Agencies typically put 2–5% of revenue behind their own name; decide deliberately rather than defaulting to zero.',
  'Travel & entertaining': 'Day-to-day travel and client meals. Set the everyday norm here — conferences and trips belong in Spending → Planned events, on top.',
  'Professional & insurance': 'Accountants, legal, insurance. Lumpy — take the year’s total and divide by twelve so one invoice doesn’t read as a blowout.',
  'Equipment': 'Hardware and kit. Often zero for months then a laptop — budget a monthly sinking-fund amount instead of reacting to the spikes.',
};

/** Groups that make sense as budgets (debt service and HMRC are commitments,
    not discretionary spend — they live in Debt & loans and Cash flow). */
const BUDGETABLE = Object.keys(GROUP_MATCH);

const groupForLayer = (l: Layer): string | null =>
  LAYER_GROUP_MAP[l.name.toLowerCase()] ?? (BUDGETABLE.includes(l.name) ? l.name : null);

function monthLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return key;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

export function Budgets() {
  const bank = useBank();
  const [model, setModel] = useState<FinanceModel | null>(null);
  const [modelLoaded, setModelLoaded] = useState(false);

  useEffect(() => { api.model().then((m) => { setModel(m); setModelLoaded(true); }); }, []);

  if (bank.loading || !modelLoaded) return <Working label="Loading…" />;
  if (bank.offline && !model) return <div className="card"><p>The API is unreachable here.</p></div>;
  const txs = bank.txs ?? [];
  const hasXero = !!model && model.meta.count > 0;
  if (!hasXero && txs.length === 0) return (
    <div className="card" style={{ textAlign: 'center', padding: 40 }}>
      <div className="eyebrow">No data yet</div>
      <p className="fade" style={{ margin: '10px 0 0' }}>Import a bank statement (or a Xero P&amp;L) first — budgets and forecasts run off real spend.</p>
    </div>
  );

  return (
    <>
      <SpendLayers model={model} txs={txs} />
      <Runway model={model} txs={txs} />
      <WhatIf model={model} txs={txs} />
    </>
  );
}

/* ============================================================
   1. Spend layers — with bank actuals and the guided setup
   ============================================================ */
function SpendLayers({ model, txs }: { model: FinanceModel | null; txs: Enriched[] }) {
  const groups = spendGroups(txs);
  const flows = monthlyFlows(txs);
  const asOfMonth = txs.length ? txs[txs.length - 1].date.slice(0, 7) : '';
  const completeMonths = flows.map((f) => f.key).filter((k) => k !== asOfMonth);
  const defaultMonth = completeMonths[completeMonths.length - 1]
    ?? model?.meta.last ?? '';

  const [month, setMonth] = useState(defaultMonth);
  const [data, setData] = useState<BudgetsData | null>(null);
  const [wizard, setWizard] = useState(false);
  const load = () => api.budgets(month).then(setData);
  useEffect(() => { load(); }, [month]);

  // Month options: bank months (newest first), plus any Xero-only months.
  const monthOptions = [...new Set([...flows.map((f) => f.key), ...(model?.periods.map((p) => p.key) ?? [])])].sort().reverse();

  const bankActualFor = (l: Layer): number | null => {
    const g = groupForLayer(l);
    if (!g) return null;
    const row = groups.find((x) => x.group === g);
    return row ? (row.monthly[month] ?? 0) : 0;
  };

  async function addLayer() {
    const name = prompt('Spend layer name (e.g. Travel):');
    if (!name) return;
    await api.budgetAdd({ name, match: GROUP_MATCH[name] ?? '' });
    load();
  }
  async function setBudget(l: Layer) {
    const g = groupForLayer(l);
    const grow = g ? groups.find((x) => x.group === g) : null;
    const avg = grow ? suggestFor(grow, completeMonths) : 0;
    const v = prompt(
      `Monthly budget for ${l.name} (£)${avg > 0 ? ` — you actually spend ~£${avg.toLocaleString('en-GB')}/month` : ''}:`,
      String(l.monthly || avg || ''),
    );
    if (v === null) return;
    await api.budgetUpdate({ id: l.id, monthly: Number(v) || 0 });
    load();
  }
  async function setMatch(l: Layer) {
    const v = prompt(`Match ${l.name} against Xero account names containing (comma-separated):`, l.match);
    if (v === null) return;
    await api.budgetUpdate({ id: l.id, match: v });
    load();
  }
  async function del(l: Layer) { await api.budgetDelete(l.id); load(); }

  const layers = data?.layers ?? [];
  const noBudgetsYet = layers.length === 0 || layers.every((l) => l.monthly === 0);

  // Effective actual: Xero when it has figures for the month, else the bank group.
  const eff = layers.map((l) => {
    const bankA = bankActualFor(l);
    const useBankFig = l.actual === 0 && bankA !== null;
    return { l, actual: useBankFig ? bankA! : l.actual, source: useBankFig ? 'bank' : 'xero' };
  });
  const totalActual = eff.reduce((s, e) => s + e.actual, 0);
  const totalBudget = layers.reduce((s, l) => s + l.monthly, 0);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="spread" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div className="eyebrow">Spend layers</div>
          <h3>What we should be spending — vs what we are</h3>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <select className="inp" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)}>
            {monthOptions.map((k) => <option key={k} value={k}>{monthLabel(k)}{k === asOfMonth ? ' (partial)' : ''}</option>)}
          </select>
          <button className="btn sm" onClick={() => setWizard(true)}>Guided setup →</button>
          <button className="btn ghost sm" onClick={addLayer}>Add layer</button>
        </div>
      </div>

      {noBudgetsYet && !wizard && (
        <div className="note-strip" style={{ marginTop: 14 }}>
          <b>No budgets set yet.</b> Use <b>Guided setup</b> — it walks each spend area with what you
          actually spend from the bank statement and suggests a number to accept or adjust. Two minutes, end to end.
        </div>
      )}

      {wizard && (
        <Wizard txs={txs} layers={layers} completeMonths={completeMonths}
          onClose={() => setWizard(false)}
          onDone={() => { setWizard(false); load(); }} />
      )}

      {!data ? <Working label="…" /> : layers.length === 0 ? (
        !wizard && (
          <div style={{ marginTop: 14 }}>
            <Empty>No spend layers yet — Guided setup creates them from your real spending.</Empty>
          </div>
        )
      ) : !wizard && (
        <>
          <div className="row" style={{ gap: 18, marginTop: 12, marginBottom: 6, flexWrap: 'wrap' }}>
            <Tot label="Budgeted / mo" v={totalBudget} />
            <Tot label={`Actual · ${monthLabel(month)}`} v={totalActual} />
            <Tot label="Variance" v={totalActual - totalBudget} signed />
          </div>
          <div style={{ marginTop: 12 }}>
            {eff.map(({ l, actual, source }) => (
              <LayerRow key={l.id} l={l} actual={actual} source={source}
                onBudget={() => setBudget(l)} onMatch={() => setMatch(l)} onDelete={() => del(l)} />
            ))}
          </div>
          <p className="small fade" style={{ marginTop: 10 }}>
            Actuals come from the bank statement's spend groups; when a Xero P&amp;L covers the month,
            its cost accounts take over (tune with <b>match</b>). Debt service and HMRC aren't budget
            layers — they live in Debt &amp; loans and Cash flow.
          </p>
        </>
      )}
    </div>
  );
}

/** Suggested budget: 3-complete-month average, rounded to the nearest £25. */
function suggestFor(g: GroupRow, completeMonths: string[]): number {
  const recent = completeMonths.slice(-3);
  if (recent.length === 0) return 0;
  const avg = recent.reduce((s, k) => s + (g.monthly[k] ?? 0), 0) / recent.length;
  return Math.round(avg / 25) * 25;
}

/* ---- The guided setup ---- */
function Wizard({ txs, layers, completeMonths, onClose, onDone }: {
  txs: Enriched[]; layers: Layer[]; completeMonths: string[];
  onClose: () => void; onDone: () => void;
}) {
  const groups = spendGroups(txs).filter((g) => BUDGETABLE.includes(g.group));
  // Big stuff first; areas with zero history still appear (Marketing at £0 is a decision too).
  const steps = BUDGETABLE
    .map((name) => groups.find((g) => g.group === name) ?? { group: name, total: 0, monthly: {} })
    .sort((a, b) => b.total - a.total);

  const [i, setI] = useState(0);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const s of steps) {
      const existing = layers.find((l) => groupForLayer(l) === s.group && l.monthly > 0);
      v[s.group] = String(existing ? existing.monthly : suggestFor(s, completeMonths) || '');
    }
    return v;
  });
  const [saving, setSaving] = useState(false);

  const s = steps[i];
  const done = i >= steps.length;
  const last3 = completeMonths.slice(-3);
  const suggestion = s ? suggestFor(s, completeMonths) : 0;

  async function finish() {
    setSaving(true);
    let set = 0;
    for (const st of steps) {
      const monthly = Number(values[st.group]) || 0;
      const existing = layers.find((l) => groupForLayer(l) === st.group)
        ?? layers.find((l) => l.name.toLowerCase() === st.group.toLowerCase());
      if (existing) {
        if (existing.monthly !== monthly) await api.budgetUpdate({ id: existing.id, monthly });
      } else if (monthly > 0) {
        await api.budgetAdd({ name: st.group, match: GROUP_MATCH[st.group] ?? '', monthly });
      }
      if (monthly > 0) set++;
    }
    setSaving(false);
    toast(`Budgets set for ${set} spend area${set === 1 ? '' : 's'}`);
    onDone();
  }

  return (
    <div className="wiz">
      <div className="spread" style={{ marginBottom: 10 }}>
        <div className="eyebrow">Guided setup · {done ? 'review' : `${i + 1} of ${steps.length}`}</div>
        <button className="linky" onClick={onClose}>cancel</button>
      </div>
      <div className="wt-bar"><span style={{ width: `${(Math.min(i, steps.length) / steps.length) * 100}%` }} /></div>

      {!done && s && (
        <>
          <h3 style={{ margin: '4px 0 8px' }}>{s.group}</h3>
          <p className="small" style={{ margin: '0 0 12px', maxWidth: 640, lineHeight: 1.55 }}>{GROUP_TIPS[s.group]}</p>
          <div className="monthgrid" style={{ marginBottom: 14 }}>
            {last3.map((k) => (
              <div className="mg" key={k}>
                <div className="mg-m">{monthLabel(k).slice(0, 3)}</div>
                <div className={`mg-v ${s.monthly[k] ? '' : 'none'}`}>{s.monthly[k] ? moneyShort(s.monthly[k]) : '—'}</div>
              </div>
            ))}
            <div className="mg" style={{ background: 'var(--navy-100)' }}>
              <div className="mg-m">typ / mo</div>
              <div className="mg-v">{suggestion > 0 ? moneyShort(suggestion) : '—'}</div>
            </div>
          </div>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label className="f">Monthly budget (£)</label>
              <input className="inp num" style={{ width: 140 }} value={values[s.group]}
                onChange={(e) => setValues({ ...values, [s.group]: e.target.value })} />
            </div>
            {suggestion > 0 && Number(values[s.group]) !== suggestion && (
              <button className="btn ghost sm" onClick={() => setValues({ ...values, [s.group]: String(suggestion) })}>
                Use typical ({moneyShort(suggestion)})
              </button>
            )}
            <div className="row" style={{ gap: 8, marginLeft: 'auto' }}>
              {i > 0 && <button className="btn ghost sm" onClick={() => setI(i - 1)}>← Back</button>}
              <button className="btn sm" onClick={() => setI(i + 1)}>{i === steps.length - 1 ? 'Review →' : 'Next →'}</button>
            </div>
          </div>
        </>
      )}

      {done && (
        <>
          <h3 style={{ margin: '4px 0 10px' }}>Review &amp; save</h3>
          <table className="t" style={{ maxWidth: 480 }}>
            <tbody>
              {steps.map((st) => (
                <tr key={st.group}>
                  <td>{st.group}</td>
                  <td style={{ textAlign: 'right' }} className="money">
                    {Number(values[st.group]) > 0 ? money(Number(values[st.group])) : <span className="fade">skip</span>}
                  </td>
                </tr>
              ))}
              <tr>
                <td style={{ fontWeight: 600, color: 'var(--ink)' }}>Total / month</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }} className="money">
                  {money(steps.reduce((sum, st) => sum + (Number(values[st.group]) || 0), 0))}
                </td>
              </tr>
            </tbody>
          </table>
          <div className="row" style={{ gap: 8, marginTop: 14 }}>
            <button className="btn ghost sm" onClick={() => setI(steps.length - 1)}>← Back</button>
            <button className="btn sm" disabled={saving} onClick={finish}>{saving ? 'Saving…' : 'Save budgets'}</button>
          </div>
        </>
      )}
    </div>
  );
}

function Tot({ label, v, signed }: { label: string; v: number; signed?: boolean }) {
  const neg = v < 0;
  return (
    <div>
      <div className="money" style={{ fontSize: 22, color: signed ? (neg ? 'var(--pass)' : 'var(--fail)') : 'var(--ink)' }}>
        {signed && v > 0 ? '+' : ''}{money(v)}
      </div>
      <div className="small fade">{label}</div>
    </div>
  );
}

function LayerRow({ l, actual, source, onBudget, onMatch, onDelete }: {
  l: Layer; actual: number; source: string;
  onBudget: () => void; onMatch: () => void; onDelete: () => void;
}) {
  const variance = actual - l.monthly;
  const status = l.monthly > 0
    ? (actual > l.monthly * 1.1 ? 'over' : actual >= l.monthly * 0.9 ? 'near' : 'under')
    : (actual > 0 ? 'over' : 'under');
  const track = Math.max(l.monthly, actual, 1);
  const fill = Math.min(100, (actual / track) * 100);
  const mark = l.monthly > 0 ? Math.min(100, (l.monthly / track) * 100) : null;
  return (
    <div style={{ padding: '12px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <div className="spread" style={{ marginBottom: 8 }}>
        <div>
          <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{l.name}</span>
          {' '}<span className="tag-src fade">{source === 'bank' ? 'bank' : 'xero'}</span>
          {' '}<button className="linky" onClick={onMatch}>match</button>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <span className="money small">{money(actual)} <span className="fade">/ {l.monthly > 0 ? money(l.monthly) : 'no budget'}</span></span>
          <span className={`pill ${status === 'over' ? 'fail' : status === 'near' ? 'warn' : 'pass'}`}>
            {l.monthly > 0 ? (variance > 0 ? `+${moneyShort(variance)}` : moneyShort(variance)) : 'set budget'}
          </span>
        </div>
      </div>
      <div className="varbar">
        <span className={status} style={{ width: `${fill}%` }} />
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
   2. Cash runway — bank-first, Xero-compatible
   ============================================================ */
function Runway({ model, txs }: { model: FinanceModel | null; txs: Enriched[] }) {
  let cash: number | null = null;
  let avgNet = 0;
  let source = '';

  if (txs.length > 0) {
    const flows = monthlyFlows(txs);
    const asOfMonth = txs[txs.length - 1].date.slice(0, 7);
    const recent = flows.filter((f) => f.key !== asOfMonth).slice(-3);
    cash = txs[txs.length - 1].balance;
    avgNet = recent.length ? recent.reduce((s, f) => s + f.net, 0) / recent.length : 0;
    source = 'bank statement';
  } else if (model?.balance) {
    const recent = model.periods.slice(-3);
    avgNet = recent.reduce((s, p) => s + p.totals.netProfit, 0) / recent.length;
    cash = model.balance.cash;
    source = 'Xero';
  }

  if (cash === null) return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="eyebrow">Cash runway</div>
      <h3 style={{ marginBottom: 8 }}>Import a bank statement or balance sheet to project cash</h3>
    </div>
  );

  const runway = runwayMonths(cash, avgNet);
  const series = [{ label: 'now', value: cash }];
  for (let i = 1; i <= 12; i++) series.push({ label: `+${i}`, value: cash + avgNet * i });

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="eyebrow">Cash runway</div>
      <div className="spread" style={{ flexWrap: 'wrap', gap: 12 }}>
        <h3>Projected cash, next 12 months</h3>
        <div className="row" style={{ gap: 18 }}>
          <Tot label={`Recent net / mo · ${source}`} v={avgNet} />
          <div>
            <div className="money" style={{ fontSize: 22, color: avgNet >= 0 ? 'var(--pass)' : (runway && runway < 3 ? 'var(--fail)' : 'var(--ink)') }}>
              {avgNet >= 0 ? 'Growing' : runway !== null ? `${runway.toFixed(1)} mo` : '—'}
            </div>
            <div className="small fade">{avgNet >= 0 ? 'cash-positive' : 'runway'}</div>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 14 }}><CashLine series={series} /></div>
      <p className="small fade" style={{ margin: '10px 0 0' }}>
        Straight-line at the recent average — the 13-week Cash flow room is the sharper short-term view.
      </p>
    </div>
  );
}

/* ============================================================
   3. What-if — bank-first base figures
   ============================================================ */
function WhatIf({ model, txs }: { model: FinanceModel | null; txs: Enriched[] }) {
  // Base month: Xero's latest complete month if imported, else bank actuals.
  let baseIncome = 0, baseCost = 0, baseLabel = '';
  let cash: number | null = null;
  if (model?.latest) {
    baseIncome = model.latest.totals.income;
    baseCost = model.latest.totals.cogs + model.latest.totals.opex + model.latest.totals.otherExpense;
    baseLabel = model.latest.label;
    cash = model.balance?.cash ?? null;
  }
  if (txs.length > 0) {
    const flows = monthlyFlows(txs);
    const asOfMonth = txs[txs.length - 1].date.slice(0, 7);
    const recent = flows.filter((f) => f.key !== asOfMonth).slice(-3);
    if (baseIncome === 0 && recent.length) {
      baseIncome = recent.reduce((s, f) => s + f.in, 0) / recent.length;
      baseCost = recent.reduce((s, f) => s + f.out, 0) / recent.length;
      baseLabel = 'bank 3-month average';
    }
    cash = txs[txs.length - 1].balance;
  }
  const baseNet = baseIncome - baseCost;

  const [rev, setRev] = useState(0);
  const [cost, setCost] = useState(0);
  const [scenario, setScenario] = useState('');
  const [busy, setBusy] = useState(false);
  const [advice, setAdvice] = useState<ForecastResult | null>(null);
  const [needsKey, setNeedsKey] = useState(false);
  const [err, setErr] = useState('');

  const newIncome = baseIncome * (1 + rev / 100);
  const newCost = baseCost * (1 + cost / 100);
  const newNet = newIncome - newCost;
  const newRunway = cash !== null ? runwayMonths(cash, newNet) : null;
  const netDelta = newNet - baseNet;

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

  if (needsKey) return <div className="card" style={{ marginBottom: 16 }}><div className="eyebrow">What-if</div><h3 style={{ marginBottom: 12 }}>Scenario planning</h3><NeedsKey /></div>;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="eyebrow">What-if</div>
      <h3 style={{ marginBottom: 4 }}>Model a change, then ask Dave what it means</h3>
      <p className="fade small" style={{ marginTop: 0 }}>Based on {baseLabel}: revenue {money(baseIncome)}, costs {money(baseCost)}, net {money(baseNet)}.</p>

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
            <div><div className="money" style={{ fontSize: 20, color: newNet < 0 ? 'var(--fail)' : 'var(--ink)' }}>{money(newNet)}</div><div className="small fade">Net / mo</div></div>
            <div>
              <div className="money" style={{ fontSize: 20, color: netDelta >= 0 ? 'var(--pass)' : 'var(--fail)' }}>{netDelta >= 0 ? '+' : ''}{money(netDelta)}</div>
              <div className="small fade">vs now</div>
            </div>
          </div>
          {cash !== null && (
            <p className="small" style={{ marginTop: 12, color: 'var(--muted)' }}>
              Projected runway: <b style={{ color: newRunway !== null && newRunway < 3 ? 'var(--fail)' : 'var(--ink)' }}>
                {newNet >= 0 ? 'cash-positive' : newRunway !== null ? `${newRunway.toFixed(1)} months` : '—'}</b> on {money(cash)} cash.
            </p>
          )}
        </div>

        <div>
          <label className="f">Describe the scenario</label>
          <textarea className="inp" rows={4} value={scenario} onChange={(e) => setScenario(e.target.value)}
            placeholder="e.g. Replace Sandy's role at £2,100/month all-in and clear Funding Circle by March — what does that do to cash?" />
          <button className="btn" style={{ marginTop: 12 }} disabled={busy} onClick={assess}>
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
