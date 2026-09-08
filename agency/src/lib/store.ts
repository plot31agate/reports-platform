/* store.ts — the one write seam the roster + Setup views call.

   Online (the reporting core is reachable, snapshot loaded from reporting.db)
   every write goes to the /agency/api/* endpoints and then refreshes from the
   DB — one source of truth. Offline (static preview / backend down) the same
   calls fall back to the localStorage overlay so the prototype still works in a
   bare `npm run dev`. Views don't care which: they await a method and the app
   re-derives. The credential vault is server-side only, so its methods throw
   when offline and the UI hides them.

   The agency-patch shape is deliberately the same as RosterClient's fields, so
   one patch object drives both the API call and the overlay. */
import * as api from './api';
import { patchClient as lsPatch, addClient as lsAdd, removeAdded as lsRemove, uniqueSlug } from './rosterStore';
import type { RosterClient, ClientKind, PortalStatus } from './roster';

const isoToday = () => new Date().toISOString().slice(0, 10);

export interface NewClient {
  name: string; kind: ClientKind; owner: string;
  website?: string; portalUrl?: string;
  cadence: RosterClient['cadence'];
  focus?: string;
  /** Full reporting-core setup from the wizard — saved with the create when
      online; the offline overlay can only keep the roster basics. */
  settings?: api.ClientSettingsInput;
  connections?: Record<string, Record<string, string>>;
}

export interface Store {
  online: boolean;
  vaultReady: boolean;
  createClient(c: NewClient): Promise<string | undefined>; // returns the new slug when online
  patch(slug: string, patch: Partial<RosterClient>): Promise<void>;
  remove(slug: string): Promise<void>;
  createReporting(slug: string): Promise<string | undefined>; // returns workspace URL when online
  createPortal(slug: string, status: PortalStatus, url?: string): Promise<void>;
  // reporting-core setup (online only)
  saveSettings(slug: string, settings: api.ClientSettingsInput): Promise<void>;
  saveConnection(slug: string, provider: string, fields: Record<string, string>): Promise<void>;
  testConnection(slug: string, provider: string): Promise<{ ok: boolean; message: string }>;
  draftSetup(input: { name: string; website?: string; description?: string; kind?: ClientKind }): Promise<api.SetupDraft>;
  checkHealth(slug: string): Promise<api.LiveBlock>;
  checkAllHealth(): Promise<{ checked: number; down: number }>;
  // vault (online only)
  addSecret(slug: string, input: api.SecretInput): Promise<void>;
  updateSecret(id: number, input: api.SecretInput): Promise<void>;
  deleteSecret(id: number): Promise<void>;
  revealSecret(id: number): Promise<string>;
}

const offlineVault = () => { throw new Error('The credential vault needs the reporting core — sign in there to manage passwords.'); };
const offlineCore = () => { throw new Error('This needs the reporting core — it saves to reporting.db, not this browser.'); };

export function makeStore(opts: { online: boolean; vaultReady: boolean; refresh: () => void | Promise<void> }): Store {
  const { online, vaultReady, refresh } = opts;
  const done = async () => { await refresh(); };

  if (online) {
    return {
      online: true,
      vaultReady,
      async createClient(c) {
        const r = await api.createClient({
          name: c.name, kind: c.kind, owner: c.owner, website: c.website,
          cadence: c.cadence, portalUrl: c.portalUrl,
          strategy: c.focus ? { updated: isoToday(), focus: c.focus } : { updated: null },
          settings: c.settings, connections: c.connections,
        });
        await done();
        return r.slug;
      },
      async patch(slug, patch) { await api.patchClient(slug, patch as Record<string, unknown>); await done(); },
      async remove(slug) { await api.deleteClient(slug); await done(); },
      async createReporting(slug) { const r = await api.createReporting(slug); await done(); return r.workspaceUrl; },
      async createPortal(slug, status, url) { await api.createPortal(slug, status, url); await done(); },
      async saveSettings(slug, settings) { await api.patchSettings(slug, settings); await done(); },
      async saveConnection(slug, provider, fields) { await api.putConnection(slug, provider, fields); await done(); },
      async testConnection(slug, provider) { const r = await api.testConnection(slug, provider); await done(); return r; },
      async draftSetup(input) { return (await api.draftClientSetup(input)).draft; },
      async checkHealth(slug) { const r = await api.checkHealth(slug); await done(); return r.live; },
      async checkAllHealth() { const r = await api.checkAllHealth(); await done(); return r; },
      async addSecret(slug, input) { await api.addSecret(slug, input); await done(); },
      async updateSecret(id, input) { await api.updateSecret(id, input); await done(); },
      async deleteSecret(id) { await api.deleteSecret(id); await done(); },
      async revealSecret(id) { return (await api.revealSecret(id)).password; },
    };
  }

  // Offline: localStorage overlay over the config roster.
  return {
    online: false,
    vaultReady: false,
    async createClient(c) {
      const client: RosterClient = {
        slug: uniqueSlug(c.name), name: c.name, kind: c.kind, owner: c.owner || 'Unassigned',
        website: c.website, cadence: c.cadence,
        strategy: { updated: c.focus ? isoToday() : null, focus: c.focus || undefined },
        ...(c.portalUrl ? { portalUrl: c.portalUrl } : {}),
      };
      lsAdd(client); await done();
      return client.slug;
    },
    async patch(slug, patch) { lsPatch(slug, patch); await done(); },
    async remove(slug) { lsRemove(slug); await done(); },
    async createReporting(slug) { lsPatch(slug, { kind: 'reporting' }); await done(); return undefined; },
    async createPortal(slug, status, url) { lsPatch(slug, { kind: 'client-hq', portalStatus: status, ...(url ? { portalUrl: url } : {}) }); await done(); },
    async saveSettings() { offlineCore(); },
    async saveConnection() { offlineCore(); },
    async testConnection() { return offlineCore() as never; },
    async draftSetup() { return offlineCore() as never; },
    async checkHealth() { return offlineCore() as never; },
    async checkAllHealth() { return offlineCore() as never; },
    async addSecret() { offlineVault(); },
    async updateSecret() { offlineVault(); },
    async deleteSecret() { offlineVault(); },
    async revealSecret() { return offlineVault() as never; },
  };
}
