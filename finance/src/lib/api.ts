/* api.ts — typed fetchers for Finance HQ's PHP endpoints. Everything degrades
   gracefully: if the API is unreachable (a static preview with no PHP), calls
   resolve to null and views show their offline note instead of crashing. */

/* ---- The financial model (finance.php / model.php) ---- */
export interface Line { account: string; amount: number; }
export interface PeriodTotals {
  income: number; cogs: number; grossProfit: number; opex: number;
  otherIncome: number; otherExpense: number; netProfit: number;
  grossMargin: number | null; netMargin: number | null;
}
export interface Period {
  key: string; label: string; source: string; importedAt: number;
  totals: PeriodTotals;
  income: Line[]; cogs: Line[]; opex: Line[]; otherIncome: Line[]; otherExpense: Line[];
}
export interface Balance {
  asAt: string; cash: number; debtors: number; creditors: number;
  source: string; importedAt: number;
}
export interface FinanceModel {
  ok: boolean;
  currency: string; jurisdiction: string;
  periods: Period[];
  meta: { count: number; first: string | null; last: string | null };
  latest: Period | null;
  previous: Period | null;
  balance: Balance | null;
}

/* ---- Import (import.php) ---- */
export interface ImportPLSummary {
  periods: { key: string; label: string; income: number; netProfit: number }[];
  accounts: number; unplaced: string[];
}
export interface ImportBSSummary {
  asAt: string; cash: number; debtors: number; creditors: number; found: string[];
}
export interface ImportResult {
  ok: boolean; error?: string;
  kind?: 'pl' | 'balance';
  summary?: ImportPLSummary | ImportBSSummary;
}

/* ---- Budgets (budgets.php) ---- */
export interface Layer {
  id: string; name: string; match: string; monthly: number; note: string;
  actual: number; variance: number; status: 'under' | 'near' | 'over';
}
export interface BudgetsData {
  ok: boolean; month: string; monthLabel: string;
  layers: Layer[]; accounts: string[];
  totalBudget: number; totalActual: number;
}

/* ---- AI (ask.php / forecast.php) ---- */
export interface Figure { label: string; value: string; }
export interface AskResult { answer: string; figures: Figure[]; followups: string[]; }
export interface ForecastResult { summary: string; impacts: Figure[]; risks: string[]; actions: string[]; }
export interface AiResponse<T> { ok: boolean; needsKey?: boolean; error?: string; result?: T; }

/* ---- Xero live sync (xero.php) ---- */
export interface XeroStatus {
  ok: boolean; configured: boolean; connected: boolean;
  tenantName: string | null; lastSync: number;
  lastSyncSummary: { months: number; at: number; unmapped?: string[] } | null;
}
export interface XeroSyncResult {
  ok: boolean; error?: string; tenantName?: string;
  summary?: { periods: { key: string; label: string; income: number; netProfit: number }[]; balance: ImportBSSummary | null; unmapped?: string[] };
}

/* ---- Board reports (reports.php) ---- */
export interface BoardNarrative {
  title: string; summary: string; performance: string; costs: string; cashPosition: string;
  risks: string[]; recommendations: string[]; taxNote: string; outlook: string;
}
export interface BoardReport {
  id: string; period: string; periodLabel: string; title: string; generatedAt: number;
  kpis: Record<string, unknown>; narrative: BoardNarrative;
}
export interface BoardListItem {
  id: string; period: string; periodLabel: string; title: string; generatedAt: number; shareUrl: string;
}

/* ---- Pipeline (pipeline.php) ---- */
export type Stage = 'lead' | 'qualified' | 'proposal' | 'verbal' | 'won' | 'lost';
export interface Opp {
  id: string; client: string; type: 'retainer' | 'project'; value: number;
  stage: Stage; probability: number; probabilityAuto: boolean;
  startDate: string; decisionDate: string; nextAction: string;
  includeInForecast: boolean; weighted: number; createdAt: number;
}
export interface PipelineSummary {
  mrr: number; committedMrr: number; committedProject: number; committedAnnual: number;
  weightedMrr: number; weightedProject: number; openCount: number; wonCount: number;
  byStage: Record<Stage, number>; topClient: string | null; topClientShare: number | null;
}
export interface PipelineData {
  ok: boolean; opps: Opp[]; summary: PipelineSummary;
  stageProb: Record<Stage, number>; stages: Stage[];
}

/* ---- Cash flow (cashflow.php) ---- */
export type Cadence = 'once' | 'weekly' | 'fortnightly' | '4weekly' | 'monthly' | 'quarterly';
export interface CashWeek {
  index: number; weekStart: string; label: string;
  openingCommitted: number; receipts: number; payments: number; closingCommitted: number;
  receiptsScenario: number; closingScenario: number;
}
export interface CashItem {
  id: string; label: string; category: string; client: string; amount: number;
  cadence: Cadence; date: string; until: string; note: string;
}
export interface CashHeadline {
  totalCash: number; vatSetAside: number; availableCash: number;
  runwayWeeks: number | null; runwayNote: string; endCommitted: number; endScenario: number;
}
export interface CashflowData {
  ok: boolean; weeks: CashWeek[]; headline: CashHeadline;
  settings: { totalCash: number; vatSetAside: number; usingBalanceCash: boolean };
  payments: CashItem[]; receipts: CashItem[];
  included: { id: string; client: string; value: number; type: string }[];
}

/* ---- Bank statement (bank.php) ---- */
import type { BankTx } from './bank';
export interface LoanMeta { balance: number; apr: number; note: string; }
export interface BankData {
  ok: boolean; txs: BankTx[]; importedAt: number; digest: string;
  loanMeta: Record<string, LoanMeta>;
}
export interface BankImportResult {
  ok: boolean; error?: string;
  added: number; skipped: number; total: number; hadBefore: number; txs: BankTx[];
}

const BASE = './api/';

async function get<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(BASE + path, { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
}

async function post<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const r = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
}

/** Like post(), but returns the parsed body even on error status — generation
    failures (needsKey, model errors) carry a message the UI should show. */
async function postAny<T>(path: string, body: unknown): Promise<(T & { ok: boolean; error?: string }) | null> {
  try {
    const r = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await r.json()) as T & { ok: boolean; error?: string };
  } catch { return null; }
}

export const api = {
  model: () => get<FinanceModel>('finance.php'),
  setBalance: (b: { asAt?: string; cash: number; debtors: number; creditors: number }) =>
    post<{ ok: boolean; balance: Balance }>('finance.php', { action: 'balance', ...b }),
  deletePeriod: (key: string) => post<{ ok: boolean }>('finance.php', { action: 'delete-period', key }),
  reset: () => post<{ ok: boolean }>('finance.php', { action: 'reset' }),

  import: (csv: string, kind: 'pl' | 'balance' | 'auto') =>
    postAny<ImportResult>('import.php', { csv, kind }),

  budgets: (month?: string) => get<BudgetsData>('budgets.php' + (month ? `?month=${encodeURIComponent(month)}` : '')),
  budgetAdd: (l: { name: string; match?: string; monthly?: number; note?: string }) =>
    post<{ ok: boolean; layer: Layer }>('budgets.php', { action: 'add', ...l }),
  budgetUpdate: (l: { id: string; name?: string; match?: string; monthly?: number; note?: string }) =>
    post<{ ok: boolean }>('budgets.php', { action: 'update', ...l }),
  budgetDelete: (id: string) => post<{ ok: boolean }>('budgets.php', { action: 'delete', id }),
  budgetSeed: () => post<{ ok: boolean; seeded: number }>('budgets.php', { action: 'seed' }),

  ask: (question: string) => postAny<AiResponse<AskResult>>('ask.php', { question }),
  forecast: (scenario: string, changes?: Record<string, string | number>) =>
    postAny<AiResponse<ForecastResult>>('forecast.php', { scenario, changes }),

  // Xero live sync
  xeroStatus: () => get<XeroStatus>('xero.php?action=status'),
  /** The URL to navigate the top window to — it 302s to Xero's consent screen. */
  xeroConnectUrl: () => `${BASE}xero.php?action=connect`,
  xeroSync: () => postAny<XeroSyncResult>('xero.php', { action: 'sync' }),
  xeroDisconnect: () => post<{ ok: boolean }>('xero.php', { action: 'disconnect' }),

  // Pipeline
  pipeline: () => get<PipelineData>('pipeline.php'),
  pipelineAdd: (o: Partial<Opp>) => post<{ ok: boolean; opp: Opp }>('pipeline.php', { action: 'add', ...o }),
  pipelineUpdate: (o: Partial<Opp> & { id: string }) => post<{ ok: boolean; opp: Opp }>('pipeline.php', { action: 'update', ...o }),
  pipelineDelete: (id: string) => post<{ ok: boolean }>('pipeline.php', { action: 'delete', id }),
  pipelineSeed: () => post<{ ok: boolean; seeded: number }>('pipeline.php', { action: 'seed' }),

  // Cash flow (mutations return the full recomputed forecast)
  cashflow: () => get<CashflowData>('cashflow.php'),
  cashflowSettings: (s: { totalCash?: number | string; vatSetAside?: number | string }) =>
    post<CashflowData>('cashflow.php', { action: 'settings', ...s }),
  cashflowAdd: (kind: 'payment' | 'receipt', it: Partial<CashItem>) =>
    post<CashflowData>('cashflow.php', { action: 'add', kind, ...it }),
  cashflowUpdate: (kind: 'payment' | 'receipt', it: Partial<CashItem> & { id: string }) =>
    post<CashflowData>('cashflow.php', { action: 'update', kind, ...it }),
  cashflowDelete: (kind: 'payment' | 'receipt', id: string) =>
    post<CashflowData>('cashflow.php', { action: 'delete', kind, id }),

  // Bank statement
  bank: () => get<BankData>('bank.php'),
  bankImport: (txs: BankTx[]) => postAny<BankImportResult>('bank.php', { action: 'import', txs }),
  bankDigest: (digest: string) => post<{ ok: boolean }>('bank.php', { action: 'digest', digest }),
  bankLoans: (loanMeta: Record<string, LoanMeta>) =>
    post<{ ok: boolean; loanMeta: Record<string, LoanMeta> }>('bank.php', { action: 'loans', loanMeta }),
  bankReset: () => post<{ ok: boolean }>('bank.php', { action: 'reset' }),

  // Board reports
  reports: () => get<{ ok: boolean; reports: BoardListItem[] }>('reports.php'),
  report: (id: string) => get<{ ok: boolean; report: BoardReport; shareUrl: string }>(`reports.php?id=${encodeURIComponent(id)}`),
  reportGenerate: (month: string) =>
    postAny<AiResponse<BoardReport> & { report?: BoardReport; shareUrl?: string }>('reports.php', { action: 'generate', month }),
  reportDelete: (id: string) => post<{ ok: boolean }>('reports.php', { action: 'delete', id }),
};
