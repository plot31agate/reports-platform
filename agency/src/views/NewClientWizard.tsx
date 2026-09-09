/* NewClientWizard — the one guided flow for standing up a client.

   Five steps, everything the reporting core wants in one place:
     1 Basics      — who they are and what we deliver (roster block)
     2 Brief       — one line about the client; Claude drafts the whole setup
     3 Positioning — strategy focus, competitors, executives, the two briefs
     4 Report      — which sections their report includes + data connections
     5 Review      — what will be created, then create it in one POST

   The Claude step is a pure draft: nothing saves until Create, and every field
   it fills stays editable. Online, the create writes the client row, config
   keys and connection settings into reporting.db in one call — the same keys
   the admin workspace reads — so the new client lands ready to sync, not just
   named. Offline, only the roster basics can be kept (the overlay). */
import { useState } from 'react';
import type { ClientKind } from '../lib/roster';
import type { SetupMeta } from '../lib/agency';
import type { Store, NewClient } from '../lib/store';
import { toast } from '../components/ui';
import { Field, LinesArea, SectionsPicker, ConnectionFields, FALLBACK_META, fromLines, toLines, domainOf } from '../components/setup';

const STEPS = ['Basics', 'Brief', 'Positioning', 'Report & data', 'Review'];

interface Draft {
  name: string; website: string; owner: string; kind: ClientKind;
  report: 'monthly' | 'quarterly' | 'none'; articles: number; reviewMonths: number; portalUrl: string;
  description: string;
  about: string; focus: string; competitors: string; executives: string;
  sentiment: string; reportFocus: string;
  sections: string[];
  conn: Record<string, Record<string, string>>;
}

export function NewClientWizard({ store, meta, assistReady, agencyKeys, onClose, onCreated, onOpenSheet }: {
  store: Store;
  meta?: SetupMeta;
  assistReady: boolean;
  agencyKeys: string[];
  onClose: () => void;
  onCreated: (slug: string | undefined, client: NewClient) => void;
  /** Close the wizard and open the new client's sheet. */
  onOpenSheet: (slug: string) => void;
}) {
  const m = meta ?? FALLBACK_META;
  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [drafted, setDrafted] = useState(false);
  const [done, setDone] = useState<{ slug?: string; name: string } | null>(null);

  const [d, setD] = useState<Draft>(() => ({
    name: '', website: '', owner: 'Steve', kind: 'reporting',
    report: 'monthly', articles: 0, reviewMonths: 6, portalUrl: '',
    description: '',
    about: '', focus: '', competitors: '', executives: '', sentiment: '', reportFocus: '',
    sections: m.section_defs.filter((s) => s.default).map((s) => s.key),
    conn: {},
  }));
  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }));
  const setConn = (provider: string, key: string, value: string) =>
    setD((prev) => ({ ...prev, conn: { ...prev.conn, [provider]: { ...(prev.conn[provider] ?? {}), [key]: value } } }));

  const canContinue = step === 0 ? d.name.trim().length > 0 : true;

  const goTo = (n: number) => {
    if (n > maxStep && !canContinue) return;
    // Entering Report & data: prefill the Ahrefs target from the website once.
    if (n >= 3 && d.website && !(d.conn.ahrefs?.target)) {
      const host = domainOf(d.website);
      if (host) setConn('ahrefs', 'target', host);
    }
    setStep(n);
    setMaxStep((v) => Math.max(v, n));
  };

  /* ---- Claude draft ---- */
  const runDraft = async () => {
    setDrafting(true);
    try {
      const draft = await store.draftSetup({
        name: d.name.trim(), website: d.website.trim(),
        description: d.description.trim(), kind: d.kind,
      });
      setD((prev) => ({
        ...prev,
        about: draft.about ?? prev.about,
        focus: draft.strategy_focus ?? prev.focus,
        competitors: draft.competitors?.length ? toLines(draft.competitors) : prev.competitors,
        executives: draft.executives?.length ? toLines(draft.executives) : prev.executives,
        sentiment: draft.sentiment_brief ?? prev.sentiment,
        reportFocus: draft.report_focus ?? prev.reportFocus,
        sections: draft.sections?.length ? draft.sections : prev.sections,
        conn: {
          ...prev.conn,
          ahrefs: {
            ...(prev.conn.ahrefs ?? {}),
            ...(draft.core_keywords?.length && !(prev.conn.ahrefs?.core_keywords)
              ? { core_keywords: toLines(draft.core_keywords) } : {}),
          },
          serper: {
            ...(prev.conn.serper ?? {}),
            ...(draft.mention_queries?.length && !(prev.conn.serper?.mention_queries)
              ? { mention_queries: toLines(draft.mention_queries) } : {}),
          },
        },
      }));
      setDrafted(true);
      toast('Setup drafted — review every field before creating');
      goTo(2);
    } catch (e) { toast((e as Error).message); }
    finally { setDrafting(false); }
  };

  /* ---- create ---- */
  const buildPayload = (): NewClient => {
    const connections: Record<string, Record<string, string>> = {};
    for (const [provider, fields] of Object.entries(d.conn)) {
      const filled = Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim()));
      if (Object.keys(filled).length) connections[provider] = filled;
    }
    return {
      name: d.name.trim(), kind: d.kind, owner: d.owner.trim() || 'Unassigned',
      website: d.website.trim() || undefined,
      cadence: { report: d.report, articlesPerWeek: Math.max(0, d.articles), reviewMonths: Math.max(1, d.reviewMonths) },
      portalUrl: d.kind === 'client-hq' && d.portalUrl.trim() ? d.portalUrl.trim() : undefined,
      focus: d.focus.trim() || undefined,
      settings: {
        about: d.about.trim(),
        sections: d.sections,
        competitors: fromLines(d.competitors),
        executives: fromLines(d.executives),
        sentiment_context: d.sentiment.trim(),
        report_focus: d.reportFocus.trim(),
      },
      connections,
    };
  };

  const create = async () => {
    setBusy(true);
    try {
      const payload = buildPayload();
      const slug = await store.createClient(payload);
      setDone({ slug, name: payload.name });
      onCreated(slug, payload);
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };

  /* ---- shared bits ---- */
  const missingKeys = m.connectors
    .filter((c) => Object.values(d.conn[c.provider] ?? {}).some((v) => v.trim()) && !agencyKeys.includes(c.provider))
    .map((c) => c.label);

  return (
    <div className="pc-overlay" onClick={done ? onClose : undefined}>
      <div className="pc-sheet" onClick={(e) => e.stopPropagation()} style={{ width: 'min(860px, 100%)' }}>
        <div className="pc-head">
          <div>
            <div className="eyebrow">New client</div>
            <div className="pc-title">{d.name.trim() || 'Add a client'}</div>
          </div>
          <button className="pc-x" onClick={onClose}>×</button>
        </div>

        {!done && (
          <div className="pc-steps" style={{ flexWrap: 'wrap' }}>
            {STEPS.map((s, i) => (
              <button
                key={s}
                className={`pc-step ${step === i ? 'on' : i < step ? 'done' : ''}`}
                disabled={i > maxStep && !(i === step + 1 && canContinue)}
                onClick={() => goTo(i)}
              >
                <span className="n">{i + 1}</span>{s}
              </button>
            ))}
          </div>
        )}

        <div className="pc-body">
          {done ? (
            <DoneScreen
              name={done.name} slug={done.slug} online={store.online} kind={d.kind} store={store}
              onClose={onClose}
              onOpenSheet={done.slug ? () => onOpenSheet(done.slug!) : undefined}
            />
          ) : drafting ? (
            <div className="working">
              <div className="bar" />
              <div>
                <div style={{ fontWeight: 600, color: 'var(--ink)' }}>Claude is drafting {d.name.trim()}&rsquo;s setup…</div>
                <div className="small" style={{ color: 'var(--muted)', marginTop: 6 }}>
                  Strategy focus, competitors, sentiment brief, report focus, keywords and sections — all editable before anything saves.
                </div>
              </div>
            </div>
          ) : (
            <>
              {step === 0 && <StepBasics d={d} set={set} />}
              {step === 1 && (
                <StepBrief
                  d={d} set={set}
                  assistReady={assistReady} online={store.online}
                  onDraft={runDraft} drafted={drafted}
                />
              )}
              {step === 2 && <StepPositioning d={d} set={set} />}
              {step === 3 && (
                <StepReport d={d} set={set} setConn={setConn} meta={m} agencyKeys={agencyKeys} online={store.online} />
              )}
              {step === 4 && <StepReview d={d} online={store.online} missingKeys={missingKeys} />}

              <div className="pc-actions">
                {step > 0 ? <button className="btn ghost" onClick={() => setStep(step - 1)}>Back</button> : <span />}
                {step < STEPS.length - 1 ? (
                  <button className="btn" disabled={!canContinue} onClick={() => goTo(step + 1)}>
                    {step === 1 && !drafted ? 'Skip — fill it in myself' : 'Continue'}
                  </button>
                ) : (
                  <button className="btn" disabled={busy || !d.name.trim()} onClick={create}>
                    {busy ? 'Creating…' : `Create ${d.name.trim() || 'client'}`}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================ steps ============================ */

function StepBasics({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p className="small" style={{ margin: 0, color: 'var(--muted)' }}>
        Who they are and what we deliver. Everything else can be drafted for you on the next step.
      </p>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Client name">
          <input className="inp" placeholder="e.g. Pawsitive Solutions" value={d.name} onChange={(e) => set({ name: e.target.value })} autoFocus />
        </Field>
        <Field label="Website">
          <input className="inp" placeholder="https://…" value={d.website} onChange={(e) => set({ website: e.target.value })} />
        </Field>
        <Field label="Account lead">
          <input className="inp" value={d.owner} onChange={(e) => set({ owner: e.target.value })} />
        </Field>
        <Field label="Type" hint="Reporting = monthly report client. Client HQ = full content + portal client (it still reports).">
          <div className="seg" style={{ width: 'fit-content' }}>
            <button className={d.kind === 'reporting' ? 'on' : ''} onClick={() => set({ kind: 'reporting' })}>Reporting</button>
            <button className={d.kind === 'client-hq' ? 'on' : ''} onClick={() => set({ kind: 'client-hq' })}>Client HQ</button>
          </div>
        </Field>
        <Field label="Report cadence">
          <select className="inp" value={d.report} onChange={(e) => set({ report: e.target.value as Draft['report'] })}>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="none">None</option>
          </select>
        </Field>
        <Field label="Articles / week">
          <input className="inp" type="number" min={0} value={d.articles} onChange={(e) => set({ articles: Number(e.target.value) })} />
        </Field>
        <Field label="Review plan every (months)">
          <input className="inp" type="number" min={1} value={d.reviewMonths} onChange={(e) => set({ reviewMonths: Number(e.target.value) })} />
        </Field>
        {d.kind === 'client-hq' && (
          <Field label="Client HQ portal URL (optional)" hint="Leave blank if the portal isn't built yet — track it from the client sheet later.">
            <input className="inp" placeholder="https://…/portal/" value={d.portalUrl} onChange={(e) => set({ portalUrl: e.target.value })} />
          </Field>
        )}
      </div>
    </div>
  );
}

function StepBrief({ d, set, assistReady, online, onDraft, drafted }: {
  d: Draft; set: (p: Partial<Draft>) => void;
  assistReady: boolean; online: boolean; onDraft: () => void; drafted: boolean;
}) {
  const ready = online && assistReady;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p className="small" style={{ margin: 0, color: 'var(--muted)' }}>
        Tell Claude what this client does, in a line or two. It drafts the whole setup — strategy focus,
        competitors, executives, the sentiment brief, the report focus, core keywords, mention queries and
        which report sections fit — and you review every word before anything is saved.
      </p>
      <Field label={`What does ${d.name.trim() || 'this client'} do?`}>
        <textarea
          className="inp" rows={3} autoFocus
          placeholder="e.g. Dog-behaviour training company in Manchester — sells 1:1 sessions and an online course to anxious-dog owners"
          value={d.description}
          onChange={(e) => set({ description: e.target.value })}
          style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
        />
      </Field>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button className="btn" disabled={!ready} onClick={onDraft}>
          {drafted ? 'Draft again with Claude' : 'Draft the setup with Claude'}
        </button>
        {!online && <span className="small" style={{ color: 'var(--warn)' }}>Needs the reporting core — it's offline right now.</span>}
        {online && !assistReady && <span className="small" style={{ color: 'var(--warn)' }}>ANTHROPIC_API_KEY isn't set on the server, so drafting is off.</span>}
        {drafted && <span className="pill pass">Draft ready — review it on the next steps</span>}
      </div>
    </div>
  );
}

function StepPositioning({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p className="small" style={{ margin: 0, color: 'var(--muted)' }}>
        How we think and write about this client. The two briefs steer the AI that scores their media
        coverage and writes their report commentary.
      </p>
      <Field label="About (one or two sentences)">
        <textarea className="inp" rows={2} value={d.about} onChange={(e) => set({ about: e.target.value })}
          placeholder="What the company does and who its customers are"
          style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
      </Field>
      <Field label="Strategic focus (one line)">
        <input className="inp" value={d.focus} onChange={(e) => set({ focus: e.target.value })}
          placeholder="The current plan in one line — drives the strategy-review reminders" />
      </Field>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <LinesArea label="Competitors" hint="Brand names, one per line — used for share of voice and the sentiment brief."
          placeholder={'Competitor A\nCompetitor B'} value={d.competitors} onChange={(v) => set({ competitors: v })} />
        <LinesArea label="Executives to track" hint="Named people scanned for in media coverage. Leave empty if none."
          placeholder={'Jane Smith\nJohn Doe'} value={d.executives} onChange={(v) => set({ executives: v })} />
      </div>
      <LinesArea label="Sentiment brief" rows={5}
        hint="Read by the AI that scores every media mention positive / negative / neutral from this client's commercial perspective."
        value={d.sentiment} onChange={(v) => set({ sentiment: v })} />
      <LinesArea label="Report focus" rows={4}
        hint="Read by the AI that writes the report's headline and commentary — what leads the story, what supports it, and the voice."
        value={d.reportFocus} onChange={(v) => set({ reportFocus: v })} />
    </div>
  );
}

function StepReport({ d, set, setConn, meta, agencyKeys, online }: {
  d: Draft; set: (p: Partial<Draft>) => void;
  setConn: (provider: string, key: string, value: string) => void;
  meta: SetupMeta; agencyKeys: string[]; online: boolean;
}) {
  const toggle = (key: string) =>
    set({ sections: d.sections.includes(key) ? d.sections.filter((k) => k !== key) : [...d.sections, key] });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <p className="small" style={{ margin: '0 0 10px', color: 'var(--muted)' }}>
        What their report contains and where the data comes from. Fill what you know — everything here is
        editable later from the client sheet, and syncs need the shared agency key per provider (added once,
        on the API keys page).
      </p>
      <div className="eyebrow" style={{ marginBottom: 8 }}>Report sections</div>
      <SectionsPicker defs={meta.section_defs} chosen={d.sections} onToggle={toggle} />
      {!online && (
        <div className="pc-note" style={{ marginTop: 14 }}>
          The reporting core is offline — sections and connections can't be saved from here right now, only the roster basics.
        </div>
      )}
      <div className="eyebrow" style={{ margin: '20px 0 0' }}>Data connections</div>
      {meta.connectors.map((c) => (
        <ConnectionFields
          key={c.provider} def={c}
          hasAgencyKey={agencyKeys.includes(c.provider)}
          values={d.conn[c.provider] ?? {}}
          onChange={(k, v) => setConn(c.provider, k, v)}
        />
      ))}
    </div>
  );
}

function StepReview({ d, online, missingKeys }: { d: Draft; online: boolean; missingKeys: string[] }) {
  const conns = Object.entries(d.conn)
    .map(([p, fields]) => [p, Object.entries(fields).filter(([, v]) => v.trim())] as const)
    .filter(([, fields]) => fields.length);
  const row = (label: string, value: string) => (
    <tr><td style={{ width: 170, color: 'var(--muted)', fontWeight: 500 }}>{label}</td><td>{value || '—'}</td></tr>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p className="small" style={{ margin: 0, color: 'var(--muted)' }}>
        One create writes all of this to the reporting core: the roster entry, the report setup, the briefs
        and the connection settings. Nothing is synced or sent to the client.
      </p>
      <div className="card" style={{ padding: '10px 14px' }}>
        <table className="t compact"><tbody>
          {row('Client', `${d.name.trim()} ${d.kind === 'client-hq' ? '· Client HQ' : '· Reporting'}`)}
          {row('Website', d.website.trim())}
          {row('Lead', d.owner.trim() || 'Unassigned')}
          {row('Cadence', [
            d.report !== 'none' ? `${d.report} report` : 'no report',
            d.articles > 0 ? `${d.articles}/wk articles` : null,
            `plan review every ${d.reviewMonths}mo`,
          ].filter(Boolean).join(' · '))}
          {row('Strategic focus', d.focus.trim())}
          {row('Competitors', fromLines(d.competitors).join(', '))}
          {row('Executives', fromLines(d.executives).join(', '))}
          {row('Sentiment brief', d.sentiment.trim() ? `${d.sentiment.trim().split(/\s+/).length} words` : '')}
          {row('Report focus', d.reportFocus.trim() ? `${d.reportFocus.trim().split(/\s+/).length} words` : '')}
          {row('Sections', `${d.sections.length} enabled`)}
          {row('Connections', conns.length
            ? conns.map(([p, fields]) => `${p} (${fields.length} field${fields.length === 1 ? '' : 's'})`).join(' · ')
            : 'none yet')}
        </tbody></table>
      </div>
      {!online && (
        <div className="pc-note">
          The reporting core is offline — only the roster basics will be kept in this browser.
          Re-create or edit the client once the core is back to save the full setup.
        </div>
      )}
      {online && missingKeys.length > 0 && (
        <div className="pc-note">
          Heads up: {missingKeys.join(' and ')} {missingKeys.length === 1 ? 'has' : 'have'} client settings here
          but no shared agency key yet — syncs stay off until the key is added on the API keys page.
        </div>
      )}
    </div>
  );
}

function DoneScreen({ name, slug, online, kind, store, onClose, onOpenSheet }: {
  name: string; slug?: string; online: boolean; kind: ClientKind; store: Store;
  onClose: () => void; onOpenSheet?: () => void;
}) {
  const [building, setBuilding] = useState(false);
  const isHq = kind === 'client-hq';

  const buildNow = async () => {
    if (!slug) return;
    if (!confirm(
      `Build ${name}'s Client HQ now?\n\n`
      + `Claude drafts the whole build, then a runner provisions the site + portal on their own domain `
      + `and deploys it live. You'll watch it build on the client page. Continue?`
    )) return;
    setBuilding(true);
    try { await store.buildHq(slug); toast('Build queued — opening the client page'); onOpenSheet?.(); }
    catch (e) { toast((e as Error).message); setBuilding(false); }
  };

  return (
    <div className="pc-done">
      <div className="pc-check">✓</div>
      <div style={{ fontWeight: 650, fontSize: 17, color: 'var(--ink)' }}>{name} is set up</div>
      <p className="small" style={{ color: 'var(--muted)', margin: '8px auto 18px', maxWidth: 460, lineHeight: 1.55 }}>
        {online
          ? 'The client, report setup, briefs and connection settings are saved to the reporting core.'
          : 'Saved to this browser only — the reporting core was offline.'}
        {' '}What's left is the part that needs you:
      </p>
      <ul className="wt-list" style={{ maxWidth: 460, margin: '0 auto', textAlign: 'left' }}>
        <li><span className="num">1</span><span>Add their logins to the credential vault on the client page so the team can always get in.</span></li>
        <li><span className="num">2</span><span>Test the data connections from the client page, then run the first sync in the workspace.</span></li>
        {isHq
          ? <li><span className="num">3</span><span>Build their Client HQ — the site + portal on their own domain — with one click below, and watch it deploy.</span></li>
          : <li><span className="num">3</span><span>Open the month workspace and build their first report when the data's in.</span></li>}
      </ul>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 22, flexWrap: 'wrap' }}>
        {isHq && online && slug && (
          <button className="btn" disabled={building} onClick={buildNow}>⚡ Build their HQ now</button>
        )}
        <button className={isHq && online && slug ? 'btn ghost' : 'btn'} onClick={onOpenSheet ?? onClose}>{onOpenSheet ? 'Open the client page' : 'Done'}</button>
        {online && slug && (
          <a className="btn ghost" href={`/admin/workspace?client=${slug}`} target="_blank" rel="noreferrer">Open workspace ↗</a>
        )}
      </div>
    </div>
  );
}
