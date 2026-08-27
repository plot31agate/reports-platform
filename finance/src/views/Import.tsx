/* Import.tsx — bring Xero reports in. Drop or paste a CSV export; the parser
   sorts it into months and lines and tells you exactly what it found, so a bad
   import is visible rather than silent. Also holds the manual balance entry for
   when you just want to type today's bank figure. */
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { FinanceModel, ImportResult, ImportPLSummary, ImportBSSummary, XeroStatus } from '../lib/api';
import { money } from '../lib/finance';
import { toast, Empty, Working } from '../components/ui';

type Kind = 'auto' | 'pl' | 'balance';

export function Import({ go }: { go: (v: string) => void }) {
  const [kind, setKind] = useState<Kind>('auto');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [model, setModel] = useState<FinanceModel | null>(null);
  const [text, setText] = useState('');
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => api.model().then((m) => m && setModel(m));
  useEffect(() => { refresh(); }, []);

  async function submit(csv: string) {
    if (!csv.trim()) { toast('Nothing to import'); return; }
    setBusy(true); setResult(null);
    const r = await api.import(csv, kind);
    setBusy(false);
    if (!r) { toast('API unreachable'); return; }
    setResult(r);
    if (r.ok) { toast(r.kind === 'balance' ? 'Balance sheet imported' : 'Report imported'); refresh(); }
  }

  function onFiles(files: FileList | null) {
    if (!files || !files[0]) return;
    const reader = new FileReader();
    reader.onload = () => submit(String(reader.result || ''));
    reader.readAsText(files[0]);
  }

  return (
    <>
      <XeroCard onSynced={refresh} />

      <div className="grid g2" style={{ alignItems: 'start', marginBottom: 16 }}>
        <div className="card">
          <div className="eyebrow">Upload</div>
          <h3 style={{ marginBottom: 12 }}>…or upload a Xero export</h3>

          <label className="f">Report type</label>
          <div className="row" style={{ gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            {([['auto', 'Auto-detect'], ['pl', 'Profit & Loss'], ['balance', 'Balance Sheet']] as [Kind, string][]).map(([k, l]) => (
              <button key={k} className={`chip ${kind === k ? '' : ''}`} onClick={() => setKind(k)}
                style={kind === k ? { borderColor: 'var(--magenta)', color: 'var(--magenta)', fontWeight: 700 } : undefined}>{l}</button>
            ))}
          </div>

          <div className={`drop ${over ? 'over' : ''}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(e.dataTransfer.files); }}>
            <div className="big">Drop a CSV here</div>
            <div className="fade small" style={{ marginTop: 6 }}>or click to choose a file</div>
          </div>
          <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }}
            onChange={(e) => onFiles(e.target.files)} />

          <div className="hr" />
          <label className="f">…or paste the CSV</label>
          <textarea className="inp" rows={5} value={text} onChange={(e) => setText(e.target.value)}
            placeholder="Account,Jul 2025,Aug 2025&#10;Sales,12000,13500&#10;…" />
          <button className="btn gold" style={{ marginTop: 12 }} disabled={busy} onClick={() => submit(text)}>
            {busy ? 'Importing…' : 'Import pasted CSV'}
          </button>
        </div>

        <div className="card accent-cyan">
          <div className="eyebrow" style={{ color: 'var(--cyan)' }}>How to export from Xero</div>
          <h3 style={{ marginBottom: 12 }}>Two-minute setup</h3>
          <ol className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, color: 'var(--body)' }}>
            <li>In Xero: <b>Accounting → Reports → Profit and Loss</b>.</li>
            <li>Set the date range (a rolling 12 months works well) and, under
              <b> Compare periods</b>, choose the monthly columns.</li>
            <li>Click <b>Export → CSV</b>.</li>
            <li>Drop that file here. Repeat with <b>Balance Sheet</b> for cash, debtors and creditors.</li>
          </ol>
          <div className="pc-note" style={{ marginTop: 14 }}>
            Re-importing a month overwrites it cleanly — fix a figure in Xero, re-export, drop it in again.
          </div>
        </div>
      </div>

      {result && <ResultCard result={result} />}

      <ManualBalance model={model} onSaved={refresh} />

      <LoadedPeriods model={model} onChange={refresh} go={go} />
    </>
  );
}

function XeroCard({ onSynced }: { onSynced: () => void }) {
  const [status, setStatus] = useState<XeroStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.xeroStatus().then(setStatus);
  useEffect(() => { load(); }, []);

  async function sync() {
    setBusy(true);
    const r = await api.xeroSync();
    setBusy(false);
    if (!r) { toast('API unreachable'); return; }
    if (!r.ok) { toast(r.error || 'Sync failed'); load(); return; }
    toast(`Synced ${r.summary?.periods.length ?? 0} months from ${r.tenantName ?? 'Xero'}`);
    onSynced(); load();
  }
  async function disconnect() {
    if (!confirm('Disconnect Xero? Imported figures stay; live sync stops.')) return;
    await api.xeroDisconnect(); toast('Disconnected'); load();
  }

  // Not configured on the server: a quiet hint, not a dead end (CSV still works).
  if (status && !status.configured) {
    return (
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="spread" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div className="eyebrow">Live sync</div>
            <h3>Connect Xero for automatic updates</h3>
            <p className="fade small" style={{ margin: '4px 0 0', maxWidth: 520 }}>
              Add <code>api/xero-config.php</code> on the server (a Xero developer app’s client id, secret
              and redirect URI) to pull P&amp;L and the balance sheet with one click. Until then, upload CSVs below.
            </p>
          </div>
          <span className="pill">Not set up</span>
        </div>
      </div>
    );
  }

  const connected = status?.connected;
  return (
    <div className="card accent-cyan" style={{ marginBottom: 16 }}>
      <div className="spread" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div className="eyebrow" style={{ color: 'var(--cyan)' }}>Live sync</div>
          <h3>{connected ? `Connected to ${status?.tenantName ?? 'Xero'}` : 'Connect Xero'}</h3>
          <p className="fade small" style={{ margin: '4px 0 0', maxWidth: 520 }}>
            {connected
              ? (status?.lastSync ? `Last synced ${new Date(status.lastSync * 1000).toLocaleString('en-GB')}.` : 'Never synced yet.') + ' Pulls the last 12 months of P&L and the balance sheet.'
              : 'Sign in to Xero once, then pull your accounts with a click — no exports, no uploads.'}
          </p>
        </div>
        <div className="row" style={{ gap: 10 }}>
          {connected ? (
            <>
              <button className="btn gold" disabled={busy} onClick={sync}>{busy ? 'Syncing…' : 'Sync now'}</button>
              <button className="btn ghost sm" onClick={disconnect}>Disconnect</button>
            </>
          ) : (
            <a className="btn gold" href={api.xeroConnectUrl()}>Connect Xero →</a>
          )}
        </div>
      </div>
      {busy && <Working label="Pulling from Xero…" />}
    </div>
  );
}

function ResultCard({ result }: { result: ImportResult }) {
  if (!result.ok) {
    return (
      <div className="card accent" style={{ marginBottom: 16 }}>
        <div className="eyebrow" style={{ color: 'var(--magenta)' }}>Import failed</div>
        <p style={{ margin: '8px 0 0' }}>{result.error}</p>
      </div>
    );
  }
  if (result.kind === 'balance') {
    const s = result.summary as ImportBSSummary;
    return (
      <div className="card" style={{ marginBottom: 16, borderTop: '5px solid var(--pass)' }}>
        <div className="eyebrow" style={{ color: 'var(--pass)' }}>Balance sheet imported · {s.asAt}</div>
        <div className="grid g3" style={{ marginTop: 12 }}>
          <Mini label="Cash" v={s.cash} /><Mini label="Owed to us" v={s.debtors} /><Mini label="We owe" v={s.creditors} />
        </div>
      </div>
    );
  }
  const s = result.summary as ImportPLSummary;
  return (
    <div className="card" style={{ marginBottom: 16, borderTop: '5px solid var(--pass)' }}>
      <div className="eyebrow" style={{ color: 'var(--pass)' }}>Imported {s.periods.length} month{s.periods.length === 1 ? '' : 's'} · {s.accounts} account lines</div>
      <table className="t" style={{ marginTop: 10 }}>
        <thead><tr><th>Month</th><th style={{ textAlign: 'right' }}>Revenue</th><th style={{ textAlign: 'right' }}>Net profit</th></tr></thead>
        <tbody>
          {s.periods.map((p) => (
            <tr key={p.key}><td>{p.label}</td><td style={{ textAlign: 'right' }} className="money">{money(p.income)}</td>
              <td style={{ textAlign: 'right' }} className="money">{money(p.netProfit)}</td></tr>
          ))}
        </tbody>
      </table>
      {s.unplaced.length > 0 && (
        <div className="pc-note" style={{ marginTop: 12 }}>
          Couldn't place {s.unplaced.length} row{s.unplaced.length === 1 ? '' : 's'}: {s.unplaced.join(', ')}.
          These sat above any recognised section — check the export's section headers.
        </div>
      )}
    </div>
  );
}

function Mini({ label, v }: { label: string; v: number }) {
  return (
    <div>
      <div className="money" style={{ fontSize: 24 }}>{money(v)}</div>
      <div className="small fade" style={{ marginTop: 2 }}>{label}</div>
    </div>
  );
}

function ManualBalance({ model, onSaved }: { model: FinanceModel | null; onSaved: () => void }) {
  const b = model?.balance;
  const [cash, setCash] = useState('');
  const [debtors, setDebtors] = useState('');
  const [creditors, setCreditors] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (b) { setCash(String(b.cash)); setDebtors(String(b.debtors)); setCreditors(String(b.creditors)); }
  }, [b?.importedAt]);

  async function save() {
    const r = await api.setBalance({
      cash: Number(cash) || 0, debtors: Number(debtors) || 0, creditors: Number(creditors) || 0,
    });
    if (r?.ok) { toast('Balance saved'); onSaved(); setOpen(false); }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="spread">
        <div>
          <div className="eyebrow">No balance sheet handy?</div>
          <h3>Enter today's balance by hand</h3>
        </div>
        <button className="btn ghost sm" onClick={() => setOpen((o) => !o)}>{open ? 'Close' : 'Enter figures'}</button>
      </div>
      {open && (
        <div className="grid g3" style={{ marginTop: 16 }}>
          <div><label className="f">Cash in bank</label><input className="inp" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="24500" /></div>
          <div><label className="f">Owed to us (debtors)</label><input className="inp" value={debtors} onChange={(e) => setDebtors(e.target.value)} placeholder="8200" /></div>
          <div><label className="f">We owe (creditors)</label><input className="inp" value={creditors} onChange={(e) => setCreditors(e.target.value)} placeholder="4100" /></div>
          <div style={{ gridColumn: '1 / -1' }}><button className="btn gold" onClick={save}>Save balance</button></div>
        </div>
      )}
    </div>
  );
}

function LoadedPeriods({ model, onChange, go }: { model: FinanceModel | null; onChange: () => void; go: (v: string) => void }) {
  if (!model) return null;
  async function del(key: string) {
    const r = await api.deletePeriod(key);
    if (r?.ok) { toast('Removed'); onChange(); }
  }
  async function reset() {
    if (!confirm('Remove all imported data? This cannot be undone.')) return;
    const r = await api.reset();
    if (r?.ok) { toast('Cleared'); onChange(); }
  }
  return (
    <div className="card">
      <div className="spread">
        <div><div className="eyebrow">Loaded</div><h3>Imported months</h3></div>
        {model.meta.count > 0 && <button className="btn ghost sm" onClick={reset}>Start over</button>}
      </div>
      {model.meta.count === 0 ? <Empty>Nothing imported yet.</Empty> : (
        <table className="t" style={{ marginTop: 12 }}>
          <thead><tr><th>Month</th><th style={{ textAlign: 'right' }}>Revenue</th><th style={{ textAlign: 'right' }}>Net profit</th><th>Source</th><th></th></tr></thead>
          <tbody>
            {model.periods.slice().reverse().map((p) => (
              <tr key={p.key}>
                <td>{p.label}</td>
                <td style={{ textAlign: 'right' }} className="money">{money(p.totals.income)}</td>
                <td style={{ textAlign: 'right' }} className="money">{money(p.totals.netProfit)}</td>
                <td><span className="pill">{p.source || '—'}</span></td>
                <td style={{ textAlign: 'right' }}><button className="linky" onClick={() => del(p.key)}>remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {model.meta.count > 0 && <button className="btn gold sm" style={{ marginTop: 14 }} onClick={() => go('dashboard')}>See the dashboard →</button>}
    </div>
  );
}
