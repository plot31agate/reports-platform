/* store.ts — the snapshot lives in this browser only (localStorage), plus
   JSON export/import files we keep per meeting or month. Nothing is sent
   anywhere: v1 has no network calls at all. */
import { useCallback, useEffect, useState } from 'react';
import { blankSnapshot, normalise } from './model';
import type { Snapshot } from './model';

const KEY = 'df-metabetting-crm:v1';
const CMP_KEY = 'df-metabetting-crm:compare:v1';

function read(key: string): unknown {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function write(key: string, v: unknown) {
  try { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage blocked: app still works for this session */ }
}

export function useSnapshot() {
  const [snap, setSnap] = useState<Snapshot>(() => { const r = read(KEY); return r ? normalise(r) : blankSnapshot(); });
  const [compare, setCompareState] = useState<Snapshot | null>(() => { const r = read(CMP_KEY); return r ? normalise(r) : null; });
  useEffect(() => { write(KEY, snap); }, [snap]);
  const update = useCallback((fn: (s: Snapshot) => Snapshot) => setSnap((s) => fn(structuredClone(s))), []);
  const replace = useCallback((s: Snapshot) => setSnap(s), []);
  const setCompare = useCallback((s: Snapshot | null) => { setCompareState(s); write(CMP_KEY, s); }, []);
  return { snap, update, replace, compare, setCompare };
}

export function download(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportName(s: Snapshot, suffix = 'json') {
  const client = s.meta.client.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'snapshot';
  return `${client}-crm-snapshot-${s.meta.snapshotDate || 'undated'}${s.meta.isExample ? '-EXAMPLE' : ''}.${suffix}`;
}

export function pickJSON(): Promise<Snapshot> {
  return new Promise((resolve, reject) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return reject(new Error('No file'));
      try { resolve(normalise(JSON.parse(await f.text()))); } catch { reject(new Error('That file is not a valid snapshot JSON')); }
    };
    inp.click();
  });
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove(); return ok;
  }
}
