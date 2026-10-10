import { describe, expect, it } from 'vitest';
import { requireRider } from '../src/riders/blocklist.js';

describe('personal merchant blocklist identity', () => {
  it('requires the rider role as well as a rider identity', () => {
    expect(requireRider({ id: 'user', role: 'RIDER', riderId: 'rider' })).toBe('rider');
    expect(() => requireRider({ id: 'user', role: 'MERCHANT', riderId: 'rider' })).toThrow();
    expect(() => requireRider({ id: 'user', role: 'RIDER' })).toThrow();
  });
});
