import { describe, expect, it } from 'vitest';
import { pickupRiskSnapshot } from '../src/delivery/pickup-risk.js';
import { validatePolicyPayload } from '../src/merchant-policy/policies.js';
import { demoPolicy } from '../prisma/seed.js';

describe('authoritative fragile pickup policy', () => {
  it.each([[1500, 'NONE'], [1501, 'RECOMMENDED'], [5000, 'RECOMMENDED'], [5001, 'REQUIRED']])('uses strict threshold at %i', (price, level) => {
    expect(pickupRiskSnapshot([{ coreFragileSnapshot: true, unitPriceMinor: price as number, quantity: 1 }], demoPolicy, 4)).toMatchObject({ pickupEvidenceLevel: level, pickupEvidencePolicyVersion: 4 });
  });
  it('aggregates every core line and excludes expensive non-core items', () => {
    expect(pickupRiskSnapshot([{ coreFragileSnapshot: true, unitPriceMinor: 3000, quantity: 2 }], demoPolicy, 1).pickupEvidenceLevel).toBe('REQUIRED');
    expect(pickupRiskSnapshot([{ coreFragileSnapshot: true, unitPriceMinor: 3000, quantity: 1 }, { coreFragileSnapshot: false, unitPriceMinor: 8000, quantity: 1 }], demoPolicy, 1)).toMatchObject({ coreFragileValueMinor: 3000, pickupEvidenceLevel: 'RECOMMENDED' });
  });
  it('rejects invalid ordering and retains compatibility with old config payloads', () => {
    expect(() => validatePolicyPayload({ ...demoPolicy, fragilePickupRecommendedMinor: 5000 })).toThrow('thresholds');
    const { fragilePickupRecommendedMinor, fragilePickupRequiredMinor, ...legacy } = demoPolicy;
    expect(validatePolicyPayload(legacy)).toBeDefined();
    expect(pickupRiskSnapshot([], validatePolicyPayload(legacy), 1)).toMatchObject({ pickupEvidenceRecommendedMinor: 1500, pickupEvidenceRequiredMinor: 5000 });
  });
});
