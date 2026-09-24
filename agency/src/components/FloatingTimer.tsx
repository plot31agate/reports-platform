/* FloatingTimer — the running timer, everywhere.

   Lives in the sidebar (every room, admin and team shells alike) and does
   four jobs:
     1. a compact sidebar widget: what's running, the ticking clock, pause/stop;
     2. "Pop out" — a tiny always-on-top window over the whole desktop via the
        Document Picture-in-Picture API (Chrome/Edge). Other browsers get a
        plain popup window instead;
     3. the browser tab title ticks while a timer runs (▶ 0:42:10 · Aera House);
     4. desktop notifications: a "still running?" check every couple of hours,
        and an optional nudge when nothing's running in working hours.

   Pause = stop the entry but remember it, so Resume carries on the same entry
   (the server adds the new stretch to it; a new day starts a fresh entry).
   The mini window is a separate React root rendered from here, so it shares
   state and actions with the sidebar — no second source of truth. Any write
   anywhere fires TIME_CHANGED and everything re-reads. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import {
  timeApi, INTERNAL, ACTOR_KEY, TIME_CHANGED, liveClock, liveMinutes, hm, today, addDays,
} from '../lib/time';
import type { Boot, Entry } from '../lib/time';
import { toast } from './ui';

const PAUSED_KEY = 'df-time-paused';
const IDLE_KEY = 'df-time-idle-nudge';
const POPOUT_EVENT = 'df-time-popout';
const LONG_RUN_EVERY = 120;   // minutes between "still running?" notifications
const IDLE_EVERY = 30;        // minutes between "nothing running" nudges

const readLs = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeLs = (k: string, v: string | null) => {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignore */ }
};

/** Ask the dock to pop the mini timer out (called from a click, so the
    browser's user-gesture requirement is met synchronously). */
export const requestPopout = () => window.dispatchEvent(new Event(POPOUT_EVENT));

declare global {
  interface Window {
    documentPictureInPicture?: { requestWindow(opts: { width: number; height: number }): Promise<Window>; window: Window | null };
  }
}

interface TimerState {
  boot: Boot | null;
  memberId: number | null;
  running: Entry | null;
  paused: Entry | null;
  recent: Entry[];
}

function notify(title: string, body: string) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag: 'df-time', silent: false });
    n.onclick = () => { window.focus(); window.location.hash = 'time'; n.close(); };
  } catch { /* some browsers only allow SW notifications */ }
}

export function TimerDock() {
  const [st, setSt] = useState<TimerState>({ boot: null, memberId: null, running: null, paused: null, recent: [] });
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [idleNudge, setIdleNudge] = useState(readLs(IDLE_KEY) === '1');
  const [pip, setPip] = useState<Window | null>(null);
  const rootRef = useRef<Root | null>(null);
  const lastLongNotified = useRef(0);
  const seenRunningId = useRef<number | null>(null);
  const lastIdleNotified = useRef(Date.now());

  const load = useCallback(async () => {
    let boot: Boot;
    try { boot = await timeApi.boot(); } catch { setSt((s) => ({ ...s, boot: null })); return; }
    const active = boot.members.filter((m) => m.active);
    const stored = Number(readLs(ACTOR_KEY)) || null;
    const memberId = boot.me.member_id
      ?? (stored && active.some((m) => m.id === stored) ? stored : active[0]?.id ?? null);
    const running = boot.running.find((e) => e.member_id === memberId) ?? null;
    let recent: Entry[] = [];
    let paused: Entry | null = null;
    if (memberId) {
      try {
        const list = (await timeApi.entries(addDays(today(), -14), today())).filter((e) => e.member_id === memberId);
        const pausedId = Number(readLs(PAUSED_KEY)) || null;
        paused = !running && pausedId ? list.find((e) => e.id === pausedId && e.date === today()) ?? null : null;
        // Distinct recent tasks for one-click restarts.
        const seen = new Set<string>();
        recent = list.filter((e) => {
          const k = `${e.client_slug}|${e.category_id}|${e.description.trim().toLowerCase()}`;
          if (seen.has(k) || e.running) return false;
          seen.add(k); return true;
        }).slice(0, 4);
      } catch { /* keep going with what we have */ }
    }
    setSt({ boot, memberId, running, paused, recent });
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const on = () => { load(); };
    window.addEventListener(TIME_CHANGED, on);
    // Timers started on another device/tab show up within a minute.
    const poll = window.setInterval(load, 60000);
    return () => { window.removeEventListener(TIME_CHANGED, on); window.clearInterval(poll); };
  }, [load]);

  // Tick every second while running (clock + title); every 30s otherwise (nudges).
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), st.running ? 1000 : 30000);
    return () => window.clearInterval(t);
  }, [st.running]);

  const clientName = useCallback((slug: string | null) => {
    if (!slug) return 'Internal';
    return st.boot?.clients.find((c) => c.slug === slug)?.name ?? slug;
  }, [st.boot]);
  const catName = useCallback((id: number | null) => (id ? st.boot?.categories.find((c) => c.id === id)?.name ?? '' : ''), [st.boot]);

  /* ---- tab title ---- */
  useEffect(() => {
    const base = 'Digital Footprints · Agency HQ';
    if (st.running) document.title = `▶ ${liveClock(st.running, now)} · ${clientName(st.running.client_slug)}`;
    else if (st.paused) document.title = `⏸ Paused · ${clientName(st.paused.client_slug)}`;
    else document.title = base;
    return () => { document.title = base; };
  }, [st.running, st.paused, now, clientName]);

  /* ---- reminders ---- */
  useEffect(() => {
    if (st.running) {
      const mins = liveMinutes(st.running, now);
      const bucket = Math.floor(mins / LONG_RUN_EVERY);
      // First sight of this timer (page load, started elsewhere): start
      // counting from here rather than firing for hours already elapsed.
      if (seenRunningId.current !== st.running.id) {
        seenRunningId.current = st.running.id;
        lastLongNotified.current = bucket;
      }
      if (bucket >= 1 && bucket > lastLongNotified.current) {
        lastLongNotified.current = bucket;
        notify(`Still on ${clientName(st.running.client_slug)}?`, `Your timer has been running for ${hm(mins)}. Pause it if you've moved on.`);
      }
      lastIdleNotified.current = now;
      return;
    }
    lastLongNotified.current = 0;
    seenRunningId.current = null;
    if (!idleNudge || !st.memberId) return;
    const d = new Date(now);
    const workHours = d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() >= 9 && d.getHours() < 18;
    if (workHours && now - lastIdleNotified.current >= IDLE_EVERY * 60000) {
      lastIdleNotified.current = now;
      notify('No timer running', st.paused ? `Paused on ${clientName(st.paused.client_slug)} — resume it?` : 'Working on something? Start a timer so it gets counted.');
    }
  }, [now, st.running, st.paused, st.memberId, idleNudge, clientName]);

  /* ---- actions ---- */
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const pause = () => act(async () => {
    if (!st.running) return;
    const r = await timeApi.stop(st.memberId ?? undefined);
    writeLs(PAUSED_KEY, String(r.entry.id));
    await load();
  });
  const resume = () => act(async () => {
    if (!st.paused) return;
    writeLs(PAUSED_KEY, null);
    await timeApi.start({ resume_id: st.paused.id });
  });
  const stop = () => act(async () => {
    writeLs(PAUSED_KEY, null);
    if (st.running) {
      const r = await timeApi.stop(st.memberId ?? undefined);
      toast(`Logged ${hm(r.entry.minutes)}`);
    } else {
      await load();
    }
  });
  const startFrom = (e: Entry) => act(async () => {
    writeLs(PAUSED_KEY, null);
    await timeApi.start({
      member_id: st.memberId ?? undefined, client_slug: e.client_slug ?? INTERNAL,
      category_id: e.category_id, description: e.description, billable: e.billable,
    });
  });
  const toggleIdle = async () => {
    const next = !idleNudge;
    if (next && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    setIdleNudge(next); writeLs(IDLE_KEY, next ? '1' : '0');
    lastIdleNotified.current = Date.now();
  };

  /* ---- pop-out window ---- */
  const openPip = useCallback(async () => {
    if (pip && !pip.closed) { pip.focus(); return; }
    // Ask for notification permission on the same click — reminders need it.
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    let w: Window | null = null;
    try {
      if (window.documentPictureInPicture) {
        w = await window.documentPictureInPicture.requestWindow({ width: 320, height: 190 });
      } else {
        w = window.open('', 'df-timer', 'popup,width=340,height=230');
      }
    } catch (e) {
      toast((e as Error).message || 'Couldn’t open the mini timer');
      return;
    }
    if (!w) { toast('Pop-up blocked — allow pop-ups for this site'); return; }
    w.document.title = 'DF timer';
    w.document.head.innerHTML = '';
    // Same styles as the app (absolute URLs — the new window has no base).
    document.head.querySelectorAll('link[rel="stylesheet"], style').forEach((n) => {
      const c = n.cloneNode(true) as HTMLElement;
      if (n instanceof HTMLLinkElement) (c as HTMLLinkElement).href = n.href;
      w!.document.head.appendChild(c);
    });
    w.document.body.innerHTML = '';
    w.document.body.className = 'mini-body';
    const mount = w.document.createElement('div');
    w.document.body.appendChild(mount);
    rootRef.current = createRoot(mount);
    w.addEventListener('pagehide', () => {
      const r = rootRef.current; rootRef.current = null;
      setTimeout(() => r?.unmount(), 0);
      setPip(null);
    });
    setPip(w);
  }, [pip]);

  useEffect(() => {
    const on = () => { openPip(); };
    window.addEventListener(POPOUT_EVENT, on);
    return () => window.removeEventListener(POPOUT_EVENT, on);
  }, [openPip]);

  // Close the mini window if this page goes away (sign out, navigate off).
  useEffect(() => () => { if (pip && !pip.closed && !window.documentPictureInPicture) pip.close(); }, [pip]);

  const view = {
    st, now, busy, idleNudge, clientName, catName,
    pause, resume, stop, startFrom, toggleIdle,
    focusApp: () => { window.focus(); window.location.hash = 'time'; },
  };

  useEffect(() => {
    rootRef.current?.render(<MiniTimer {...view} />);
  });

  if (!st.boot || !st.memberId) return null;
  return <SideWidget {...view} popped={!!pip} onPop={openPip} />;
}

type View = {
  st: TimerState; now: number; busy: boolean; idleNudge: boolean;
  clientName: (s: string | null) => string; catName: (id: number | null) => string;
  pause: () => void; resume: () => void; stop: () => void; startFrom: (e: Entry) => void;
  toggleIdle: () => void; focusApp: () => void;
};

/* ---- sidebar widget ---- */
function SideWidget({ st, now, busy, clientName, pause, resume, stop, popped, onPop }: View & { popped: boolean; onPop: () => void }) {
  const e = st.running ?? st.paused;
  return (
    <div className="timerdock">
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="eyebrow" style={{ color: 'rgba(255,255,255,0.45)' }}>
          {st.running ? 'Timer running' : st.paused ? 'Paused' : 'Timer'}
        </span>
        <div style={{ flex: 1 }} />
        <button className="td-link" onClick={onPop} title="Float a mini timer above every window">{popped ? 'Popped out' : '⧉ Pop out'}</button>
      </div>
      {e ? (
        <>
          <div className="td-client">{clientName(e.client_slug)}</div>
          <div className={`td-clock ${st.running ? '' : 'paused'}`}>{liveClock(e, now)}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {st.running
              ? <button className="td-btn" disabled={busy} onClick={pause}>❚❚ Pause</button>
              : <button className="td-btn" disabled={busy} onClick={resume}>▶ Resume</button>}
            <button className="td-btn stop" disabled={busy} onClick={stop}>■ {st.running ? 'Stop' : 'Done'}</button>
          </div>
        </>
      ) : (
        <button className="td-link" style={{ marginTop: 6, padding: 0 }} onClick={() => { window.location.hash = 'time'; }}>Nothing running — start one ›</button>
      )}
    </div>
  );
}

/* ---- the floating mini window ---- */
function MiniTimer({ st, now, busy, idleNudge, clientName, catName, pause, resume, stop, startFrom, toggleIdle, focusApp }: View) {
  const e = st.running ?? st.paused;
  return (
    <div className="mini">
      {e ? (
        <>
          <div className="mini-top">
            <span className={`mini-dot ${st.running ? 'on' : ''}`} />
            <div className="mini-client" title={clientName(e.client_slug)}>{clientName(e.client_slug)}</div>
            {catName(e.category_id) && <div className="mini-cat">{catName(e.category_id)}</div>}
          </div>
          <div className="mini-desc">{e.description || 'No description'}</div>
          <div className={`mini-clock ${st.running ? '' : 'paused'}`}>{liveClock(e, now)}</div>
          <div className="mini-actions">
            {st.running
              ? <button className="mini-btn" disabled={busy} onClick={pause}>❚❚ Pause</button>
              : <button className="mini-btn go" disabled={busy} onClick={resume}>▶ Resume</button>}
            <button className="mini-btn stop" disabled={busy} onClick={stop}>■ {st.running ? 'Stop' : 'Done'}</button>
            <button className="mini-btn ghost" onClick={focusApp} title="Open Agency HQ">↗</button>
          </div>
        </>
      ) : (
        <>
          <div className="mini-top">
            <span className="mini-dot" />
            <div className="mini-client">No timer running</div>
            <button className="mini-btn ghost" onClick={focusApp} title="Open Agency HQ" style={{ marginLeft: 'auto' }}>↗</button>
          </div>
          {st.recent.length === 0
            ? <div className="mini-desc">Start a timer in Agency HQ — it’ll show up here.</div>
            : (
              <div className="mini-recent">
                {st.recent.map((r) => (
                  <button key={r.id} className="mini-rec" disabled={busy} onClick={() => startFrom(r)} title="Start a timer for this">
                    <span>▶</span>
                    <b>{clientName(r.client_slug)}</b>
                    <em>{r.description || catName(r.category_id) || '—'}</em>
                  </button>
                ))}
              </div>
            )}
        </>
      )}
      <label className="mini-foot">
        <input type="checkbox" checked={idleNudge} onChange={toggleIdle} /> Nudge me if nothing’s running (weekdays 9–6)
      </label>
    </div>
  );
}
