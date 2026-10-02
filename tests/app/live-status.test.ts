// @vitest-environment jsdom
//
// Live observations are labelled by their real freshness: fetched now (LIVE),
// reused within the window (CACHED SNAPSHOT, with its own checked-at time),
// and re-fetched after it. Relative ages come from the displayed timestamp.
import { beforeEach, describe, expect, it } from 'vitest';
import { clearObservations, freshnessLabel, MAX_AGE_MS, observe, refreshAges, timeWithAgo } from '../../src/app/live-status.js';

beforeEach(() => clearObservations());

describe('live status freshness', () => {
  it('fetches, reuses within the window (labelled cached), and re-fetches after it, picking up a newer epoch', async () => {
    let now = 1_790_000_000_000;
    let epoch = 31;
    let loads = 0;
    const load = async () => {
      loads++;
      return { open_epoch: epoch };
    };
    const first = await observe('status', load, MAX_AGE_MS, () => now);
    expect(first).toMatchObject({ data: { open_epoch: 31 }, fromCache: false, checkedAt: now });

    epoch = 32; // the mint closes another epoch
    now += 5_000;
    const cached = await observe('status', load, MAX_AGE_MS, () => now);
    expect(cached).toMatchObject({ data: { open_epoch: 31 }, fromCache: true, checkedAt: now - 5_000 });
    expect(freshnessLabel(cached)).toMatch(/CACHED SNAPSHOT/);
    expect(freshnessLabel(cached)).not.toMatch(/LIVE/);

    now += MAX_AGE_MS;
    const fresh = await observe('status', load, MAX_AGE_MS, () => now);
    expect(fresh).toMatchObject({ data: { open_epoch: 32 }, fromCache: false, checkedAt: now });
    expect(freshnessLabel(fresh)).toMatch(/^<span class="live-tag">LIVE<\/span> checked /);
    expect(loads).toBe(2);
  });

  it('the relative age is computed from the same instant as the absolute time beside it, and keeps advancing', () => {
    const at = Date.UTC(2026, 9, 1, 13, 15, 3);
    document.body.innerHTML = `<p id="x">${timeWithAgo(at)}</p>`;
    const p = document.getElementById('x')!;
    expect(p.textContent).toMatch(/^Oct 1, 2026, 13:15 UTC \(/);
    expect(p.querySelector('time')!.dataset.ago).toBe(new Date(at).toISOString());
    refreshAges(document, at + 90_000);
    expect(p.querySelector('time')!.textContent).toBe('2 minutes ago');
    refreshAges(document, at + 3 * 3_600_000);
    expect(p.querySelector('time')!.textContent).toBe('3 hours ago');
  });
});
