import { MerchantExposureState } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { calculateSubsidy, exposureForUsage } from '../src/merchant-policy/policies.js';

const thresholds = [
  { minUsageBps: 0, state: MerchantExposureState.NORMAL },
  { minUsageBps: 5000, state: MerchantExposureState.LIMITED },
  { minUsageBps: 9000, state: MerchantExposureState.HIDDEN },
];

describe('subsidy policy', () => {
  it('caps the payout gap by per-order and account limits', () => {
    expect(calculateSubsidy({
      enabled: true,
      targetRiderPayoutMinor: 500,
      customerDeliveryFeeMinor: 50,
      merchantContributionMinor: 100,
      maxSubsidyPerOrderMinor: 200,
      remainingSubsidyMinor: 120,
    })).toBe(120);
  });

  it('returns zero when disabled or when the target is already met', () => {
    expect(calculateSubsidy({
      enabled: false,
      targetRiderPayoutMinor: 500,
      customerDeliveryFeeMinor: 0,
      merchantContributionMinor: 0,
      maxSubsidyPerOrderMinor: 500,
      remainingSubsidyMinor: 500,
    })).toBe(0);
    expect(calculateSubsidy({
      enabled: true,
      targetRiderPayoutMinor: 100,
      customerDeliveryFeeMinor: 50,
      merchantContributionMinor: 50,
      maxSubsidyPerOrderMinor: 500,
      remainingSubsidyMinor: 500,
    })).toBe(0);
  });
});

describe('merchant exposure policy', () => {
  it('changes state at configured usage thresholds', () => {
    expect(exposureForUsage(499, 1000, thresholds).state).toBe(MerchantExposureState.NORMAL);
    expect(exposureForUsage(500, 1000, thresholds).state).toBe(MerchantExposureState.LIMITED);
    expect(exposureForUsage(900, 1000, thresholds).state).toBe(MerchantExposureState.HIDDEN);
  });
});

