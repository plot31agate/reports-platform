/* api.ts — the reporting-core bridge. Reads the snapshot and issues the write
   calls that make the roster + vault real in reporting.db. Every write is a
   JSON request to the admin-gated /agency/api/* endpoints on the FastAPI app
   (proxied in dev, same-origin in prod). Degrades gracefully: if the snapshot
   isn't reachable (static preview, backend down) loadSnapshot returns null and
   the app falls back to roster config + the localStorage overlay. */
import type { Snapshot, SnapAgency } from './agency';
import type { ClientKind, PortalStatus } from './roster';

const API = `${import.meta.env.BASE_URL}api`;

export async function loadSnapshot(): Promise<Snapshot | null> {
  try {
    // Absolute against the app base (/agency/) so it resolves the same whether
    // or not the page URL has a trailing slash.
    const res = await fetch(`${import.meta.env.BASE_URL}snapshot.json`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as Snapshot;
  } catch {
    return null;
  }
}

/* ---- write layer ---- */

/** A failed API call surfaces its server message so the UI can show it. */
export class ApiError extends Error {}

async function req<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch { /* ignore */ }
    throw new ApiError(detail);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export interface ClientPayload { slug: string; display_name: string; agency: SnapAgency; workspaceUrl?: string }

/** Reporting-core config keys Agency HQ may write. */
export interface ClientSettingsInput {
  about?: string;
  sections?: string[];
  competitors?: string[];
  executives?: string[];
  sentiment_context?: string;
  report_focus?: string;
}

export interface NewClientInput {
  name: string; kind: ClientKind; owner?: string; website?: string;
  cadence?: Partial<{ report: string; articlesPerWeek: number; reviewMonths: number }>;
  strategy?: { updated: string | null; focus?: string | null };
  portalUrl?: string;
  /** The wizard sends the whole setup with the create, so a new client lands configured. */
  settings?: ClientSettingsInput;
  connections?: Record<string, Record<string, string>>;
}

export const createClient = (input: NewClientInput) => req<ClientPayload>('/clients', 'POST', input);
export const patchSettings = (slug: string, settings: ClientSettingsInput) =>
  req<ClientPayload>(`/clients/${slug}/settings`, 'PATCH', settings);
export const putConnection = (slug: string, provider: string, fields: Record<string, string>) =>
  req<{ ok: boolean }>(`/clients/${slug}/connections/${provider}`, 'PUT', fields);
export const testConnection = (slug: string, provider: string) =>
  req<{ ok: boolean; message: string }>(`/clients/${slug}/connections/${provider}/test`, 'POST', {});

/* ---- Claude setup assistant ---- */
export interface SetupDraft {
  about?: string; strategy_focus?: string;
  competitors?: string[]; executives?: string[];
  sentiment_brief?: string; report_focus?: string;
  core_keywords?: string[]; mention_queries?: string[]; sections?: string[];
}
export const draftClientSetup = (input: { name: string; website?: string; description?: string; kind?: ClientKind }) =>
  req<{ draft: SetupDraft }>('/assist/client-setup', 'POST', input);
export const patchClient = (slug: string, patch: Record<string, unknown>) =>
  req<ClientPayload>(`/clients/${slug}`, 'PATCH', patch);
export const deleteClient = (slug: string) => req<{ ok: boolean }>(`/clients/${slug}`, 'DELETE');
export const createReporting = (slug: string) => req<ClientPayload>(`/clients/${slug}/reporting`, 'POST', {});
export const createPortal = (slug: string, status: PortalStatus, portalUrl?: string) =>
  req<ClientPayload>(`/clients/${slug}/portal`, 'POST', { status, ...(portalUrl !== undefined ? { portalUrl } : {}) });

/* ---- vault ---- */
export interface SecretInput { label: string; login_url?: string; username?: string; password?: string; notes?: string }
export const addSecret = (slug: string, input: SecretInput) =>
  req<{ ok: boolean; id: number }>(`/clients/${slug}/secrets`, 'POST', input);
export const updateSecret = (id: number, input: SecretInput) =>
  req<{ ok: boolean }>(`/secrets/${id}`, 'PATCH', input);
export const deleteSecret = (id: number) => req<{ ok: boolean }>(`/secrets/${id}`, 'DELETE');
export const revealSecret = (id: number) => req<{ password: string }>(`/secrets/${id}/reveal`, 'POST', {});
