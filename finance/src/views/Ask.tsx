/* Ask.tsx — interrogate the numbers in plain English, as a conversation that
   REMEMBERS. The thread persists server-side (leave and come back), and Dave
   keeps a notebook — "where we're at" — of durable facts established across
   conversations. Both feed every new question, and follow-ups build on the
   thread instead of starting from zero. Starters come from the live questions
   the data is raising, not a canned list. */
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { AskNote, AskThreadItem } from '../lib/api';
import { useBank } from '../lib/useBank';
import { computeQuestions } from '../lib/bank';
import { Working, NeedsKey, OfflineNote, toast } from '../components/ui';

const STARTERS = [
  'What changed most between the last two months?',
  'Which costs are growing fastest?',
  'Where could we save money without hurting growth?',
];

export function Ask() {
  const bank = useBank();
  const [thread, setThread] = useState<AskThreadItem[]>([]);
  const [notebook, setNotebook] = useState<AskNote[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [offline, setOffline] = useState(false);
  const [pending, setPending] = useState<{ q: string; error?: string } | null>(null);
  const [q, setQ] = useState('');
  const [needsKey, setNeedsKey] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.askThread().then((d) => {
      if (d === null) setOffline(true);
      else { setThread(d.thread); setNotebook(d.notebook); }
      setLoaded(true);
    });
  }, []);

  const scrollEnd = () => setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 60);

  async function ask(question: string) {
    const query = question.trim();
    if (!query || pending) return;
    setQ('');
    setPending({ q: query });
    scrollEnd();
    const r = await api.ask(query);
    if (!r) { setPending({ q: query, error: 'The API is unreachable.' }); return; }
    if (r.needsKey) { setNeedsKey(true); setPending({ q: query, error: 'Dave isn’t connected yet.' }); return; }
    if (!r.ok || !r.result) { setPending({ q: query, error: r.error || 'Something went wrong.' }); return; }
    setPending(null);
    if (r.thread) setThread(r.thread);
    if (r.notebook) setNotebook(r.notebook);
    scrollEnd();
  }

  async function newConversation() {
    if (!confirm('Start a new conversation? The thread clears; the "where we\'re at" notes survive and still feed every question.')) return;
    const r = await api.askClear();
    if (r?.ok) { setThread([]); setPending(null); toast('New conversation — Dave still has the notebook'); }
  }

  if (needsKey && thread.length === 0) return <NeedsKey />;
  if (offline) return <OfflineNote />;
  if (!loaded) return <Working label="Picking up where we left off…" />;

  // Starters: the live questions the data is raising (minus answered ones),
  // then a few evergreens — so the first click is already a good question.
  const openQs = bank.txs && bank.txs.length > 0
    ? computeQuestions(bank.txs, { spaces: bank.spaces, events: bank.events, answers: bank.answers })
        .filter((x) => !bank.answers[x.key]).map((x) => x.q)
    : [];
  const starters = [...openQs.slice(0, 4), ...STARTERS].slice(0, 6);

  return (
    <>
      <NotebookCard notebook={notebook} onChange={setNotebook} />

      {thread.length === 0 && !pending && (
        <div className="card accent" style={{ marginBottom: 16 }}>
          <div className="eyebrow">Interrogate</div>
          <h3 style={{ marginBottom: 6 }}>Ask anything about your finances</h3>
          <p className="fade small" style={{ margin: '0 0 14px' }}>
            Grounded only in what you’ve imported — Dave won’t invent figures. The conversation is
            remembered, so each question can build on the last. Try one:
          </p>
          <div className="chips">
            {starters.map((s) => <button key={s} className="chip" onClick={() => ask(s)}>{s}</button>)}
          </div>
        </div>
      )}

      {thread.length > 0 && (
        <div className="spread" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
          <span className="small fade">
            {thread.length} question{thread.length === 1 ? '' : 's'} in this conversation — Dave
            remembers all of it.
          </span>
          <button className="linky" onClick={newConversation}>New conversation</button>
        </div>
      )}

      <div className="chat" style={{ marginBottom: 16 }}>
        {thread.map((t, i) => (
          <div className="qa" key={t.at + '-' + i}>
            <div className="bub you">{t.q}</div>
            <Answer t={t} isLast={i === thread.length - 1 && !pending} onFollow={ask} />
          </div>
        ))}
        {pending && (
          <div className="qa">
            <div className="bub you">{pending.q}</div>
            {pending.error
              ? <div className="bub ai" style={{ color: 'var(--fail)' }}>{pending.error}</div>
              : <div className="bub ai"><Working label="Reading the numbers…" /></div>}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="card" style={{ position: 'sticky', bottom: 16 }}>
        <div className="row" style={{ gap: 10 }}>
          <input className="inp" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') ask(q); }}
            placeholder={thread.length > 0 ? 'Keep going — Dave has the thread…' : 'Ask about revenue, costs, margins, cash…'}
            disabled={!!pending && !pending.error} />
          <button className="btn gold" onClick={() => ask(q)} disabled={(!!pending && !pending.error) || !q.trim()}>Ask</button>
        </div>
      </div>
    </>
  );
}

function Answer({ t, isLast, onFollow }: { t: AskThreadItem; isLast: boolean; onFollow: (q: string) => void }) {
  return (
    <div className="bub ai">
      <p style={{ margin: 0, lineHeight: 1.55 }}>{t.answer}</p>
      {t.figures.length > 0 && (
        <div className="grid g3" style={{ gap: 10, marginTop: 12 }}>
          {t.figures.map((f, i) => (
            <div key={i} style={{ background: 'var(--line-soft)', borderRadius: 10, padding: '8px 12px' }}>
              <div className="fig" style={{ fontSize: 18 }}>{f.value}</div>
              <div className="small fade">{f.label}</div>
            </div>
          ))}
        </div>
      )}
      {isLast && t.followups.length > 0 && (
        <div className="chips" style={{ marginTop: 12 }}>
          {t.followups.map((f, i) => <button key={i} className="chip" onClick={() => onFollow(f)}>{f}</button>)}
        </div>
      )}
    </div>
  );
}

/* ---- Where we're at ----
   The base Dave carries into every question: facts he filed from earlier
   answers plus anything you pin yourself. Prune it like a real notebook —
   a stale "fact" misleads every future answer. */
function NotebookCard({ notebook, onChange }: { notebook: AskNote[]; onChange: (n: AskNote[]) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

  async function add() {
    const text = draft.trim();
    if (!text) return;
    const r = await api.askNoteAdd(text);
    if (r?.ok) { onChange(r.notebook); setDraft(''); toast('Pinned — feeds every future question'); }
  }
  async function remove(id: string) {
    const r = await api.askNoteDelete(id);
    if (r?.ok) onChange(r.notebook);
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div className="eyebrow">Where we're at</div>
          <h3 style={{ fontSize: 16 }}>
            Dave's notebook{notebook.length > 0 ? ` · ${notebook.length} fact${notebook.length === 1 ? '' : 's'}` : ''}
          </h3>
        </div>
        <button className="linky" onClick={() => setOpen(!open)}>{open ? 'Hide' : notebook.length > 0 ? 'Show' : 'Pin a fact'}</button>
      </div>
      {!open && notebook.length > 0 && (
        <p className="small fade" style={{ margin: '6px 0 0' }}>
          Standing context carried into every question — latest:{' '}
          “{notebook[notebook.length - 1].text}”
        </p>
      )}
      {open && (
        <div style={{ marginTop: 10 }}>
          {notebook.length === 0 && <p className="small fade" style={{ margin: '0 0 10px' }}>
            Nothing filed yet. Dave adds durable conclusions as you interrogate the data; pin your own below.
          </p>}
          {notebook.slice().reverse().map((n) => (
            <div className="row" key={n.id} style={{ gap: 10, padding: '7px 0', borderBottom: '1px solid var(--line-soft)', alignItems: 'baseline' }}>
              <span className="small" style={{ flex: 1 }}>{n.text}</span>
              <span className="small fade" style={{ whiteSpace: 'nowrap' }}>
                {n.source === 'you' ? 'you' : 'Dave'} · {new Date(n.at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              </span>
              <button className="linky" onClick={() => remove(n.id)}>remove</button>
            </div>
          ))}
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <input className="inp" value={draft} placeholder="Pin a fact Dave should always know — e.g. Vivo confirmed paying w/c 15 Sep"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
            <button className="btn ghost sm" onClick={add} disabled={!draft.trim()}>Pin</button>
          </div>
        </div>
      )}
    </div>
  );
}
