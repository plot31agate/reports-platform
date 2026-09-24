/* Time — internal time tracking across every client. A room in Agency HQ:
   Track (timer + quick add + my week), Timesheet (the week at a glance, team
   grid + sign-off locks), Reports (filters, roll-ups, CSV + print exports),
   and — admin only — Team, Clients and Settings.

   The admin account sees everything and logs time "as" any team member.
   Team members sign in with their own join link and get this room only, with
   just their own time; managers see and edit everyone's time but can't
   change team, rates or settings. All of it lives in reporting.db. */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  timeApi, INTERNAL, parseDuration, hm, dec, liveClock, liveMinutes, money, entryValue,
  today, mondayOf, addDays, weekDays, dayLabel, rangeFor, RANGE_LABEL, spanWeeks, rollUp,
  toCsv, download, MEMBER_COLORS, ACTOR_KEY, TIME_CHANGED, notifyTimeChanged,
} from '../lib/time';
import type { Boot, Entry, Member, TimeClient, Category, RangeKey, EntryInput, Roll } from '../lib/time';
import { toast, Empty, Stat } from '../components/ui';
import { requestPopout } from '../components/FloatingTimer';

type Tab = 'track' | 'sheet' | 'reports' | 'team' | 'clients' | 'settings';
const TABS: { id: Tab; label: string; admin?: boolean }[] = [
  { id: 'track', label: 'Track' },
  { id: 'sheet', label: 'Timesheet' },
  { id: 'reports', label: 'Reports & export' },
  { id: 'team', label: 'Team', admin: true },
  { id: 'clients', label: 'Clients & budgets', admin: true },
  { id: 'settings', label: 'Settings', admin: true },
];

const readLs = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeLs = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

/* ---------------------------------------------------------------- shared */

interface Ctx {
  boot: Boot;
  cur: string;
  admin: boolean;
  seesAll: boolean;
  memberById: Map<number, Member>;
  clientName: (slug: string | null) => string;
  catName: (id: number | null) => string;
  isLocked: (day: string) => boolean;
  reload: () => Promise<void>;
  bump: () => void;
  version: number;
}

function useEntries(start: string, end: string, version: number) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  useEffect(() => {
    let live = true;
    timeApi.entries(start, end).then((e) => { if (live) setEntries(e); }).catch((e) => toast(e.message));
    return () => { live = false; };
  }, [start, end, version]);
  return entries;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

async function attempt(fn: () => Promise<unknown>, ok?: string): Promise<boolean> {
  try { await fn(); if (ok) toast(ok); return true; }
  catch (e) { toast((e as Error).message || 'Something went wrong'); return false; }
}

function Dot({ color }: { color?: string | null }) {
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 99, background: color || 'var(--faint)', marginRight: 7, flex: '0 0 auto' }} />;
}

function Bar({ pct, tone }: { pct: number; tone?: 'warn' | 'fail' | 'pass' }) {
  const color = tone === 'fail' ? 'var(--fail)' : tone === 'warn' ? 'var(--warn)' : tone === 'pass' ? 'var(--pass)' : 'var(--chart-in)';
  return (
    <div style={{ height: 6, background: 'var(--line-soft)', borderRadius: 99, overflow: 'hidden', minWidth: 60 }}>
      <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: '100%', background: color, borderRadius: 99 }} />
    </div>
  );
}

function ClientSelect({ ctx, value, onChange, all }: { ctx: Ctx; value: string; onChange: (v: string) => void; all?: boolean }) {
  const list = ctx.boot.clients.filter((c) => c.tracking || c.slug === value);
  return (
    <select className="inp" value={value} onChange={(e) => onChange(e.target.value)}>
      {all && <option value="">All clients</option>}
      {!all && <option value="">Choose client…</option>}
      <option value={INTERNAL}>Internal · Digital Footprints</option>
      {list.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
      {all && ctx.boot.clients.filter((c) => !c.tracking).map((c) => <option key={c.slug} value={c.slug}>{c.name} (archived)</option>)}
    </select>
  );
}

function CategorySelect({ ctx, value, onChange, all }: { ctx: Ctx; value: string; onChange: (v: string) => void; all?: boolean }) {
  return (
    <select className="inp" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{all ? 'All work types' : 'Work type…'}</option>
      {ctx.boot.categories.filter((c) => c.active || String(c.id) === value).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}

/* ---------------------------------------------------------------- room */

export function Time({ teamMode = false, onSignOut }: { teamMode?: boolean; onSignOut?: () => void }) {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('track');
  const [version, setVersion] = useState(0);
  const [actor, setActor] = useState<number | null>(() => Number(readLs(ACTOR_KEY)) || null);

  const reload = useCallback(async () => {
    try { setBoot(await timeApi.boot()); setErr(null); }
    catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  // Timer changes made from the floating mini-timer (or anywhere else) land here too.
  useEffect(() => {
    const on = () => { reload(); setVersion((v) => v + 1); };
    window.addEventListener(TIME_CHANGED, on);
    return () => window.removeEventListener(TIME_CHANGED, on);
  }, [reload]);

  const ctx: Ctx | null = useMemo(() => {
    if (!boot) return null;
    const memberById = new Map(boot.members.map((m) => [m.id, m]));
    const clientBySlug = new Map(boot.clients.map((c) => [c.slug, c]));
    const cats = new Map(boot.categories.map((c) => [c.id, c]));
    const locks = new Set(boot.locks);
    return {
      boot,
      cur: boot.settings.currency || 'GBP',
      admin: boot.me.admin,
      seesAll: boot.me.admin || boot.me.role === 'manager',
      memberById,
      clientName: (s) => (!s ? 'Internal · Digital Footprints' : clientBySlug.get(s)?.name ?? s),
      catName: (id) => (id ? cats.get(id)?.name ?? '—' : '—'),
      isLocked: (d) => locks.has(mondayOf(d)),
      reload,
      bump: () => setVersion((v) => v + 1),
      version,
    };
  }, [boot, reload, version]);

  if (err && !boot) {
    return (
      <div className="card accent" style={{ borderLeft: '3px solid var(--warn)' }}>
        <div className="eyebrow">Time tracking needs the reporting core</div>
        <p className="small" style={{ margin: '8px 0 0', color: 'var(--muted)' }}>
          Hours are saved to reporting.db, so this room only works when you’re signed in to the
          reporting app (or opened a team join link). <span style={{ color: 'var(--faint)' }}>({err})</span>
        </p>
      </div>
    );
  }
  if (!ctx || !boot) return <Empty>Loading time…</Empty>;

  // Who we're logging as: a member is always themselves; admin/manager can switch.
  const activeMembers = boot.members.filter((m) => m.active);
  const actingId = !ctx.seesAll
    ? boot.me.member_id
    : (actor && ctx.memberById.get(actor)?.active ? actor : boot.me.member_id ?? activeMembers[0]?.id ?? null);
  const setActing = (id: number) => { setActor(id); writeLs(ACTOR_KEY, String(id)); notifyTimeChanged(); };

  const tabs = TABS.filter((t) => !t.admin || ctx.admin);

  return (
    <>
      <div className="controls noprint" style={{ marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div className="seg">
          {tabs.map((t) => <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
        </div>
        <div style={{ flex: 1 }} />
        {ctx.seesAll && activeMembers.length > 0 && (tab === 'track' || tab === 'sheet') && (
          <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)' }}>
            Logging as
            <select className="inp" style={{ width: 'auto' }} value={actingId ?? ''} onChange={(e) => setActing(Number(e.target.value))}>
              {activeMembers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
        )}
        {teamMode && (
          <span className="small" style={{ color: 'var(--muted)' }}>
            Signed in as <b style={{ color: 'var(--ink)' }}>{boot.me.label}</b>
            {onSignOut && <> · <button className="linky" onClick={onSignOut}>Sign out</button></>}
          </span>
        )}
      </div>

      {ctx.admin && activeMembers.length === 0 && tab !== 'team' && (
        <div className="card accent" style={{ borderLeft: '3px solid var(--cyan)', marginBottom: 16 }}>
          <div className="eyebrow" style={{ color: 'var(--cyan)' }}>Start with your team</div>
          <p className="small" style={{ margin: '8px 0 10px', color: 'var(--muted)' }}>
            Time is always logged against a person. Add yourself and the team (with rates and weekly
            hours) — each person gets a private join link to track their own time.
          </p>
          <button className="btn sm" onClick={() => setTab('team')}>Add team members</button>
        </div>
      )}

      {tab === 'track' && <Track ctx={ctx} actingId={actingId} />}
      {tab === 'sheet' && <Timesheet ctx={ctx} actingId={actingId} onPick={(id) => setActing(id)} />}
      {tab === 'reports' && <Reports ctx={ctx} />}
      {tab === 'team' && ctx.admin && <Team ctx={ctx} />}
      {tab === 'clients' && ctx.admin && <Clients ctx={ctx} />}
      {tab === 'settings' && ctx.admin && <Settings ctx={ctx} />}
    </>
  );
}

/* ---------------------------------------------------------------- Track */

interface Draft { client: string; category: string; description: string; billable: boolean; date: string; duration: string }
const blankDraft = (): Draft => ({ client: '', category: '', description: '', billable: true, date: today(), duration: '' });

function Track({ ctx, actingId }: { ctx: Ctx; actingId: number | null }) {
  const { boot } = ctx;
  const [week, setWeek] = useState(mondayOf(today()));
  const [d, setD] = useState<Draft>(blankDraft);
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const days = weekDays(week);
  const all = useEntries(days[0], days[6], ctx.version);
  const running = boot.running.find((e) => e.member_id === actingId) ?? null;
  const othersRunning = ctx.seesAll ? boot.running.filter((e) => e.member_id !== actingId) : [];
  const now = useNow(boot.running.length > 0);
  const mine = (all ?? []).filter((e) => e.member_id === actingId);

  const refresh = async () => { await ctx.reload(); ctx.bump(); };

  // Billable follows the work type (and internal time is never billable)
  // until the person overrides it.
  const setClient = (client: string) => setD((p) => ({ ...p, client, billable: client !== INTERNAL && (ctx.boot.categories.find((c) => String(c.id) === p.category)?.billable ?? true) }));
  const setCat = (category: string) => setD((p) => ({ ...p, category, billable: p.client !== INTERNAL && (ctx.boot.categories.find((c) => String(c.id) === category)?.billable ?? true) }));

  const payload = (): EntryInput => ({
    member_id: actingId ?? undefined,
    client_slug: d.client,
    category_id: d.category ? Number(d.category) : null,
    description: d.description,
    billable: d.billable,
  });

  const start = async () => {
    if (!actingId) return toast('Add a team member first');
    if (!d.client) return toast('Pick a client (or Internal)');
    setBusy(true);
    const ok = await attempt(async () => {
      const r = await timeApi.start(payload());
      if (r.stopped) toast(`Stopped previous timer at ${hm(r.stopped.minutes)}`);
    });
    setBusy(false);
    if (ok) { setD((p) => ({ ...blankDraft(), client: p.client, category: p.category, billable: p.billable })); await refresh(); }
  };
  const add = async () => {
    if (!actingId) return toast('Add a team member first');
    if (!d.client) return toast('Pick a client (or Internal)');
    const minutes = parseDuration(d.duration);
    if (!minutes) return toast('Duration like 1:30, 1.5 or 45m');
    setBusy(true);
    const ok = await attempt(() => timeApi.addEntry({ ...payload(), date: d.date, minutes }), `Logged ${hm(minutes)}`);
    setBusy(false);
    if (ok) { setD((p) => ({ ...blankDraft(), client: p.client, category: p.category, billable: p.billable, date: p.date })); await refresh(); }
  };
  const stop = async () => {
    setBusy(true);
    const ok = await attempt(async () => { const r = await timeApi.stop(actingId ?? undefined); toast(`Logged ${hm(r.entry.minutes)}`); });
    setBusy(false);
    if (ok) await refresh();
  };

  const weekTotal = mine.reduce((s, e) => s + liveMinutes(e, now), 0);
  const weekBill = mine.filter((e) => e.billable).reduce((s, e) => s + liveMinutes(e, now), 0);
  const member = actingId ? ctx.memberById.get(actingId) : undefined;
  const cap = member?.capacity_hours ?? (Number(boot.settings.week_hours_target) || 37.5);

  return (
    <>
      {/* Timer / quick add */}
      <div className="card" style={{ marginBottom: 16, padding: 16 }}>
        {running ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <span className="dot up" style={{ animation: 'pulse 1.6s infinite' }} />
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{ctx.clientName(running.client_slug)} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· {ctx.catName(running.category_id)}</span></div>
              <div className="small" style={{ color: 'var(--muted)' }}>{running.description || 'No description'}{!running.billable && ' · non-billable'}</div>
            </div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 26, fontWeight: 500, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{liveClock(running, now)}</div>
            <button className="btn ghost" onClick={requestPopout} title="Float a mini timer above every window on your desktop">⧉ Pop out</button>
            <button className="btn" disabled={busy} onClick={stop} style={{ background: 'var(--fail)', borderColor: 'var(--fail)' }}>■ Stop</button>
          </div>
        ) : (
          <div className="time-form">
            <ClientSelect ctx={ctx} value={d.client} onChange={setClient} />
            <CategorySelect ctx={ctx} value={d.category} onChange={setCat} />
            <input className="inp" placeholder="What are you working on?" value={d.description}
              onChange={(e) => setD({ ...d, description: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') { if (d.duration) { add(); } else { start(); } } }} />
            <label className="small time-bill"><input type="checkbox" checked={d.billable} onChange={(e) => setD({ ...d, billable: e.target.checked })} /> Billable</label>
            <input className="inp" type="date" value={d.date} max={addDays(today(), 7)} onChange={(e) => setD({ ...d, date: e.target.value })} title="Date (for manual entries)" />
            <input className="inp" placeholder="1:30" value={d.duration} style={{ fontFamily: 'JetBrains Mono, monospace' }}
              onChange={(e) => setD({ ...d, duration: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
              title="Duration — 1:30, 1.5, 1h30 or 45m" />
            {d.duration
              ? <button className="btn" disabled={busy} onClick={add}>+ Add time</button>
              : <button className="btn" disabled={busy} onClick={start}>▶ Start timer</button>}
          </div>
        )}
        {othersRunning.length > 0 && (
          <div className="small" style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--line-soft)', color: 'var(--muted)', display: 'flex', flexWrap: 'wrap', gap: 14 }}>
            <span className="eyebrow">Running now</span>
            {othersRunning.map((e) => (
              <span key={e.id}><Dot color={ctx.memberById.get(e.member_id)?.color} />{ctx.memberById.get(e.member_id)?.name} — {ctx.clientName(e.client_slug)} <code>{hm(liveMinutes(e, now))}</code></span>
            ))}
          </div>
        )}
      </div>

      <div className="controls" style={{ marginBottom: 10 }}>
        <WeekNav week={week} setWeek={setWeek} />
        <div style={{ flex: 1 }} />
        <span className="small" style={{ color: 'var(--muted)' }}>
          {member?.name ?? '—'} · <b style={{ color: 'var(--ink)' }}>{hm(weekTotal)}</b> of {cap}h
          {weekTotal > 0 && <> · {Math.round((weekBill / weekTotal) * 100)}% billable</>}
        </span>
      </div>
      <div style={{ marginBottom: 14 }}><Bar pct={(weekTotal / 60 / (cap || 1)) * 100} tone={weekTotal / 60 > cap ? 'warn' : undefined} /></div>

      {all === null ? <Empty>Loading…</Empty> : days.slice().reverse().filter((day) => day <= today() || mine.some((e) => e.date === day)).map((day) => {
        const list = mine.filter((e) => e.date === day);
        const total = list.reduce((s, e) => s + liveMinutes(e, now), 0);
        const locked = ctx.isLocked(day);
        return (
          <div key={day} className="card" style={{ padding: '6px 8px', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '6px 10px 4px' }}>
              <b style={{ color: 'var(--ink)', fontSize: 13 }}>{day === today() ? 'Today' : dayLabel(day, { weekday: 'long', day: 'numeric', month: 'short' })}</b>
              {locked && <span className="pill" style={{ marginLeft: 8 }}>🔒 Locked</span>}
              <div style={{ flex: 1 }} />
              <code>{hm(total)}</code>
            </div>
            {list.length === 0 ? <div className="small" style={{ padding: '4px 10px 8px', color: 'var(--faint)' }}>Nothing logged</div> : (
              <table className="t">
                <tbody>
                  {list.map((e) => editId === e.id
                    ? <EntryEditor key={e.id} ctx={ctx} e={e} onDone={async (changed) => { setEditId(null); if (changed) await refresh(); }} />
                    : <EntryRow key={e.id} ctx={ctx} e={e} now={now} locked={locked && !ctx.admin}
                        onEdit={() => setEditId(e.id)}
                        onResume={async () => { if (await attempt(() => timeApi.start({ resume_id: e.id }), 'Timer resumed')) await refresh(); }}
                        onDelete={async () => { if (confirm('Delete this entry?') && await attempt(() => timeApi.deleteEntry(e.id), 'Deleted')) await refresh(); }}
                        onDuplicate={async () => { if (await attempt(() => timeApi.addEntry({ member_id: e.member_id, client_slug: e.client_slug ?? INTERNAL, category_id: e.category_id, description: e.description, billable: e.billable, minutes: e.minutes, date: today() }), 'Copied to today')) await refresh(); }}
                      />)}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </>
  );
}

function WeekNav({ week, setWeek }: { week: string; setWeek: (w: string) => void }) {
  const end = addDays(week, 6);
  const thisWeek = mondayOf(today());
  return (
    <div className="cal-nav" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button className="chiptoggle" onClick={() => setWeek(addDays(week, -7))}>‹</button>
      <b style={{ color: 'var(--ink)', minWidth: 150, textAlign: 'center', fontSize: 13 }}>
        {dayLabel(week, { day: 'numeric', month: 'short' })} – {dayLabel(end, { day: 'numeric', month: 'short', year: 'numeric' })}
      </b>
      <button className="chiptoggle" onClick={() => setWeek(addDays(week, 7))} disabled={week >= thisWeek}>›</button>
      {week !== thisWeek && <button className="chiptoggle" onClick={() => setWeek(thisWeek)}>This week</button>}
    </div>
  );
}

function EntryRow({ ctx, e, now, locked, onEdit, onResume, onDelete, onDuplicate, showMember }: {
  ctx: Ctx; e: Entry; now: number; locked: boolean; showMember?: boolean;
  onEdit: () => void; onResume: () => void; onDelete: () => void; onDuplicate: () => void;
}) {
  const m = ctx.memberById.get(e.member_id);
  return (
    <tr>
      {showMember && <td style={{ width: 130 }}><Dot color={m?.color} />{m?.name ?? '—'}</td>}
      <td style={{ width: '26%' }}>
        <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{ctx.clientName(e.client_slug)}</div>
        <div className="small" style={{ color: 'var(--muted)' }}>{ctx.catName(e.category_id)}</div>
      </td>
      <td style={{ color: e.description ? 'var(--body)' : 'var(--faint)' }}>{e.description || 'No description'}</td>
      <td style={{ width: 110, whiteSpace: 'nowrap' }}>{e.billable ? <span className="pill pass">Billable</span> : <span className="pill">Non-billable</span>}</td>
      <td style={{ width: 70, textAlign: 'right' }}>
        <code style={e.running ? { background: 'var(--cyan-100)', color: 'var(--cyan)' } : undefined}>{hm(liveMinutes(e, now))}</code>
      </td>
      <td style={{ width: 150, textAlign: 'right', whiteSpace: 'nowrap' }} className="noprint">
        {!locked && !e.running && <button className="linky small" title="Resume timer" onClick={onResume}>▶</button>}
        <button className="linky small" style={{ marginLeft: 10 }} title="Copy to today" onClick={onDuplicate}>Copy</button>
        {!locked && <button className="linky small" style={{ marginLeft: 10 }} onClick={onEdit}>Edit</button>}
        {!locked && <button className="linky small" style={{ marginLeft: 10, color: 'var(--fail)' }} onClick={onDelete}>✕</button>}
      </td>
    </tr>
  );
}

function EntryEditor({ ctx, e, onDone, showMember }: { ctx: Ctx; e: Entry; onDone: (changed: boolean) => void; showMember?: boolean }) {
  const [client, setClient] = useState(e.client_slug ?? INTERNAL);
  const [cat, setCat] = useState(e.category_id ? String(e.category_id) : '');
  const [desc, setDesc] = useState(e.description);
  const [date, setDate] = useState(e.date);
  const [dur, setDur] = useState(hm(e.minutes));
  const [billable, setBillable] = useState(e.billable);
  const [member, setMember] = useState(e.member_id);
  const [rate, setRate] = useState(e.bill_rate === null ? '' : String(e.bill_rate));
  const save = async () => {
    const minutes = e.running ? undefined : parseDuration(dur);
    if (!e.running && !minutes) return toast('Duration like 1:30, 1.5 or 45m');
    const body: EntryInput = { client_slug: client, category_id: cat ? Number(cat) : null, description: desc, date, billable, member_id: member };
    if (minutes) body.minutes = minutes;
    if (ctx.admin && rate !== (e.bill_rate === null ? '' : String(e.bill_rate))) body.bill_rate = rate === '' ? null : Number(rate);
    if (await attempt(() => timeApi.updateEntry(e.id, body), 'Saved')) onDone(true);
  };
  return (
    <tr className="expand">
      <td colSpan={showMember ? 6 : 5}>
        <div className="time-form" style={{ padding: 4 }}>
          {ctx.seesAll && (
            <select className="inp" value={member} onChange={(ev) => setMember(Number(ev.target.value))}>
              {ctx.boot.members.filter((m) => m.active || m.id === e.member_id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
          <ClientSelect ctx={ctx} value={client} onChange={setClient} />
          <CategorySelect ctx={ctx} value={cat} onChange={setCat} />
          <input className="inp" value={desc} onChange={(ev) => setDesc(ev.target.value)} placeholder="Description" />
          <label className="small time-bill"><input type="checkbox" checked={billable} onChange={(ev) => setBillable(ev.target.checked)} /> Billable</label>
          <input className="inp" type="date" value={date} onChange={(ev) => setDate(ev.target.value)} />
          <input className="inp" value={e.running ? 'running' : dur} disabled={e.running} onChange={(ev) => setDur(ev.target.value)} style={{ fontFamily: 'JetBrains Mono, monospace' }} />
          {ctx.admin && <input className="inp" value={rate} onChange={(ev) => setRate(ev.target.value)} placeholder="Rate/h" title="Bill rate saved on this entry" style={{ maxWidth: 90 }} />}
          <button className="btn sm" onClick={save}>Save</button>
          <button className="btn sm ghost" onClick={() => onDone(false)}>Cancel</button>
        </div>
      </td>
    </tr>
  );
}

/* ---------------------------------------------------------------- Timesheet */

function Timesheet({ ctx, actingId, onPick }: { ctx: Ctx; actingId: number | null; onPick: (id: number) => void }) {
  const [week, setWeek] = useState(mondayOf(today()));
  const days = weekDays(week);
  const all = useEntries(days[0], days[6], ctx.version);
  const locked = ctx.isLocked(week);
  const members = ctx.boot.members.filter((m) => m.active);

  const toggleLock = async () => {
    const ok = locked
      ? await attempt(() => timeApi.unlock(week), 'Week unlocked')
      : confirm('Lock this week? Team members won’t be able to add, edit or delete time in it.') && await attempt(() => timeApi.lock(week), 'Week locked');
    if (ok) { await ctx.reload(); ctx.bump(); }
  };

  const mine = (all ?? []).filter((e) => e.member_id === actingId);
  // Personal grid: rows = client × work type.
  const rows = useMemo(() => {
    const map = new Map<string, { client: string | null; cat: number | null; byDay: Record<string, number>; total: number }>();
    for (const e of mine) {
      const k = `${e.client_slug ?? ''}|${e.category_id ?? ''}`;
      const r = map.get(k) ?? { client: e.client_slug, cat: e.category_id, byDay: {}, total: 0 };
      r.byDay[e.date] = (r.byDay[e.date] ?? 0) + e.minutes;
      r.total += e.minutes;
      map.set(k, r);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [mine]);
  const dayTotal = (list: Entry[], day: string) => list.filter((e) => e.date === day).reduce((s, e) => s + e.minutes, 0);

  return (
    <>
      <div className="controls" style={{ marginBottom: 14 }}>
        <WeekNav week={week} setWeek={setWeek} />
        <div style={{ flex: 1 }} />
        {locked && <span className="pill">🔒 Locked</span>}
        {ctx.admin && <button className="chiptoggle" onClick={toggleLock}>{locked ? 'Unlock week' : 'Lock week'}</button>}
      </div>

      {ctx.seesAll && (
        <div className="card" style={{ padding: '6px 8px', marginBottom: 16 }}>
          <div className="eyebrow" style={{ padding: '8px 10px 2px' }}>Team week</div>
          {all === null ? <Empty>Loading…</Empty> : members.length === 0 ? <Empty>No team members yet.</Empty> : (
            <div style={{ overflowX: 'auto' }}>
              <table className="t">
                <thead>
                  <tr>
                    <th>Person</th>
                    {days.map((d) => <th key={d} style={{ textAlign: 'right' }}>{dayLabel(d, { weekday: 'short', day: 'numeric' })}</th>)}
                    <th style={{ textAlign: 'right' }}>Total</th>
                    <th style={{ width: 150 }}>Of capacity</th>
                    <th style={{ textAlign: 'right' }}>Billable</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => {
                    const list = all.filter((e) => e.member_id === m.id);
                    const total = list.reduce((s, e) => s + e.minutes, 0);
                    const bill = list.filter((e) => e.billable).reduce((s, e) => s + e.minutes, 0);
                    const pct = (total / 60 / (m.capacity_hours || 1)) * 100;
                    return (
                      <tr key={m.id} style={{ cursor: 'pointer', background: m.id === actingId ? 'var(--cyan-100)' : undefined }} onClick={() => onPick(m.id)} title="Show their timesheet below">
                        <td style={{ fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap' }}><Dot color={m.color} />{m.name}</td>
                        {days.map((d) => { const n = dayTotal(list, d); return <td key={d} style={{ textAlign: 'right', color: n ? 'var(--body)' : 'var(--faint)' }}>{n ? hm(n) : '–'}</td>; })}
                        <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--ink)' }}>{hm(total)}</td>
                        <td><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Bar pct={pct} tone={pct > 110 ? 'warn' : pct >= 80 ? 'pass' : undefined} /><span className="small" style={{ color: 'var(--muted)', minWidth: 34 }}>{Math.round(pct)}%</span></div></td>
                        <td style={{ textAlign: 'right' }} className="small">{total ? `${Math.round((bill / total) * 100)}%` : '–'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ padding: '6px 8px' }}>
        <div className="eyebrow" style={{ padding: '8px 10px 2px' }}>{actingId ? ctx.memberById.get(actingId)?.name : 'My'} timesheet</div>
        {all === null ? <Empty>Loading…</Empty> : rows.length === 0 ? <Empty>No time logged this week.</Empty> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="t">
              <thead>
                <tr>
                  <th>Client · work type</th>
                  {days.map((d) => <th key={d} style={{ textAlign: 'right' }}>{dayLabel(d, { weekday: 'short', day: 'numeric' })}</th>)}
                  <th style={{ textAlign: 'right' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.client}|${r.cat}`}>
                    <td><b style={{ color: 'var(--ink)' }}>{ctx.clientName(r.client)}</b> <span className="small" style={{ color: 'var(--muted)' }}>· {ctx.catName(r.cat)}</span></td>
                    {days.map((d) => <td key={d} style={{ textAlign: 'right', color: r.byDay[d] ? 'var(--body)' : 'var(--faint)' }}>{r.byDay[d] ? hm(r.byDay[d]) : '–'}</td>)}
                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--ink)' }}>{hm(r.total)}</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ fontWeight: 600 }}>Day total</td>
                  {days.map((d) => <td key={d} style={{ textAlign: 'right', fontWeight: 600 }}>{hm(dayTotal(mine, d))}</td>)}
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--ink)' }}>{hm(mine.reduce((s, e) => s + e.minutes, 0))}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- Reports */

type GroupBy = 'client' | 'member' | 'category' | 'day';

function Reports({ ctx }: { ctx: Ctx }) {
  const [rk, setRk] = useState<RangeKey>('this-month');
  const [custom, setCustom] = useState<[string, string]>(rangeFor('this-month'));
  const [start, end] = rk === 'custom' ? custom : rangeFor(rk);
  const all = useEntries(start, end, ctx.version);
  const [fMember, setFMember] = useState('');
  const [fClient, setFClient] = useState('');
  const [fCat, setFCat] = useState('');
  const [fBill, setFBill] = useState<'' | 'yes' | 'no'>('');
  const [group, setGroup] = useState<GroupBy>('client');
  const [showEntries, setShowEntries] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const cur = ctx.cur;

  const entries = useMemo(() => (all ?? []).filter((e) =>
    !e.running
    && (!fMember || e.member_id === Number(fMember))
    && (!fClient || (fClient === INTERNAL ? !e.client_slug : e.client_slug === fClient))
    && (!fCat || e.category_id === Number(fCat))
    && (!fBill || (fBill === 'yes') === e.billable)), [all, fMember, fClient, fCat, fBill]);

  const costOf = (e: Entry) => ((ctx.memberById.get(e.member_id)?.cost_rate ?? 0) * e.minutes) / 60;
  const total = entries.reduce((s, e) => s + e.minutes, 0);
  const billable = entries.filter((e) => e.billable).reduce((s, e) => s + e.minutes, 0);
  const value = entries.reduce((s, e) => s + entryValue(e), 0);
  const cost = entries.reduce((s, e) => s + costOf(e), 0);
  // Capacity only counts days that have happened — a half-gone month isn't 50% idle.
  const capEnd = end > today() ? today() : end;
  const weeks = capEnd >= start ? spanWeeks(start, capEnd) : 0;
  const members = ctx.boot.members.filter((m) => !fMember || m.id === Number(fMember));
  const capacity = members.filter((m) => m.active).reduce((s, m) => s + m.capacity_hours, 0) * weeks;

  const keyOf: Record<GroupBy, (e: Entry) => string> = {
    client: (e) => e.client_slug ?? INTERNAL,
    member: (e) => String(e.member_id),
    category: (e) => String(e.category_id ?? ''),
    day: (e) => e.date,
  };
  const labelOf: Record<GroupBy, (k: string) => string> = {
    client: (k) => ctx.clientName(k === INTERNAL ? null : k),
    member: (k) => ctx.memberById.get(Number(k))?.name ?? 'Unknown',
    category: (k) => (k ? ctx.catName(Number(k)) : 'Uncategorised'),
    day: (k) => dayLabel(k, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
  };
  let rolls = rollUp(entries, keyOf[group], labelOf[group], costOf);
  if (group === 'day') rolls = rolls.sort((a, b) => a.key.localeCompare(b.key));
  const maxMin = Math.max(1, ...rolls.map((r) => r.minutes));

  // Budgets only make sense against whole calendar months.
  const monthsInRange = rk === 'this-month' || rk === 'last-month' ? 1 : rk === 'this-quarter' ? 3 : rk === 'this-year' ? 12 : 0;
  const budgetOf = (slug: string) => ctx.boot.clients.find((c) => c.slug === slug)?.budget_hours ?? null;

  const rangeTag = `${start}_to_${end}`;
  const exportEntries = () => {
    const head = ['Date', 'Person', 'Client', 'Work type', 'Description', 'Hours', 'Duration (h:mm)', 'Billable', `Rate (${cur})`, `Value (${cur})`];
    if (ctx.admin) head.push(`Cost (${cur})`);
    const rows = entries.slice().sort((a, b) => a.date.localeCompare(b.date)).map((e) => {
      const r: unknown[] = [e.date, ctx.memberById.get(e.member_id)?.name ?? '', ctx.clientName(e.client_slug), ctx.catName(e.category_id),
        e.description, dec(e.minutes), hm(e.minutes), e.billable ? 'Yes' : 'No', e.bill_rate ?? '', entryValue(e).toFixed(2)];
      if (ctx.admin) r.push(costOf(e).toFixed(2));
      return r;
    });
    download(`df-time-entries_${rangeTag}.csv`, toCsv([head, ...rows]));
  };
  const exportSummary = () => {
    const head = [group === 'client' ? 'Client' : group === 'member' ? 'Person' : group === 'category' ? 'Work type' : 'Day', 'Hours', 'Billable hours', 'Billable %', `Value (${cur})`];
    if (ctx.admin) head.push(`Cost (${cur})`, `Margin (${cur})`);
    if (group === 'client' && monthsInRange) head.push('Budget hours', 'Budget used %');
    const rows = rolls.map((r) => {
      const row: unknown[] = [r.label, dec(r.minutes), dec(r.billable), r.minutes ? Math.round((r.billable / r.minutes) * 100) : 0, r.value.toFixed(2)];
      if (ctx.admin) row.push(r.cost.toFixed(2), (r.value - r.cost).toFixed(2));
      if (group === 'client' && monthsInRange) {
        const b = budgetOf(r.key);
        row.push(b ? b * monthsInRange : '', b ? Math.round((r.minutes / 60 / (b * monthsInRange)) * 100) : '');
      }
      return row;
    });
    rows.push(['Total', dec(total), dec(billable), total ? Math.round((billable / total) * 100) : 0, value.toFixed(2), ...(ctx.admin ? [cost.toFixed(2), (value - cost).toFixed(2)] : [])]);
    download(`df-time-summary-by-${group}_${rangeTag}.csv`, toCsv([[`Digital Footprints · time summary ${start} to ${end}`], [], head, ...rows]));
  };

  const filterLabel = [
    fMember && ctx.memberById.get(Number(fMember))?.name,
    fClient && ctx.clientName(fClient === INTERNAL ? null : fClient),
    fCat && ctx.catName(Number(fCat)),
    fBill === 'yes' ? 'Billable only' : fBill === 'no' ? 'Non-billable only' : '',
  ].filter(Boolean).join(' · ');

  return (
    <>
      <div className="print-only" style={{ marginBottom: 14 }}>
        <h2>Digital Footprints · Time report</h2>
        <div className="small">{dayLabel(start, { day: 'numeric', month: 'long', year: 'numeric' })} – {dayLabel(end, { day: 'numeric', month: 'long', year: 'numeric' })}{filterLabel && ` · ${filterLabel}`}</div>
      </div>

      <div className="card noprint" style={{ padding: 12, marginBottom: 16 }}>
        <div className="controls" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div className="seg">
            {(Object.keys(RANGE_LABEL) as RangeKey[]).map((k) => <button key={k} className={rk === k ? 'on' : ''} onClick={() => setRk(k)}>{RANGE_LABEL[k]}</button>)}
          </div>
          {rk === 'custom' && (
            <>
              <input className="inp" type="date" style={{ width: 'auto' }} value={custom[0]} onChange={(e) => setCustom([e.target.value, custom[1]])} />
              <span className="small">to</span>
              <input className="inp" type="date" style={{ width: 'auto' }} value={custom[1]} onChange={(e) => setCustom([custom[0], e.target.value])} />
            </>
          )}
        </div>
        <div className="time-filters" style={{ marginTop: 10 }}>
          {ctx.seesAll && (
            <select className="inp" value={fMember} onChange={(e) => setFMember(e.target.value)}>
              <option value="">Everyone</option>
              {ctx.boot.members.map((m) => <option key={m.id} value={m.id}>{m.name}{m.active ? '' : ' (archived)'}</option>)}
            </select>
          )}
          <ClientSelect ctx={ctx} value={fClient} onChange={setFClient} all />
          <CategorySelect ctx={ctx} value={fCat} onChange={setFCat} all />
          <select className="inp" value={fBill} onChange={(e) => setFBill(e.target.value as '' | 'yes' | 'no')}>
            <option value="">Billable + non-billable</option>
            <option value="yes">Billable only</option>
            <option value="no">Non-billable only</option>
          </select>
        </div>
      </div>

      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Stat n={hm(total)} label={`Hours logged · ${dec(total)}h`} />
        <Stat n={total ? `${Math.round((billable / total) * 100)}%` : '–'} label={`Billable · ${hm(billable)}`} tone={total && billable / total < 0.6 ? 'warn' : undefined} />
        <Stat n={money(value, cur)} label="Billable value" />
        {ctx.admin
          ? <Stat n={money(value - cost, cur)} label={`Margin after ${money(cost, cur)} cost`} tone={value - cost < 0 ? 'fail' : 'pass'} />
          : <Stat n={capacity ? `${Math.round((total / 60 / capacity) * 100)}%` : '–'} label="Of capacity" />}
      </div>
      {ctx.admin && (
        <div className="small" style={{ color: 'var(--muted)', marginTop: -6, marginBottom: 14 }}>
          Utilisation to date {capacity ? <b style={{ color: 'var(--ink)' }}>{Math.round((total / 60 / capacity) * 100)}%</b> : '–'} of {Math.round(capacity)}h capacity
          {' '}· billable utilisation {capacity ? <b style={{ color: 'var(--ink)' }}>{Math.round((billable / 60 / capacity) * 100)}%</b> : '–'}
          {' '}· {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}
          {entries.some((e) => e.billable && !e.bill_rate) && <span style={{ color: 'var(--warn)' }}> · some billable time has no rate set</span>}
        </div>
      )}

      <div className="controls noprint" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <div className="seg">
          {(['client', 'member', 'category', 'day'] as GroupBy[]).filter((g) => g !== 'member' || ctx.seesAll).map((g) => (
            <button key={g} className={group === g ? 'on' : ''} onClick={() => setGroup(g)}>
              By {g === 'member' ? 'person' : g === 'category' ? 'work type' : g}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn sm ghost" onClick={exportSummary} disabled={!entries.length}>⇩ Summary CSV</button>
        <button className="btn sm ghost" onClick={exportEntries} disabled={!entries.length}>⇩ Entries CSV</button>
        <button className="btn sm" onClick={() => window.print()} disabled={!entries.length}>Print / PDF</button>
      </div>

      <div className="card" style={{ padding: '6px 8px', marginBottom: 16 }}>
        {all === null ? <Empty>Loading…</Empty> : rolls.length === 0 ? <Empty>No time in this range{filterLabel ? ' for these filters' : ''}.</Empty> : (
          <RollTable ctx={ctx} rolls={rolls} maxMin={maxMin} total={total} group={group} monthsInRange={monthsInRange} budgetOf={budgetOf} />
        )}
      </div>

      <div className="noprint">
        <button className="chiptoggle" onClick={() => setShowEntries(!showEntries)}>{showEntries ? 'Hide' : 'Show'} all {entries.length} entries</button>
      </div>
      {showEntries && (
        <div className="card" style={{ padding: '6px 8px', marginTop: 10 }}>
          <table className="t">
            <thead><tr>{ctx.seesAll && <th>Person</th>}<th>Client</th><th>Description</th><th>Billable</th><th style={{ textAlign: 'right' }}>Time</th><th className="noprint" /></tr></thead>
            <tbody>
              {Object.entries(entries.reduce<Record<string, Entry[]>>((acc, e) => { (acc[e.date] ||= []).push(e); return acc; }, {}))
                .sort(([a], [b]) => b.localeCompare(a))
                .map(([day, list]) => (
                  <Fragment key={day}>
                    <tr><td colSpan={ctx.seesAll ? 6 : 5} className="small" style={{ background: 'var(--line-soft)', fontWeight: 600 }}>{dayLabel(day, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })} · {hm(list.reduce((s, e) => s + e.minutes, 0))}</td></tr>
                    {list.map((e) => editId === e.id
                      ? <EntryEditor key={e.id} ctx={ctx} e={e} showMember={ctx.seesAll} onDone={async (c) => { setEditId(null); if (c) { await ctx.reload(); ctx.bump(); } }} />
                      : <EntryRow key={e.id} ctx={ctx} e={e} now={Date.now()} showMember={ctx.seesAll} locked={ctx.isLocked(e.date) && !ctx.admin}
                          onEdit={() => setEditId(e.id)}
                          onResume={async () => { if (await attempt(() => timeApi.start({ resume_id: e.id }), 'Timer resumed')) { await ctx.reload(); ctx.bump(); } }}
                          onDelete={async () => { if (confirm('Delete this entry?') && await attempt(() => timeApi.deleteEntry(e.id), 'Deleted')) { await ctx.reload(); ctx.bump(); } }}
                          onDuplicate={async () => { if (await attempt(() => timeApi.addEntry({ member_id: e.member_id, client_slug: e.client_slug ?? INTERNAL, category_id: e.category_id, description: e.description, billable: e.billable, minutes: e.minutes, date: today() }), 'Copied to today')) { await ctx.reload(); ctx.bump(); } }}
                        />)}
                  </Fragment>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function RollTable({ ctx, rolls, maxMin, total, group, monthsInRange, budgetOf }: {
  ctx: Ctx; rolls: Roll[]; maxMin: number; total: number; group: GroupBy; monthsInRange: number; budgetOf: (slug: string) => number | null;
}) {
  const showBudget = group === 'client' && monthsInRange > 0;
  return (
    <table className="t">
      <thead>
        <tr>
          <th>{group === 'client' ? 'Client' : group === 'member' ? 'Person' : group === 'category' ? 'Work type' : 'Day'}</th>
          <th style={{ width: '22%' }} />
          <th style={{ textAlign: 'right' }}>Hours</th>
          <th style={{ textAlign: 'right' }}>Share</th>
          <th style={{ textAlign: 'right' }}>Billable</th>
          <th style={{ textAlign: 'right' }}>Value</th>
          {ctx.admin && <th style={{ textAlign: 'right' }}>Margin</th>}
          {showBudget && <th style={{ width: 150 }}>Budget</th>}
        </tr>
      </thead>
      <tbody>
        {rolls.map((r) => {
          const b = showBudget ? budgetOf(r.key) : null;
          const budget = b ? b * monthsInRange : 0;
          const used = budget ? (r.minutes / 60 / budget) * 100 : 0;
          const color = group === 'member' ? ctx.memberById.get(Number(r.key))?.color : undefined;
          return (
            <tr key={r.key}>
              <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{color && <Dot color={color} />}{r.label}</td>
              <td style={{ verticalAlign: 'middle' }}><Bar pct={(r.minutes / maxMin) * 100} /></td>
              <td style={{ textAlign: 'right' }}><b style={{ color: 'var(--ink)' }}>{hm(r.minutes)}</b></td>
              <td style={{ textAlign: 'right', color: 'var(--muted)' }}>{Math.round((r.minutes / (total || 1)) * 100)}%</td>
              <td style={{ textAlign: 'right' }}>{r.minutes ? `${Math.round((r.billable / r.minutes) * 100)}%` : '–'}</td>
              <td style={{ textAlign: 'right' }}>{r.value ? money(r.value, ctx.cur) : '–'}</td>
              {ctx.admin && <td style={{ textAlign: 'right', color: r.value - r.cost < 0 ? 'var(--fail)' : undefined }}>{r.value || r.cost ? money(r.value - r.cost, ctx.cur) : '–'}</td>}
              {showBudget && (
                <td>{budget ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Bar pct={used} tone={used > 100 ? 'fail' : used > 85 ? 'warn' : 'pass'} />
                    <span className="small" style={{ whiteSpace: 'nowrap', color: used > 100 ? 'var(--fail)' : 'var(--muted)' }}>{Math.round(used)}% of {budget}h</span>
                  </div>
                ) : <span className="small" style={{ color: 'var(--faint)' }}>—</span>}</td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ---------------------------------------------------------------- Team (admin) */

const blankMember = { name: '', email: '', role: 'member' as Member['role'], bill_rate: '', cost_rate: '', capacity_hours: '37.5' };

function Team({ ctx }: { ctx: Ctx }) {
  const fresh = () => ({ ...blankMember, capacity_hours: ctx.boot.settings.week_hours_target || '37.5' });
  const [form, setForm] = useState(fresh);
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const members = ctx.boot.members.filter((m) => m.active || showArchived);
  const archivedCount = ctx.boot.members.filter((m) => !m.active).length;
  const num = (v: string) => (v.trim() === '' ? null : Number(v));

  const add = async () => {
    if (!form.name.trim()) return toast('Name is required');
    const color = MEMBER_COLORS[ctx.boot.members.length % MEMBER_COLORS.length];
    if (await attempt(() => timeApi.addMember({
      name: form.name, email: form.email || null, role: form.role, color,
      bill_rate: num(form.bill_rate), cost_rate: num(form.cost_rate), capacity_hours: num(form.capacity_hours) ?? 37.5,
    }), `${form.name} added — copy their join link to send it`)) {
      setForm(fresh()); setAdding(false); await ctx.reload();
    }
  };
  const copy = async (url?: string | null) => {
    if (!url) return;
    try { await navigator.clipboard.writeText(url); toast('Join link copied'); } catch { prompt('Copy this join link', url); }
  };

  return (
    <>
      <div className="controls" style={{ marginBottom: 14 }}>
        <div className="small" style={{ color: 'var(--muted)', maxWidth: 640 }}>
          Each person gets a private join link — opening it signs them in to <b>Time only</b> (their own hours;
          managers see everyone’s). Nothing else in Agency HQ is visible to them. New link = old one stops working.
        </div>
        <div style={{ flex: 1 }} />
        {archivedCount > 0 && <button className={`chiptoggle ${showArchived ? 'on' : ''}`} onClick={() => setShowArchived(!showArchived)}>Archived ({archivedCount})</button>}
        <button className="btn" onClick={() => setAdding(!adding)}>+ Add person</button>
      </div>

      {adding && (
        <div className="card" style={{ padding: 14, marginBottom: 16 }}>
          <MemberFields form={form} setForm={setForm} cur={ctx.cur} />
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn sm" onClick={add}>Add person</button>
            <button className="btn sm ghost" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: '6px 8px' }}>
        {members.length === 0 ? <Empty>No team members yet — add yourself first.</Empty> : (
          <table className="t">
            <thead>
              <tr><th>Person</th><th>Role</th><th style={{ textAlign: 'right' }}>Bill rate</th><th style={{ textAlign: 'right' }}>Cost rate</th><th style={{ textAlign: 'right' }}>Hours/wk</th><th>Last sign-in</th><th style={{ width: 260 }} /></tr>
            </thead>
            <tbody>
              {members.map((m) => editId === m.id ? (
                <MemberEditRow key={m.id} ctx={ctx} m={m} onDone={() => setEditId(null)} />
              ) : (
                <tr key={m.id} style={{ opacity: m.active ? 1 : 0.55 }}>
                  <td>
                    <div style={{ fontWeight: 600, color: 'var(--ink)' }}><Dot color={m.color} />{m.name}</div>
                    <div className="small" style={{ color: 'var(--muted)', marginLeft: 15 }}>{m.email || 'no email'}</div>
                  </td>
                  <td>{m.role === 'manager' ? <span className="pill warn">Manager</span> : <span className="pill">Member</span>}</td>
                  <td style={{ textAlign: 'right' }}>{m.bill_rate != null ? money(m.bill_rate, ctx.cur) : <span style={{ color: 'var(--faint)' }}>—</span>}</td>
                  <td style={{ textAlign: 'right' }}>{m.cost_rate != null ? money(m.cost_rate, ctx.cur) : <span style={{ color: 'var(--faint)' }}>—</span>}</td>
                  <td style={{ textAlign: 'right' }}>{m.capacity_hours}</td>
                  <td className="small" style={{ color: 'var(--muted)' }}>{m.last_login_at ? dayLabel(m.last_login_at.slice(0, 10), { day: 'numeric', month: 'short' }) : 'never'}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {m.active && <button className="linky small" onClick={() => copy(m.invite_url)}>Copy join link</button>}
                    {m.active && <button className="linky small" style={{ marginLeft: 10 }} title="Issue a new link; the old one and its sessions stop working"
                      onClick={async () => { if (confirm(`Issue a new join link for ${m.name}? Their current link stops working.`)) { let url = ''; if (await attempt(async () => { url = (await timeApi.newInvite(m.id)).invite_url; })) { await ctx.reload(); copy(url); } } }}>New link</button>}
                    <button className="linky small" style={{ marginLeft: 10 }} onClick={() => setEditId(m.id)}>Edit</button>
                    <button className="linky small" style={{ marginLeft: 10 }}
                      onClick={async () => { if (await attempt(() => timeApi.updateMember(m.id, { active: !m.active }), m.active ? `${m.name} archived` : `${m.name} restored`)) await ctx.reload(); }}>
                      {m.active ? 'Archive' : 'Restore'}
                    </button>
                    {!m.active && <button className="linky small" style={{ marginLeft: 10, color: 'var(--fail)' }}
                      onClick={async () => { if (confirm(`Delete ${m.name} permanently?`) && await attempt(() => timeApi.deleteMember(m.id), 'Deleted')) await ctx.reload(); }}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

type MemberForm = typeof blankMember;
function MemberFields({ form, setForm, cur }: { form: MemberForm; setForm: (f: MemberForm) => void; cur: string }) {
  const f = (k: keyof MemberForm) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <div className="time-grid">
      <Field label="Name"><input className="inp" value={form.name} onChange={f('name')} autoFocus /></Field>
      <Field label="Email"><input className="inp" value={form.email} onChange={f('email')} placeholder="optional" /></Field>
      <Field label="Role">
        <select className="inp" value={form.role} onChange={f('role')}>
          <option value="member">Member — own time only</option>
          <option value="manager">Manager — sees everyone’s time</option>
        </select>
      </Field>
      <Field label={`Bill rate (${cur}/h)`}><input className="inp" value={form.bill_rate} onChange={f('bill_rate')} placeholder="e.g. 85" /></Field>
      <Field label={`Cost rate (${cur}/h)`}><input className="inp" value={form.cost_rate} onChange={f('cost_rate')} placeholder="salary ÷ hours" /></Field>
      <Field label="Hours per week"><input className="inp" value={form.capacity_hours} onChange={f('capacity_hours')} /></Field>
    </div>
  );
}

function MemberEditRow({ ctx, m, onDone }: { ctx: Ctx; m: Member; onDone: () => void }) {
  const s = (v: number | null | undefined) => (v == null ? '' : String(v));
  const [form, setForm] = useState<MemberForm>({ name: m.name, email: m.email ?? '', role: m.role, bill_rate: s(m.bill_rate), cost_rate: s(m.cost_rate), capacity_hours: s(m.capacity_hours) });
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const save = async () => {
    if (await attempt(() => timeApi.updateMember(m.id, {
      name: form.name, email: form.email || null, role: form.role,
      bill_rate: num(form.bill_rate), cost_rate: num(form.cost_rate), capacity_hours: num(form.capacity_hours) ?? 0,
    }), 'Saved')) { await ctx.reload(); onDone(); }
  };
  return (
    <tr className="expand"><td colSpan={7}>
      <MemberFields form={form} setForm={setForm} cur={ctx.cur} />
      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
        <button className="btn sm" onClick={save}>Save</button>
        <button className="btn sm ghost" onClick={onDone}>Cancel</button>
        <span className="small" style={{ color: 'var(--muted)' }}>Rate changes apply to new time — past entries keep the rate they were logged at.</span>
      </div>
    </td></tr>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="small" style={{ display: 'grid', gap: 4, color: 'var(--muted)' }}><span>{label}</span>{children}</label>;
}

/* ---------------------------------------------------------------- Clients (admin) */

function Clients({ ctx }: { ctx: Ctx }) {
  const [month] = useState(() => rangeFor('this-month'));
  const entries = useEntries(month[0], month[1], ctx.version);
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newBudget, setNewBudget] = useState('');
  const [newRate, setNewRate] = useState('');
  const [editSlug, setEditSlug] = useState<string | null>(null);

  const used = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries ?? []) if (e.client_slug) m.set(e.client_slug, (m.get(e.client_slug) ?? 0) + liveMinutes(e, Date.now()));
    return m;
  }, [entries]);

  const active = ctx.boot.clients.filter((c) => c.tracking);
  const archived = ctx.boot.clients.filter((c) => !c.tracking);
  const list = showArchived ? archived : active;
  const num = (v: string) => (v.trim() === '' ? null : Number(v));

  const add = async () => {
    if (!newName.trim()) return toast('Client name is required');
    if (await attempt(() => timeApi.addClient({ name: newName, budget_hours: num(newBudget), bill_rate: num(newRate) }), `${newName} added`)) {
      setNewName(''); setNewBudget(''); setNewRate(''); setAdding(false); await ctx.reload();
    }
  };

  return (
    <>
      <div className="controls" style={{ marginBottom: 14 }}>
        <div className="small" style={{ color: 'var(--muted)', maxWidth: 620 }}>
          Every Agency HQ client is here automatically. Add <b>time-only</b> clients for pitches and one-off
          jobs that don’t need reporting. Removing a client archives it — its hours stay in reports and exports.
        </div>
        <div style={{ flex: 1 }} />
        <div className="seg">
          <button className={!showArchived ? 'on' : ''} onClick={() => setShowArchived(false)}>Tracking ({active.length})</button>
          <button className={showArchived ? 'on' : ''} onClick={() => setShowArchived(true)}>Archived ({archived.length})</button>
        </div>
        <button className="btn" onClick={() => setAdding(!adding)}>+ Add client</button>
      </div>

      {adding && (
        <div className="card" style={{ padding: 14, marginBottom: 16 }}>
          <div className="time-grid">
            <Field label="Client name"><input className="inp" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && add()} /></Field>
            <Field label="Monthly budget (hours)"><input className="inp" value={newBudget} onChange={(e) => setNewBudget(e.target.value)} placeholder="optional" /></Field>
            <Field label={`Bill rate override (${ctx.cur}/h)`}><input className="inp" value={newRate} onChange={(e) => setNewRate(e.target.value)} placeholder="uses each person’s rate" /></Field>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
            <button className="btn sm" onClick={add}>Add time-only client</button>
            <button className="btn sm ghost" onClick={() => setAdding(false)}>Cancel</button>
            <span className="small" style={{ color: 'var(--muted)' }}>Need reporting or a portal too? Add them in the Clients room instead — they’ll appear here.</span>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: '6px 8px' }}>
        {list.length === 0 ? <Empty>{showArchived ? 'Nothing archived.' : 'No clients yet.'}</Empty> : (
          <table className="t">
            <thead>
              <tr><th>Client</th><th>Source</th><th style={{ textAlign: 'right' }}>Rate override</th><th style={{ width: 220 }}>This month vs budget</th><th style={{ width: 200 }} /></tr>
            </thead>
            <tbody>
              {list.map((c) => editSlug === c.slug
                ? <ClientEditRow key={c.slug} ctx={ctx} c={c} onDone={() => setEditSlug(null)} />
                : (
                <tr key={c.slug}>
                  <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{c.name}{c.notes && <div className="small" style={{ fontWeight: 400, color: 'var(--muted)' }}>{c.notes}</div>}</td>
                  <td className="small">{c.roster ? 'Agency HQ roster' : c.removed_from_roster ? <span style={{ color: 'var(--warn)' }}>Deleted from roster</span> : 'Time-only'}</td>
                  <td style={{ textAlign: 'right' }}>{c.bill_rate != null ? money(c.bill_rate, ctx.cur) : <span style={{ color: 'var(--faint)' }}>—</span>}</td>
                  <td>
                    {(() => {
                      const mins = used.get(c.slug) ?? 0;
                      if (!c.budget_hours) return <span className="small" style={{ color: mins ? 'var(--body)' : 'var(--faint)' }}>{mins ? `${hm(mins)} · no budget` : 'no budget'}</span>;
                      const pct = (mins / 60 / c.budget_hours) * 100;
                      return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Bar pct={pct} tone={pct > 100 ? 'fail' : pct > 85 ? 'warn' : 'pass'} />
                          <span className="small" style={{ minWidth: 92, color: pct > 100 ? 'var(--fail)' : 'var(--muted)' }}>{hm(mins)} / {c.budget_hours}h</span>
                        </div>
                      );
                    })()}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="linky small" onClick={() => setEditSlug(c.slug)}>Edit</button>
                    {!c.removed_from_roster && (
                      <button className="linky small" style={{ marginLeft: 10 }}
                        onClick={async () => { if (await attempt(() => timeApi.updateClient(c.slug, { tracking: !c.tracking }), c.tracking ? `${c.name} archived from time` : `${c.name} restored`)) await ctx.reload(); }}>
                        {c.tracking ? 'Remove' : 'Restore'}
                      </button>
                    )}
                    {!c.roster && (
                      <button className="linky small" style={{ marginLeft: 10, color: 'var(--fail)' }}
                        onClick={async () => { if (confirm(`Delete ${c.name}? Only possible when no time is booked to it.`) && await attempt(() => timeApi.deleteClient(c.slug), 'Deleted')) await ctx.reload(); }}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function ClientEditRow({ ctx, c, onDone }: { ctx: Ctx; c: TimeClient; onDone: () => void }) {
  const [name, setName] = useState(c.name);
  const [rate, setRate] = useState(c.bill_rate == null ? '' : String(c.bill_rate));
  const [budget, setBudget] = useState(c.budget_hours == null ? '' : String(c.budget_hours));
  const [notes, setNotes] = useState(c.notes ?? '');
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const save = async () => {
    const body: Partial<TimeClient> = { bill_rate: num(rate), budget_hours: num(budget), notes };
    if (!c.roster) body.name = name;
    if (await attempt(() => timeApi.updateClient(c.slug, body), 'Saved')) { await ctx.reload(); onDone(); }
  };
  return (
    <tr className="expand"><td colSpan={5}>
      <div className="time-grid">
        <Field label="Name">{c.roster ? <input className="inp" value={c.name} disabled title="Rename roster clients on their client page" /> : <input className="inp" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Monthly budget (hours)"><input className="inp" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="none" /></Field>
        <Field label={`Bill rate override (${ctx.cur}/h)`}><input className="inp" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="uses each person’s rate" /></Field>
        <Field label="Notes (internal)"><input className="inp" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. retainer: 20h SEO + content" /></Field>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button className="btn sm" onClick={save}>Save</button>
        <button className="btn sm ghost" onClick={onDone}>Cancel</button>
      </div>
    </td></tr>
  );
}

/* ---------------------------------------------------------------- Settings (admin) */

function Settings({ ctx }: { ctx: Ctx }) {
  const s = ctx.boot.settings;
  const [newCat, setNewCat] = useState('');
  const [newBill, setNewBill] = useState(true);
  const save = async (patch: Partial<typeof s>) => { if (await attempt(() => timeApi.saveSettings(patch), 'Saved')) await ctx.reload(); };
  const cats: Category[] = ctx.boot.categories;

  return (
    <div className="grid g2" style={{ alignItems: 'start' }}>
      <div className="card" style={{ padding: 16 }}>
        <div className="eyebrow" style={{ marginBottom: 10 }}>Work types</div>
        <table className="t">
          <tbody>
            {cats.map((c) => (
              <tr key={c.id} style={{ opacity: c.active ? 1 : 0.5 }}>
                <td>
                  <input className="inp" defaultValue={c.name} style={{ border: 'none', background: 'transparent', padding: 0 }}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== c.name) { attempt(() => timeApi.updateCategory(c.id, { name: v }), 'Renamed').then(() => ctx.reload()); } }} />
                </td>
                <td style={{ width: 120 }}>
                  <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="checkbox" checked={c.billable} onChange={(e) => attempt(() => timeApi.updateCategory(c.id, { billable: e.target.checked })).then(() => ctx.reload())} />
                    Billable
                  </label>
                </td>
                <td style={{ width: 130, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="linky small" onClick={() => attempt(() => timeApi.updateCategory(c.id, { active: !c.active })).then(() => ctx.reload())}>{c.active ? 'Archive' : 'Restore'}</button>
                  <button className="linky small" style={{ marginLeft: 10, color: 'var(--fail)' }}
                    onClick={async () => { if (confirm(`Delete “${c.name}”?`) && await attempt(() => timeApi.deleteCategory(c.id), 'Deleted')) await ctx.reload(); }}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <input className="inp" placeholder="New work type" value={newCat} onChange={(e) => setNewCat(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && newCat.trim()) { attempt(() => timeApi.addCategory({ name: newCat, billable: newBill }), 'Added').then(() => { setNewCat(''); ctx.reload(); }); } }} />
          <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}><input type="checkbox" checked={newBill} onChange={(e) => setNewBill(e.target.checked)} /> Billable</label>
          <button className="btn sm" disabled={!newCat.trim()} onClick={() => attempt(() => timeApi.addCategory({ name: newCat, billable: newBill }), 'Added').then(() => { setNewCat(''); ctx.reload(); })}>Add</button>
        </div>
        <p className="small" style={{ color: 'var(--muted)', marginBottom: 0 }}>The billable tick is the default for new entries of that type — people can still override it per entry. Internal time is always non-billable.</p>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div className="eyebrow" style={{ marginBottom: 10 }}>Tracking rules</div>
        <div style={{ display: 'grid', gap: 14 }}>
          <Field label="Currency">
            <select className="inp" value={s.currency} onChange={(e) => save({ currency: e.target.value })}>
              {['GBP', 'EUR', 'USD', 'AUD', 'CAD'].map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Round stopped timers up to">
            <select className="inp" value={s.round_minutes} onChange={(e) => save({ round_minutes: e.target.value })}>
              <option value="0">Off — exact minutes</option>
              <option value="5">5 minutes</option>
              <option value="6">6 minutes (0.1h)</option>
              <option value="10">10 minutes</option>
              <option value="15">15 minutes</option>
            </select>
          </Field>
          <Field label="Default hours per week (new people)">
            <input className="inp" defaultValue={s.week_hours_target} onBlur={(e) => e.target.value !== s.week_hours_target && save({ week_hours_target: e.target.value })} />
          </Field>
          <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={s.require_description === '1'} onChange={(e) => save({ require_description: e.target.checked ? '1' : '0' })} />
            Require a description on manual entries
          </label>
        </div>
        <p className="small" style={{ color: 'var(--muted)', marginBottom: 0 }}>
          Lock a signed-off week from the Timesheet tab — team members can’t change locked time; the admin still can.
        </p>
      </div>
    </div>
  );
}
