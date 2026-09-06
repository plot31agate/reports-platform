/* api.ts — load the reporting-core snapshot. Degrades gracefully: if
   snapshot.json isn't there (static preview with no generator run), we return
   null and every view still renders from roster config alone. Same spirit as
   Finance HQ's offline-tolerant fetchers. */
import type { Snapshot } from './agency';

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
