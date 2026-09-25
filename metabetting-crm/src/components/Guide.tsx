/* Guide.tsx — the collapsible "How this page works" panel at the top of every
   room. Open by default; remembers if you collapse it (per page, per browser). */
import { useState } from 'react';
import { PAGE_GUIDES } from '../lib/guide';

const key = (page: string) => `df-metabetting-crm:guide:${page}`;
function readOpen(page: string) {
  try { return localStorage.getItem(key(page)) !== 'closed'; } catch { return true; }
}

export function Guide({ page }: { page: string }) {
  const g = PAGE_GUIDES[page];
  const [open, setOpen] = useState(() => readOpen(page));
  if (!g) return null;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(key(page), next ? 'open' : 'closed'); } catch { /* fine */ }
  };
  return (
    <div className={`guide no-print ${open ? 'open' : ''}`}>
      <button className="guide-head" onClick={toggle}>
        <span className="guide-i">?</span>
        <span className="guide-what">{g.what}</span>
        <span className="guide-toggle">{open ? 'Hide guide' : 'How this page works'}</span>
      </button>
      {open && (
        <div className="guide-body">
          <div className="guide-col">
            <div className="guide-h">Why we’re doing this</div>
            <p>{g.why}</p>
            <div className="guide-h">What you get</div>
            <p>{g.output}</p>
          </div>
          <div className="guide-col">
            <div className="guide-h">How to use it</div>
            <ol>{g.how.map((h, i) => <li key={i}>{h}</li>)}</ol>
            {g.tips && <>
              <div className="guide-h">Watch out for</div>
              <ul>{g.tips.map((t, i) => <li key={i}>{t}</li>)}</ul>
            </>}
          </div>
        </div>
      )}
    </div>
  );
}
