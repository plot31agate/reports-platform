/* bank.ts — the bank-statement engine. Parses a Starling CSV, then enriches
   every transaction through the business registry below: which counterparty is
   a client, which is a loan, which is HMRC, who is payroll. All the analytics
   the Money in / Spending / Debt views show are computed here, client-side,
   from the raw stored transactions — so the rules can improve without ever
   re-importing a statement.

   Registry facts worth knowing (from the business, not guessable from data):
   - "Lemino Payments" is the client Vivo — real work, unreliable payment cadence.
   - Capital On Tap is a revolving credit facility, NOT a client: credits are
     drawdowns, debits are repayments. Excluded from revenue entirely.
   - NCFF2-AFL Collections and Funding Circle are loan repayments. */

/* ---------- Types ---------- */

export interface BankTx {
  date: string;          // YYYY-MM-DD
  cp: string;            // counterparty as exported
  ref: string;
  type: string;          // FASTER PAYMENT / DIRECT DEBIT / CARD SUBSCRIPTION / …
  amount: number;        // +credit / -debit
  balance: number;       // running balance after this tx
  category: string;      // Starling's spending category
}

export type EntityKind = 'client' | 'loan' | 'tax' | 'payroll' | 'director' | 'related' | 'supplier';

export interface Enriched extends BankTx {
  entity: string;        // canonical display name (merges spelling variants)
  kind: EntityKind;
  group: string;         // analytic spend group (or 'Revenue')
}

/* ---------- Starling CSV parsing ---------- */

/** RFC-ish CSV line split that survives quoted fields with commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export function looksLikeStarling(text: string): boolean {
  const head = text.slice(0, 300).toLowerCase();
  return head.includes('counter party') && head.includes('amount (gbp)') && head.includes('spending category');
}

/** Parse a Starling statement export. Throws with a readable message on a
    file that isn't one. */
export function parseStarlingCsv(text: string): BankTx[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error('The file looks empty.');
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.findIndex((h) => h === name);
  const iDate = col('date'), iCp = col('counter party'), iRef = col('reference'),
    iType = col('type'), iAmt = col('amount (gbp)'), iBal = col('balance (gbp)'),
    iCat = col('spending category');
  if (iDate < 0 || iCp < 0 || iAmt < 0) {
    throw new Error('This doesn’t look like a Starling statement — expected columns like "Date", "Counter Party", "Amount (GBP)".');
  }
  const txs: BankTx[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    const dm = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((f[iDate] ?? '').trim());
    if (!dm) continue; // footer / stray line
    const amount = Number((f[iAmt] ?? '').replace(/[^0-9.-]/g, ''));
    if (!isFinite(amount)) continue;
    txs.push({
      date: `${dm[3]}-${dm[2]}-${dm[1]}`,
      cp: (f[iCp] ?? '').trim(),
      ref: (f[iRef] ?? '').trim(),
      type: (f[iType] ?? '').trim(),
      amount,
      balance: Number((f[iBal] ?? '').replace(/[^0-9.-]/g, '')) || 0,
      category: (f[iCat] ?? '').trim(),
    });
  }
  if (txs.length === 0) throw new Error('No transaction rows found in the file.');
  txs.sort((a, b) => a.date.localeCompare(b.date));
  return txs;
}

/* ---------- The business registry ---------- */

interface Rule { match: RegExp; entity: string; kind: EntityKind; group?: string; }

/** Ordered: first match wins. Patterns run against the folded counterparty. */
const RULES: Rule[] = [
  // Debt — these are the facilities, in either direction.
  { match: /capital on tap/, entity: 'Capital On Tap (credit facility)', kind: 'loan', group: 'Debt service' },
  { match: /funding circle/, entity: 'Funding Circle', kind: 'loan', group: 'Debt service' },
  { match: /ncff2|afl collections/, entity: 'NCFF2 / AFL Collections', kind: 'loan', group: 'Debt service' },

  // Tax
  { match: /hmrc/, entity: 'HMRC', kind: 'tax', group: 'Tax & HMRC' },

  // Directors & payroll
  { match: /^steven lee$/, entity: 'Steven Lee (director)', kind: 'director', group: 'People' },
  { match: /^sharon sim$/, entity: 'Sharon Sim (director)', kind: 'director', group: 'People' },
  { match: /roberto facchini/, entity: 'Roberto Facchini', kind: 'payroll', group: 'People' },
  { match: /sandy robertson/, entity: 'Sandy Robertson', kind: 'payroll', group: 'People' },
  { match: /iona louise dolan|^iona /, entity: 'Iona Dolan', kind: 'payroll', group: 'People' },
  { match: /standard life/, entity: 'Standard Life (pension)', kind: 'payroll', group: 'People' },

  // Related / unclear counterparties kept out of client revenue
  { match: /tamacre/, entity: 'Tamacre Limited', kind: 'related', group: 'Other' },

  // Named clients whose statement spellings vary
  { match: /lemino/, entity: 'Vivo (Lemino Payments)', kind: 'client' },
  { match: /mindway/, entity: 'Mindway AI', kind: 'client' },
  { match: /epg business/, entity: 'EPG Business', kind: 'client' },
  { match: /scottish footb/, entity: 'Scottish Football', kind: 'client' },
  { match: /grace media/, entity: 'Grace Media', kind: 'client' },
  { match: /activewin/, entity: 'ActiveWin Marketing', kind: 'client' },
  { match: /cbs global/, entity: 'CBS Global Marketing', kind: 'client' },
  { match: /judoscotland/, entity: 'JudoScotland', kind: 'client' },
  { match: /money ready/, entity: 'Money Ready', kind: 'client' },
  { match: /rdentify/, entity: 'Rdentify', kind: 'client' },
  { match: /ocere/, entity: 'Ocere', kind: 'client' },
  { match: /ail resources/, entity: 'AIL Resources', kind: 'client' },
  { match: /utilities maintena/, entity: 'Utilities Maintenance Services', kind: 'client' },
  { match: /fd intelligence/, entity: 'FD Intelligence', kind: 'client' },

  // Suppliers whose Starling category misleads (123 Reg is hosting, not "workplace")
  { match: /123.?reg/, entity: '123 Reg', kind: 'supplier', group: 'Software & admin' },
  { match: /mcintyre property/, entity: 'McIntyre Property (rent)', kind: 'supplier', group: 'Premises & utilities' },
  { match: /totalenergies/, entity: 'TotalEnergies', kind: 'supplier', group: 'Premises & utilities' },
  { match: /clear business/, entity: 'Clear Business', kind: 'supplier', group: 'Premises & utilities' },
  { match: /^bt$/, entity: 'BT', kind: 'supplier', group: 'Phones & internet' },
  { match: /^ee$/, entity: 'EE', kind: 'supplier', group: 'Phones & internet' },
  { match: /^o2$/, entity: 'O2', kind: 'supplier', group: 'Phones & internet' },
  { match: /hiscox/, entity: 'Hiscox (insurance)', kind: 'supplier', group: 'Professional & insurance' },
  { match: /grants scotland/, entity: 'Grants Scotland (accountants)', kind: 'supplier', group: 'Professional & insurance' },
  { match: /cash machine/, entity: 'Cash withdrawals', kind: 'supplier', group: 'Other' },
  { match: /tubebuddy/, entity: 'TubeBuddy', kind: 'supplier', group: 'Software & admin' },
];

/** Lowercase, collapse whitespace/punctuation so spelling variants merge. */
function fold(cp: string): string {
  return cp.toLowerCase().replace(/[().*,]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Title-case a shouty bank counterparty for display. */
function tidyName(cp: string): string {
  const cleaned = cp.replace(/\s+/g, ' ').trim();
  if (cleaned !== cleaned.toUpperCase()) return cleaned; // already mixed case
  return cleaned.toLowerCase().replace(/(^|[\s\-/])([a-z])/g, (_m, p, c) => p + c.toUpperCase());
}

const CATEGORY_GROUP: Record<string, string> = {
  STAFF: 'People', DIRECTORS_WAGES: 'People', PAYE_AND_NI: 'People',
  LOAN_PRINCIPAL: 'Debt service',
  VAT: 'Tax & HMRC', IMPORT_VAT: 'Tax & HMRC',
  WORKPLACE: 'Premises & utilities', OFFICE_AND_POSTAGE_COSTS: 'Premises & utilities', UTILITIES: 'Premises & utilities',
  ADMIN: 'Software & admin', SOFTWARE_AND_SUBSCRIPTIONS: 'Software & admin',
  PHONE_AND_INTERNET: 'Phones & internet',
  EQUIPMENT: 'Equipment',
  MARKETING: 'Marketing',
  TRAVEL: 'Travel & entertaining', FOOD_AND_DRINK: 'Travel & entertaining',
  BUSINESS_ENTERTAINMENT: 'Travel & entertaining', EMPLOYEE_ENTERTAINING: 'Travel & entertaining',
  PROFESSIONAL_SERVICES: 'Professional & insurance', ACCOUNTANCY_FEES: 'Professional & insurance',
  CHARITABLE_DONATIONS: 'Other',
};

export function enrich(txs: BankTx[]): Enriched[] {
  return txs.map((t) => {
    const f = fold(t.cp);
    const rule = RULES.find((r) => r.match.test(f));
    if (rule) {
      const group = t.amount > 0 && rule.kind === 'client' ? 'Revenue'
        : rule.group ?? CATEGORY_GROUP[t.category] ?? 'Other';
      return { ...t, entity: rule.entity, kind: rule.kind, group };
    }
    // Unmatched: credits are treated as client revenue (that's what an agency's
    // inbound faster payments are); debits fall through the category map.
    if (t.amount > 0) return { ...t, entity: tidyName(t.cp), kind: 'client', group: 'Revenue' };
    return { ...t, entity: tidyName(t.cp), kind: 'supplier', group: CATEGORY_GROUP[t.category] ?? 'Other' };
  });
}

/* ---------- Aggregations ---------- */

export interface MonthlyFlow { key: string; in: number; out: number; net: number; }

/** Month buckets. `revenueOnly` in = client revenue only (loan drawdowns,
    director top-ups and refunds excluded); out = everything paid away. */
export function monthlyFlows(txs: Enriched[]): MonthlyFlow[] {
  const map = new Map<string, MonthlyFlow>();
  for (const t of txs) {
    const key = t.date.slice(0, 7);
    let m = map.get(key);
    if (!m) { m = { key, in: 0, out: 0, net: 0 }; map.set(key, m); }
    if (t.amount > 0) { if (t.group === 'Revenue') m.in += t.amount; }
    else m.out += -t.amount;
  }
  const out = [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const m of out) m.net = m.in - m.out;
  return out;
}

export interface ClientRow {
  entity: string;
  total: number;
  payments: number;
  months: Record<string, number>;   // YYYY-MM -> amount
  medianMonthly: number;            // typical month WHERE they paid
  lastPaid: string;                 // YYYY-MM-DD
  daysSince: number;                // vs the statement's asOf date
  cadence: 'monthly' | 'irregular' | 'one-off';
  status: 'ontrack' | 'late' | 'quiet' | 'oneoff';
}

function median(ns: number[]): number {
  if (ns.length === 0) return 0;
  const s = [...ns].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

export function clientRows(txs: Enriched[]): { rows: ClientRow[]; asOf: string } {
  const asOf = txs.length ? txs[txs.length - 1].date : new Date().toISOString().slice(0, 10);
  const byClient = new Map<string, Enriched[]>();
  for (const t of txs) {
    if (t.kind !== 'client' || t.amount <= 0) continue;
    const arr = byClient.get(t.entity) ?? [];
    arr.push(t); byClient.set(t.entity, arr);
  }
  const rows: ClientRow[] = [];
  for (const [entity, list] of byClient) {
    const months: Record<string, number> = {};
    for (const t of list) months[t.date.slice(0, 7)] = (months[t.date.slice(0, 7)] ?? 0) + t.amount;
    const dates = list.map((t) => t.date);
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));
    const typicalGap = gaps.length >= 2 ? median(gaps.filter((g) => g > 2)) || 30 : 30;
    const lastPaid = dates[dates.length - 1];
    const daysSince = daysBetween(lastPaid, asOf);
    const monthCount = Object.keys(months).length;
    const cadence: ClientRow['cadence'] =
      list.length <= 1 ? 'one-off' : monthCount >= 3 && typicalGap <= 45 ? 'monthly' : 'irregular';
    const status: ClientRow['status'] =
      cadence === 'one-off' ? 'oneoff'
        : daysSince > Math.max(70, typicalGap * 2.5) ? 'quiet'
        : daysSince > Math.max(38, typicalGap * 1.6) ? 'late'
        : 'ontrack';
    rows.push({
      entity, total: list.reduce((s, t) => s + t.amount, 0), payments: list.length,
      months, medianMonthly: median(Object.values(months)), lastPaid, daysSince, cadence, status,
    });
  }
  rows.sort((a, b) => b.total - a.total);
  return { rows, asOf };
}

export interface GroupRow { group: string; total: number; monthly: Record<string, number>; }

export function spendGroups(txs: Enriched[]): GroupRow[] {
  const map = new Map<string, GroupRow>();
  for (const t of txs) {
    if (t.amount >= 0) continue;
    let g = map.get(t.group);
    if (!g) { g = { group: t.group, total: 0, monthly: {} }; map.set(t.group, g); }
    g.total += -t.amount;
    const key = t.date.slice(0, 7);
    g.monthly[key] = (g.monthly[key] ?? 0) + -t.amount;
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

export interface SupplierRow { entity: string; group: string; total: number; payments: number; lastSeen: string; }

export function topSuppliers(txs: Enriched[], limit = 20): SupplierRow[] {
  const map = new Map<string, SupplierRow>();
  for (const t of txs) {
    if (t.amount >= 0 || t.kind === 'client') continue;
    let s = map.get(t.entity);
    if (!s) { s = { entity: t.entity, group: t.group, total: 0, payments: 0, lastSeen: t.date }; map.set(t.entity, s); }
    s.total += -t.amount; s.payments++; if (t.date > s.lastSeen) s.lastSeen = t.date;
  }
  return [...map.values()].sort((a, b) => b.total - a.total).slice(0, limit);
}

export interface SubRow {
  entity: string; charges: number; total: number; avgMonthly: number; lastSeen: string;
  /** Estimated ex-VAT monthly cost: UK-billing suppliers assumed to include
      20% VAT (reclaimable if VAT-registered); overseas reverse-charge
      suppliers already bill without UK VAT. An estimate, not an invoice. */
  exVatMonthly: number;
  ukVat: boolean;
  action: string;
}

/** Overseas SaaS that bills under reverse charge — no UK VAT in the price. */
const NO_UK_VAT = /anthropic|ahrefs|cloud linux|zapier|riversidefm|tubebuddy|fastspring|freemius|trustindex|twilio|amazon web services|google|soho66|speedydot/i;
export function billsUkVat(entity: string): boolean { return !NO_UK_VAT.test(entity); }

/** Recurring subscriptions: card-subscription charges plus any supplier hit in
    3+ distinct months with a steady small ticket. */
export function subscriptions(txs: Enriched[]): { rows: SubRow[]; monthlyTotal: number; exVatMonthlyTotal: number } {
  const cand = new Map<string, Enriched[]>();
  for (const t of txs) {
    if (t.amount >= 0) continue;
    const isCardSub = t.type.toUpperCase() === 'CARD SUBSCRIPTION';
    if (!isCardSub && t.group !== 'Software & admin') continue;
    const arr = cand.get(t.entity) ?? []; arr.push(t); cand.set(t.entity, arr);
  }
  const monthSpan = new Set(txs.map((t) => t.date.slice(0, 7))).size || 1;
  const rows: SubRow[] = [];
  for (const [entity, list] of cand) {
    const monthsHit = new Set(list.map((t) => t.date.slice(0, 7))).size;
    const isCardSub = list.some((t) => t.type.toUpperCase() === 'CARD SUBSCRIPTION');
    if (!isCardSub && monthsHit < 3) continue;
    const total = list.reduce((s, t) => s + -t.amount, 0);
    const charges = list.length;
    const avgMonthly = total / monthSpan;
    const ukVat = billsUkVat(entity);
    const usageBased = /anthropic|amazon web services|twilio|google|apple app store/i.test(entity);
    const action =
      usageBased
        ? 'Usage-based billing — set a monthly budget cap with the provider'
        : charges >= monthSpan * 1.5 && charges >= 10
        ? `Consolidate — ${charges} separate charges this year; audit for duplicate renewals`
        : charges <= 2 && total >= 100
          ? 'Annual renewal — cancel auto-renew now unless it earned its keep'
          : avgMonthly < 15
            ? 'Small & steady — kill it if nobody used it this month'
            : 'Assign an owner; confirm it earns its keep';
    rows.push({
      entity, charges, total, avgMonthly,
      exVatMonthly: ukVat ? avgMonthly / 1.2 : avgMonthly,
      ukVat, action,
      lastSeen: list[list.length - 1].date,
    });
  }
  rows.sort((a, b) => b.total - a.total);
  return {
    rows,
    monthlyTotal: rows.reduce((s, r) => s + r.avgMonthly, 0),
    exVatMonthlyTotal: rows.reduce((s, r) => s + r.exVatMonthly, 0),
  };
}

/** Concrete next steps from the subscription audit — the point of the list. */
export function subscriptionNextSteps(rows: SubRow[]): string[] {
  const fm = (n: number) => '£' + Math.round(Math.abs(n)).toLocaleString('en-GB');
  const steps: string[] = [];
  const heavy = rows.filter((r) => r.charges >= 15 && !/usage-based/i.test(r.action));
  for (const h of heavy.slice(0, 2)) {
    steps.push(`Audit ${h.entity}: ${h.charges} separate charges, ${fm(h.total)} this year. List every renewal it covers and cancel the dead ones — trimming a third of it is ~${fm(h.total / 3)} back.`);
  }
  const annuals = rows.filter((r) => r.charges <= 2 && r.total >= 100);
  if (annuals.length > 0) {
    steps.push(`Cancel auto-renew today on the annuals you're not actively using: ${annuals.map((a) => `${a.entity} (${fm(a.total)})`).join(', ')}. Deciding at renewal time never happens.`);
  }
  const design = rows.filter((r) => /adobe|canva|istock/i.test(r.entity));
  if (design.length >= 2) {
    steps.push(`Design overlap: ${design.map((d) => d.entity).join(' + ')}. Standardise on one — ~${fm(design.slice(1).reduce((s, d) => s + d.total, 0))} /year back.`);
  }
  const small = rows.filter((r) => r.avgMonthly < 15);
  if (small.length >= 4) {
    steps.push(`15-minute kill list: ${small.length} services under £15/month (${fm(small.reduce((s, r) => s + r.avgMonthly, 0))}/month combined). Cancel anything without a named user.`);
  }
  return steps.slice(0, 4);
}

export interface LoanRow {
  entity: string;
  paidTotal: number;         // repayments YTD (positive number)
  drawnTotal: number;        // credits received (Capital On Tap drawdowns)
  monthly: Record<string, number>;
  recentMonthly: number;     // avg of last 3 complete months of repayments
  lastPayment: string;
}

export function loans(txs: Enriched[]): LoanRow[] {
  const map = new Map<string, LoanRow>();
  for (const t of txs) {
    if (t.kind !== 'loan') continue;
    let l = map.get(t.entity);
    if (!l) { l = { entity: t.entity, paidTotal: 0, drawnTotal: 0, monthly: {}, recentMonthly: 0, lastPayment: '' }; map.set(t.entity, l); }
    if (t.amount < 0) {
      l.paidTotal += -t.amount;
      const key = t.date.slice(0, 7);
      l.monthly[key] = (l.monthly[key] ?? 0) + -t.amount;
      if (t.date > l.lastPayment) l.lastPayment = t.date;
    } else l.drawnTotal += t.amount;
  }
  const asOfMonth = txs.length ? txs[txs.length - 1].date.slice(0, 7) : '';
  for (const l of map.values()) {
    const complete = Object.keys(l.monthly).filter((k) => k !== asOfMonth).sort().slice(-3);
    l.recentMonthly = complete.length ? complete.reduce((s, k) => s + l.monthly[k], 0) / complete.length : 0;
  }
  return [...map.values()].sort((a, b) => b.paidTotal - a.paidTotal);
}

/* ---------- Spaces & events (owner-entered context) ----------
   Starling Spaces don't export statements, so ring-fenced money is entered by
   hand; events (conferences etc.) are planned spend the statement can't see
   until after the trip. Both feed the questions and the Ask digest. */

export interface SpaceLite { name: string; kind: string; balance: number; }

export interface EventItem { label: string; amount: number; }
export interface BizEvent {
  id: string;
  name: string;
  location: string;
  start: string;             // YYYY-MM-DD
  end: string;
  client: string;            // who part-funds it, if anyone
  clientContribution: number;
  items: EventItem[];
}

export function eventGross(e: BizEvent): number {
  return e.items.reduce((s, i) => s + (i.amount || 0), 0);
}
export function eventNet(e: BizEvent): number {
  return eventGross(e) - (e.clientContribution || 0);
}

/** Actual spend matched from the statement: travel/entertaining + marketing
    debits from a week before the event through a week after. */
export function eventActuals(txs: Enriched[], e: BizEvent): number {
  if (!e.start || !e.end) return 0;
  const from = new Date(e.start); from.setDate(from.getDate() - 7);
  const to = new Date(e.end); to.setDate(to.getDate() + 7);
  const f = from.toISOString().slice(0, 10), t = to.toISOString().slice(0, 10);
  return txs
    .filter((x) => x.amount < 0 && x.date >= f && x.date <= t
      && (x.group === 'Travel & entertaining' || x.group === 'Marketing'))
    .reduce((s, x) => s + -x.amount, 0);
}

/** An owner's filed answer to a raised question — the decision log. */
export interface QAnswer { question: string; answer: string; savedAt: number; }

export interface BankExtras {
  spaces?: SpaceLite[];
  events?: BizEvent[];
  answers?: Record<string, QAnswer>;
}

/* ---------- The question engine ----------
   Deterministic prompts for the owner: each one is a real question the data
   raises this week, with the figures that raise it. These also feed the Ask
   digest so Claude starts from the same place. */

/** `key` is stable across recomputes so a filed answer sticks to its question. */
export interface Question { key: string; q: string; why: string; tone: 'bad' | 'warn' | 'flat'; }

export function computeQuestions(txs: Enriched[], extras?: BankExtras): Question[] {
  if (txs.length === 0) return [];
  const out: Question[] = [];
  const flows = monthlyFlows(txs);
  const asOf = txs[txs.length - 1].date;
  const asOfMonth = asOf.slice(0, 7);
  const complete = flows.filter((f) => f.key !== asOfMonth);
  const recent = complete.slice(-3);
  const avgNet = recent.length ? recent.reduce((s, f) => s + f.net, 0) / recent.length : 0;
  const avgOut = recent.length ? recent.reduce((s, f) => s + f.out, 0) / recent.length : 0;
  const cash = txs[txs.length - 1].balance;
  const fm = (n: number) => '£' + Math.round(Math.abs(n)).toLocaleString('en-GB');

  // 1. Clients gone quiet
  const { rows } = clientRows(txs);
  for (const r of rows.filter((r) => (r.status === 'quiet' || r.status === 'late') && r.medianMonthly >= 300).slice(0, 3)) {
    out.push({
      key: `quiet:${r.entity}`,
      q: `Is ${r.entity} still active — and what's outstanding?`,
      why: `They've paid ${fm(r.total)} this year (typically ${fm(r.medianMonthly)}/month) but nothing for ${r.daysSince} days. If invoices are out, chase them; if the work stopped, the run-rate needs reforecasting.`,
      tone: r.status === 'quiet' ? 'bad' : 'warn',
    });
  }

  // 2. Debt service
  const ls = loans(txs);
  const debtMonthly = ls.reduce((s, l) => s + l.recentMonthly, 0);
  if (debtMonthly > 500) {
    const share = avgOut > 0 ? Math.round((debtMonthly / avgOut) * 100) : 0;
    out.push({
      key: 'debt-service',
      q: `Debt service is ${fm(debtMonthly)}/month (${share}% of spending) — what's the payoff date on each facility?`,
      why: ls.map((l) => `${l.entity}: ${fm(l.paidTotal)} paid this year${l.drawnTotal > 0 ? `, ${fm(l.drawnTotal)} drawn` : ''}`).join(' · ')
        + '. Add each balance in Debt & loans to see clearance dates and what an overpayment buys.',
      tone: 'warn',
    });
  }

  // 3. Payroll changes: a regular salary that stopped
  const salaryByPerson = new Map<string, string[]>(); // entity -> months paid
  for (const t of txs) {
    if (t.kind !== 'payroll' || t.amount >= 0 || !/salary/i.test(t.ref)) continue;
    const arr = salaryByPerson.get(t.entity) ?? [];
    const m = t.date.slice(0, 7);
    if (!arr.includes(m)) arr.push(m);
    salaryByPerson.set(t.entity, arr);
  }
  const prevMonth = complete.length ? complete[complete.length - 1].key : asOfMonth;
  for (const [who, months] of salaryByPerson) {
    const last = months[months.length - 1];
    if (months.length >= 3 && last < prevMonth) {
      out.push({
        key: `payroll:${who}`,
        q: `${who}'s salary stopped after ${last} — is the role being replaced, and at what cost?`,
        why: `A like-for-like hire lands around the same net monthly plus employer NI and pension. Your recent average surplus is ${fm(avgNet)}/month${avgNet < 0 ? ' NEGATIVE' : ''} — decide whether the hire is funded by growth, or by paying down less debt.`,
        tone: 'warn',
      });
    }
  }

  // 4. Concentration
  if (rows.length > 0) {
    const totalRev = rows.reduce((s, r) => s + r.total, 0);
    const top = rows[0];
    const topShare = Math.round((top.total / Math.max(1, totalRev)) * 100);
    if (topShare >= 15) {
      out.push({
        key: `concentration:${top.entity}`,
        q: `${top.entity} is ${topShare}% of this year's revenue — what happens to the month if they pause?`,
        why: `${fm(top.total)} of ${fm(totalRev)} client income. Anything above ~20% from one client deserves a named backup plan in Pipeline.`,
        tone: topShare >= 25 ? 'warn' : 'flat',
      });
    }
  }

  // 5. Subscription creep
  const subs = subscriptions(txs);
  if (subs.monthlyTotal > 300) {
    const top = subs.rows[0];
    out.push({
      key: 'subscriptions',
      q: `Subscriptions are running at ${fm(subs.monthlyTotal)}/month across ${subs.rows.length} services — which three can go?`,
      why: `Biggest is ${top.entity} at ${fm(top.total)} this year over ${top.charges} charges. The Spending room lists them all with last-charged dates.`,
      tone: 'flat',
    });
  }

  // 6. HMRC standing arrangement
  const hmrcDd = txs.filter((t) => t.kind === 'tax' && t.type === 'DIRECT DEBIT' && t.amount < 0);
  if (hmrcDd.length >= 4) {
    const total = hmrcDd.reduce((s, t) => s + -t.amount, 0);
    out.push({
      key: 'hmrc-dd',
      q: `A standing HMRC direct debit has taken ${fm(total)} this year — exactly which liability is it clearing, and when does it end?`,
      why: 'Worth confirming with the accountant what it covers (VAT, PAYE or an arrangement) and the remaining balance — it changes the true monthly cost base.',
      tone: 'flat',
    });
  }

  // 6b. Upcoming events: planned spend the statement can't see yet
  for (const e of extras?.events ?? []) {
    if (!e.start) continue;
    const days = Math.round((new Date(e.start).getTime() - new Date(asOf).getTime()) / 86400000);
    if (days < -7 || days > 60) continue;
    const gross = eventGross(e), net = eventNet(e);
    if (days >= 0) {
      out.push({
        key: `event:${e.id}`,
        q: `${e.name}${e.location ? ` (${e.location})` : ''} starts in ${days} day${days === 1 ? '' : 's'} — is everything booked, and is the ${fm(net)} net cost in the cash plan?`,
        why: `Budgeted ${fm(gross)}${e.clientContribution > 0 ? `, ${e.client || 'the client'} covers ${fm(e.clientContribution)}, net ${fm(net)}` : ''}. Flights and hotels only get dearer — book what's unbooked, and push the items into the 13-week cash flow from the Spending room.`,
        tone: days <= 21 ? 'warn' : 'flat',
      });
    } else {
      const actual = eventActuals(txs, e);
      out.push({
        key: `event-past:${e.id}`,
        q: `${e.name} has happened — did it come in on budget, and has ${e.client || 'the client'} been invoiced for their share?`,
        why: `Budgeted ${fm(gross)}; travel & marketing spend around the dates shows ${fm(actual)} so far.${e.clientContribution > 0 ? ` The ${fm(e.clientContribution)} contribution should be on an invoice now.` : ''}`,
        tone: 'flat',
      });
    }
  }

  // 6c. VAT set-aside vs the last VAT bill
  const vatSpaces = (extras?.spaces ?? []).filter((s) => s.kind === 'vat');
  if (vatSpaces.length > 0) {
    const held = vatSpaces.reduce((s, x) => s + x.balance, 0);
    const vatPaid = txs.filter((t) => t.kind === 'tax' && t.amount < 0 && /vat/i.test(t.cp + ' ' + t.category));
    const lastVat = vatPaid.length ? Math.max(...vatPaid.map((t) => -t.amount)) : 0;
    if (lastVat > 0 && held < lastVat * 0.9) {
      out.push({
        key: 'vat-space',
        q: `The VAT space holds ${fm(held)} but the last VAT bill was ${fm(lastVat)} — is this quarter accruing into it?`,
        why: 'Ring-fencing a slice of every invoice as it lands is the habit that makes quarter-end a non-event. Update the space balance here whenever you top it up.',
        tone: 'warn',
      });
    }
  }

  // 7. Cash cushion
  if (avgOut > 0) {
    const cover = cash / avgOut;
    if (cover < 1.5) {
      out.push({
        key: 'cash-cover',
        q: `Cash covers ${cover.toFixed(1)} months of spending — what's the floor you're comfortable with?`,
        why: `${fm(cash)} in the bank against ${fm(avgOut)}/month going out. A common working floor for an agency is 2–3 months of costs.`,
        tone: cover < 1 ? 'bad' : 'warn',
      });
    }
  }

  return out;
}

/* ---------- The Ask digest ----------
   A compact plain-text brief of the bank picture, stored server-side so
   ask.php can ground Claude in it alongside the Xero figures. */

export function buildDigest(txs: Enriched[], extras?: BankExtras): string {
  if (txs.length === 0) return '';
  const fm = (n: number) => '£' + Math.round(Math.abs(n)).toLocaleString('en-GB');
  const flows = monthlyFlows(txs);
  const { rows, asOf } = clientRows(txs);
  const groups = spendGroups(txs);
  const ls = loans(txs);
  const subs = subscriptions(txs);
  const lines: string[] = [];
  lines.push(`BANK ACCOUNT (Starling), ${txs[0].date} to ${asOf}. Balance now ${fm(txs[txs.length - 1].balance)}.`);
  lines.push('Monthly client revenue in / total out / net: ' + flows.map((f) => `${f.key}: ${fm(f.in)}/${fm(f.out)}/${f.net < 0 ? '-' : ''}${fm(f.net)}`).join('; '));
  lines.push('Top clients (paid this year, typical month, last paid, status): ' + rows.slice(0, 10)
    .map((r) => `${r.entity} ${fm(r.total)} (${fm(r.medianMonthly)}/mo, last ${r.lastPaid}, ${r.status})`).join('; '));
  lines.push('Spending by group: ' + groups.map((g) => `${g.group} ${fm(g.total)}`).join('; '));
  lines.push('Loans: ' + (ls.length ? ls.map((l) => `${l.entity} paid ${fm(l.paidTotal)}${l.drawnTotal ? `, drawn ${fm(l.drawnTotal)}` : ''}, ~${fm(l.recentMonthly)}/mo`).join('; ') : 'none identified'));
  lines.push(`Subscriptions: ~${fm(subs.monthlyTotal)}/month across ${subs.rows.length} services.`);
  const spaces = extras?.spaces ?? [];
  if (spaces.length > 0) {
    lines.push('Ring-fenced in Starling Spaces (NOT in the main balance above): '
      + spaces.map((s) => `${s.name} (${s.kind}) ${fm(s.balance)}`).join('; ')
      + `. Total set aside ${fm(spaces.reduce((s, x) => s + x.balance, 0))}.`);
  }
  const events = extras?.events ?? [];
  if (events.length > 0) {
    lines.push('Planned events: ' + events.map((e) =>
      `${e.name}${e.location ? ` in ${e.location}` : ''} ${e.start}→${e.end}, budget ${fm(eventGross(e))}`
      + (e.clientContribution > 0 ? `, ${e.client || 'client'} covers ${fm(e.clientContribution)} (net ${fm(eventNet(e))})` : '')).join('; '));
  }
  const answers = extras?.answers ?? {};
  const answered = Object.values(answers).slice(-12);
  if (answered.length > 0) {
    lines.push('Decisions the owner has filed (treat as ground truth): ' + answered
      .map((a) => `"${a.question}" -> ${a.answer}`).join(' | '));
  }
  const qs = computeQuestions(txs, extras).filter((q) => !answers[q.key]);
  if (qs.length) lines.push('Open questions the data raises: ' + qs.map((q) => q.q).join(' | '));
  lines.push('Notes: Lemino Payments is the client Vivo. Capital On Tap is a revolving credit facility (credits are drawdowns, not revenue). NCFF2-AFL and Funding Circle are loan repayments. HMRC NDDS is a standing direct debit.');
  return lines.join('\n');
}
