import { describe, expect, it } from 'vitest';
import { pickupCodeHash, pickupCodeMatches } from '../src/delivery/pickup-code.js';
import { assertTransition } from '../src/orders/state-machine.js';

describe('pickup protocol safety primitives', () => {
  it('checks salted codes and rejects wrong codes, salts and malformed hashes', () => {
    const hash = pickupCodeHash('123456', 'first-salt').toString('hex');
    expect(pickupCodeMatches('123456', 'first-salt', hash)).toBe(true);
    expect(pickupCodeMatches('123457', 'first-salt', hash)).toBe(false);
    expect(pickupCodeMatches('123456', 'different-salt', hash)).toBe(false);
    expect(pickupCodeMatches('123456', 'first-salt', 'invalid')).toBe(false);
  });
  it('keeps audited correction outside the ordinary order state machine', () => {
    expect(() => assertTransition('PICKED_UP', 'CLAIMED')).toThrow();
    expect(() => assertTransition('DELIVERED', 'CLAIMED')).toThrow();
  });
});
