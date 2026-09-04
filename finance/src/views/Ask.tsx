/* Ask.tsx — interrogate the numbers in plain English. Each question goes to
   Claude with the finance brief; answers come back grounded in the imported
   figures, with the key numbers pulled out and a couple of natural follow-ups
   to keep the thread going. */
import { useRef, useState } from 'react';
import { api } from '../lib/api';
import type { AskResult } from '../lib/api';
import { Working, NeedsKey } from '../components/ui';

interface Turn { q: string; a?: AskResult; error?: string; }

const STARTERS = [
  'What changed most between the last two months?',
  'Which costs are growing fastest?',
  'How profitable were we last quarter?',
  'Where could we save money without hurting growth?',
  'What is our gross margin trend?',
];

export function Ask() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsKey, setNeedsKey] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  async function ask(question: string) {
    const query = question.trim();
    if (!query || busy) return;
    setQ('');
    setTurns((t) => [...t, { q: query }]);
    setBusy(true);
    const r = await api.ask(query);
    setBusy(false);
    setTurns((t) => {
      const copy = [...t];
      const last = copy[copy.length - 1];
      if (!r) last.error = 'The API is unreachable.';
      else if (r.needsKey) { setNeedsKey(true); last.error = 'Dave isn’t connected yet.'; }
      else if (!r.ok) last.error = r.error || 'Something went wrong.';
      else last.a = r.result;
      return copy;
    });
    setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  }

  if (needsKey && turns.every((t) => !t.a)) return <NeedsKey />;

  return (
    <>
      {turns.length === 0 && (
        <div className="card accent" style={{ marginBottom: 16 }}>
          <div className="eyebrow">Interrogate</div>
          <h3 style={{ marginBottom: 6 }}>Ask anything about your finances</h3>
          <p className="fade small" style={{ margin: '0 0 14px' }}>
            Grounded only in what you’ve imported — Dave won’t invent figures. Try one:
          </p>
          <div className="chips">
            {STARTERS.map((s) => <button key={s} className="chip" onClick={() => ask(s)}>{s}</button>)}
          </div>
        </div>
      )}

      <div className="chat" style={{ marginBottom: 16 }}>
        {turns.map((t, i) => (
          <div className="qa" key={i}>
            <div className="bub you">{t.q}</div>
            {t.a ? <Answer a={t.a} onFollow={ask} /> :
              t.error ? <div className="bub ai" style={{ color: 'var(--fail)' }}>{t.error}</div> :
                <div className="bub ai"><Working label="Reading the numbers…" /></div>}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="card" style={{ position: 'sticky', bottom: 16 }}>
        <div className="row" style={{ gap: 10 }}>
          <input className="inp" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') ask(q); }}
            placeholder="Ask about revenue, costs, margins, cash…" disabled={busy} />
          <button className="btn gold" onClick={() => ask(q)} disabled={busy || !q.trim()}>Ask</button>
        </div>
      </div>
    </>
  );
}

function Answer({ a, onFollow }: { a: AskResult; onFollow: (q: string) => void }) {
  return (
    <div className="bub ai">
      <p style={{ margin: 0, lineHeight: 1.55 }}>{a.answer}</p>
      {a.figures.length > 0 && (
        <div className="grid g3" style={{ gap: 10, marginTop: 12 }}>
          {a.figures.map((f, i) => (
            <div key={i} style={{ background: 'var(--line-soft)', borderRadius: 10, padding: '8px 12px' }}>
              <div className="fig" style={{ fontSize: 18 }}>{f.value}</div>
              <div className="small fade">{f.label}</div>
            </div>
          ))}
        </div>
      )}
      {a.followups.length > 0 && (
        <div className="chips" style={{ marginTop: 12 }}>
          {a.followups.map((f, i) => <button key={i} className="chip" onClick={() => onFollow(f)}>{f}</button>)}
        </div>
      )}
    </div>
  );
}
