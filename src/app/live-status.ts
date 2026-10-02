// Live observations of the public deployment, with honest freshness labels.
//
// Every fetch records the moment it was observed. A re-render within
// MAX_AGE_MS reuses that observation but says so (CACHED SNAPSHOT, with its
// checked-at time); anything older is fetched again (LIVE). Relative ages are
// <time data-ago> elements computed from the same instant as the absolute
// UTC time printed beside them, and one ticker keeps them all current — so a
// label can never say "now" about data that is not.
import { formatAgo, formatUtc } from './decision-view.js';

export const MAX_AGE_MS = 20_000;

export interface Observation<T> {
  data: T;
  checkedAt: number;
  fromCache: boolean;
}

const cache = new Map<string, { data: unknown; checkedAt: number }>();

/** Fetches (or reuses, if younger than maxAgeMs) one observation. `load` performs the real fetch. */
export async function observe<T>(key: string, load: () => Promise<T>, maxAgeMs = MAX_AGE_MS, now: () => number = Date.now): Promise<Observation<T>> {
  const hit = cache.get(key);
  if (hit && now() - hit.checkedAt < maxAgeMs) return { data: hit.data as T, checkedAt: hit.checkedAt, fromCache: true };
  const data = await load();
  const checkedAt = now();
  cache.set(key, { data, checkedAt });
  return { data, checkedAt, fromCache: false };
}

export function clearObservations(): void {
  cache.clear();
}

/** "Oct 1, 2026, 13:15 UTC (2 minutes ago)" — both parts from the same instant. */
export function timeWithAgo(at: number | string | Date): string {
  const iso = new Date(at).toISOString();
  return `${formatUtc(iso)} (<time data-ago="${iso}" datetime="${iso}">${formatAgo(iso)}</time>)`;
}

/** The freshness tag for an observation. */
export function freshnessLabel(o: Pick<Observation<unknown>, 'checkedAt' | 'fromCache'>): string {
  return o.fromCache
    ? `<span class="cache-tag">CACHED SNAPSHOT</span> checked ${timeWithAgo(o.checkedAt)}`
    : `<span class="live-tag">LIVE</span> checked ${timeWithAgo(o.checkedAt)}`;
}

/** Re-renders every relative age on the page from its own timestamp. */
export function refreshAges(root: ParentNode = document, now = Date.now()): void {
  root.querySelectorAll<HTMLElement>('time[data-ago]').forEach((t) => {
    t.textContent = formatAgo(t.dataset.ago!, now);
  });
}

let ticker: ReturnType<typeof setInterval> | null = null;
export function startAgeTicker(intervalMs = 15_000): void {
  if (ticker) return;
  ticker = setInterval(() => refreshAges(), intervalMs);
}
