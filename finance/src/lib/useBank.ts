/* useBank.ts — one loader for every view that reads the bank statement.
   Fetches the stored raw transactions once and enriches them through the
   registry (lib/bank.ts) so all rooms see the same classified data. */
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { LoanMeta, Space } from './api';
import { enrich } from './bank';
import type { Enriched, BizEvent, QAnswer } from './bank';

export interface BankState {
  txs: Enriched[] | null;   // null until loaded; [] means loaded-but-empty
  loanMeta: Record<string, LoanMeta>;
  spaces: Space[];
  events: BizEvent[];
  answers: Record<string, QAnswer>;
  loading: boolean;
  offline: boolean;
  refresh: () => void;
}

export function useBank(): BankState {
  const [txs, setTxs] = useState<Enriched[] | null>(null);
  const [loanMeta, setLoanMeta] = useState<Record<string, LoanMeta>>({});
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [events, setEvents] = useState<BizEvent[]>([]);
  const [answers, setAnswers] = useState<Record<string, QAnswer>>({});
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    api.bank().then((d) => {
      if (d === null) setOffline(true);
      else {
        setTxs(enrich(d.txs)); setLoanMeta(d.loanMeta ?? {});
        setSpaces(d.spaces ?? []); setEvents(d.events ?? []); setAnswers(d.answers ?? {});
      }
      setLoading(false);
    });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  return { txs, loanMeta, spaces, events, answers, loading, offline, refresh };
}
