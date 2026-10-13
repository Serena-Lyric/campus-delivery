import { describe, expect, it } from 'vitest';
import { arrivalElapsedView } from '../src/delivery/arrival.js';

describe('declaration-node elapsed intervals are not onsite waiting proof', () => {
  const arrival = new Date('2026-10-13T04:00:00Z');
  const ready = new Date('2026-10-13T04:02:00Z');
  const handoff = new Date('2026-10-13T04:05:00Z');
  const later = new Date('2026-10-13T05:00:00Z');
  it('separates both elapsed segments and stops total duration at handoff', () => {
    expect(arrivalElapsedView(arrival, ready, handoff, null, later)).toMatchObject({ arrivalToReadySeconds: 120, readyToHandoffSeconds: 180, totalElapsedSeconds: 300, ongoing: false, onsiteVerified: false });
  });
  it('clamps readiness before arrival and preserves missing READY or optional arrival', () => {
    expect(arrivalElapsedView(ready, arrival, handoff, null, later)).toMatchObject({ arrivalToReadySeconds: 0, readyToHandoffSeconds: 300, totalElapsedSeconds: 180 });
    expect(arrivalElapsedView(arrival, null, handoff, null, later)).toMatchObject({ arrivalToReadySeconds: null, readyToHandoffSeconds: null, totalElapsedSeconds: 300 });
    expect(arrivalElapsedView(null, ready, handoff, null, later)).toMatchObject({ arrivalToReadySeconds: null, readyToHandoffSeconds: 180, totalElapsedSeconds: null });
  });
  it('uses live time while ongoing and only a lawful assignment end as the alternative ending node', () => {
    expect(arrivalElapsedView(arrival, null, null, null, ready)).toMatchObject({ totalElapsedSeconds: 120, ongoing: true });
    expect(arrivalElapsedView(arrival, handoff, null, ready, later)).toMatchObject({ readyAt: null, totalElapsedSeconds: 120, ongoing: false });
    expect(arrivalElapsedView(arrival, ready, handoff, null, later, true).handoffDisputed).toBe(true);
  });
});
