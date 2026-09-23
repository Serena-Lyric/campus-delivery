import { MerchantExposureState } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { demoPolicy } from '../prisma/seed.js';
import { exposureForUsage, type PolicyConfig } from '../src/merchant-policy/policies.js';
import {
  BudgetSubsidyEligibilityPolicy,
  CappedSubsidyIncrementPolicy,
  NaturalClaimTimingPolicy,
} from '../src/subsidy/policies.js';

const thresholds = [
  { minUsageBps: 0, state: MerchantExposureState.NORMAL },
  { minUsageBps: 5000, state: MerchantExposureState.LIMITED },
  { minUsageBps: 9000, state: MerchantExposureState.HIDDEN },
];

describe('platform subsidy policy boundaries', () => {
  const config = demoPolicy as PolicyConfig;

  it('keeps eligibility separate and never consumes the entire remaining merchant budget', () => {
    const decision = new BudgetSubsidyEligibilityPolicy().evaluate({
      enabled: true,
      remainingMerchantBudgetMinor: 100,
      currentOrderSubsidyMinor: 0,
      merchantBudgetUsageBpsPerOrder: 10_000,
      currentMerchantQuoteMinor: 100,
      historicalNaturalClaimQuoteAverageMinor: null,
      merchantPublishedOrderCount: 0,
      merchantCompletedOrderCount: 0,
      merchantCompletionRateBps: null,
    });
    expect(decision.eligible).toBe(true);
    expect(decision.remainingBudgetForOrderMinor).toBe(99);
  });

  it('uses natural-claim samples for timing and the configured baseline when none exist', () => {
    const policy = new NaturalClaimTimingPolicy();
    const published = new Date('2026-09-23T00:00:00.000Z');
    const deadline = new Date('2026-09-23T00:40:00.000Z');
    const natural = policy.evaluate({
      now: new Date('2026-09-23T00:05:00.000Z'),
      firstPublishedAt: published,
      claimDeadline: deadline,
      lastSubsidyAt: null,
      naturalClaimLatencySeconds: [120, 180],
      config,
    });
    expect(natural.baselineSeconds).toBe(150);
    expect(natural.allowed).toBe(true);

    const fallback = policy.evaluate({
      now: published,
      firstPublishedAt: published,
      claimDeadline: deadline,
      lastSubsidyAt: null,
      naturalClaimLatencySeconds: [],
      config,
    });
    expect(fallback.baselineSeconds).toBe(config.defaultNaturalClaimBaselineSeconds);
    expect(fallback.allowed).toBe(false);
  });

  it('caps each increment by step, absolute step, per-order cap, and eligible budget', () => {
    const decision = new CappedSubsidyIncrementPolicy().evaluate({
      requestedMinor: 999,
      currentOrderSubsidyMinor: config.platformSubsidyMaxPerOrderMinor - 30,
      remainingBudgetForOrderMinor: 20,
      config,
    });
    expect(decision.addedMinor).toBe(20);
  });
});

describe('merchant exposure policy', () => {
  it('changes state at configured usage thresholds', () => {
    expect(exposureForUsage(499, 1000, thresholds).state).toBe(MerchantExposureState.NORMAL);
    expect(exposureForUsage(500, 1000, thresholds).state).toBe(MerchantExposureState.LIMITED);
    expect(exposureForUsage(900, 1000, thresholds).state).toBe(MerchantExposureState.HIDDEN);
  });
});
