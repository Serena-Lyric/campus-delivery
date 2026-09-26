import { MerchantExposureState } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { demoPolicy } from '../prisma/seed.js';
import type { PolicyConfig } from '../src/merchant-policy/policies.js';
import { classifyMerchantRisk, MerchantExposurePolicy } from '../src/merchant-risk/policies.js';
import {
  BudgetSubsidyEligibilityPolicy,
  CappedSubsidyIncrementPolicy,
  NaturalClaimTimingPolicy,
} from '../src/subsidy/policies.js';

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
  const config = demoPolicy as PolicyConfig;
  const exposureFacts = {
    timeRisk: 'NORMAL' as const,
    completionRisk: 'NORMAL' as const,
    subsidyDependencyBps: null,
    subsidizedClaimRescueRateBps: null,
    recoveryTerminalOrderCount: config.merchantExposureRecoveryMinimumSampleSize,
    recoveryNoRiderAcceptedRateBps: 0,
    recoverySubsidyDependencyBps: null,
    recoverySubsidizedClaimRescueRateBps: null,
    exceptionCounts: {},
  };

  it('keeps time and completion risk independent and returns unknown for insufficient data', () => {
    expect(classifyMerchantRisk({
      observableTerminalOrderCount: config.merchantRiskMinimumSampleSize - 1,
      deliveredOrderCount: config.merchantRiskMinimumSampleSize - 1,
      noRiderAcceptedRateBps: 10_000,
      averageTotalFulfillmentSeconds: config.slowFulfillmentThresholdSeconds + 1,
    }, config)).toEqual({ timeRisk: 'UNKNOWN', completionRisk: 'UNKNOWN' });
    expect(classifyMerchantRisk({
      observableTerminalOrderCount: config.merchantRiskMinimumSampleSize,
      deliveredOrderCount: config.merchantRiskMinimumSampleSize,
      noRiderAcceptedRateBps: 0,
      averageTotalFulfillmentSeconds: config.slowFulfillmentThresholdSeconds + 1,
    }, config)).toEqual({ timeRisk: 'SLOW', completionRisk: 'NORMAL' });
  });

  it('uses separate downgrade and recovery thresholds without subsidy usage input', () => {
    const policy = new MerchantExposurePolicy();
    expect(policy.evaluate({
      ...exposureFacts,
      currentState: MerchantExposureState.NORMAL,
      noRiderAcceptedRateBps: config.exposureReducedThresholdBps,
      observableTerminalOrderCount: config.merchantRiskMinimumSampleSize,
    }, config).state).toBe(MerchantExposureState.REDUCED);
    expect(policy.evaluate({
      ...exposureFacts,
      currentState: MerchantExposureState.REDUCED,
      noRiderAcceptedRateBps: config.exposureNormalRecoveryThresholdBps + 1,
      recoveryNoRiderAcceptedRateBps: config.exposureNormalRecoveryThresholdBps + 1,
      observableTerminalOrderCount: config.merchantRiskMinimumSampleSize,
    }, config).state).toBe(MerchantExposureState.REDUCED);
    expect(policy.evaluate({
      ...exposureFacts,
      currentState: MerchantExposureState.REDUCED,
      noRiderAcceptedRateBps: config.exposureNormalRecoveryThresholdBps,
      recoveryNoRiderAcceptedRateBps: config.exposureNormalRecoveryThresholdBps,
      observableTerminalOrderCount: config.merchantRiskMinimumSampleSize,
    }, config).state).toBe(MerchantExposureState.NORMAL);
  });

  it('uses subsidy health and keeps slow fulfillment from changing exposure by itself', () => {
    const policy = new MerchantExposurePolicy();
    expect(policy.evaluate({
      ...exposureFacts,
      timeRisk: 'SLOW',
      currentState: MerchantExposureState.NORMAL,
      noRiderAcceptedRateBps: 0,
      observableTerminalOrderCount: config.merchantRiskMinimumSampleSize,
    }, config).state).toBe(MerchantExposureState.NORMAL);
    expect(policy.evaluate({
      ...exposureFacts,
      currentState: MerchantExposureState.NORMAL,
      noRiderAcceptedRateBps: 0,
      observableTerminalOrderCount: config.merchantRiskMinimumSampleSize,
      subsidyDependencyBps: config.subsidyDependencyThresholdBps,
      subsidizedClaimRescueRateBps: config.subsidyRescueThresholdBps - 1,
    }, config)).toMatchObject({
      state: MerchantExposureState.REDUCED,
      reason: 'SUBSIDY_HEALTH_UNHEALTHY',
    });
  });

  it('requires an independent recovery sample window before improving exposure', () => {
    const policy = new MerchantExposurePolicy();
    const input = {
      ...exposureFacts,
      currentState: MerchantExposureState.REDUCED,
      noRiderAcceptedRateBps: 0,
      observableTerminalOrderCount: config.merchantRiskMinimumSampleSize,
      recoveryNoRiderAcceptedRateBps: 0,
    };
    expect(policy.evaluate({
      ...input,
      recoveryTerminalOrderCount: config.merchantExposureRecoveryMinimumSampleSize - 1,
    }, config).state).toBe(MerchantExposureState.REDUCED);
    expect(policy.evaluate({
      ...input,
      recoveryTerminalOrderCount: config.merchantExposureRecoveryMinimumSampleSize,
    }, config).state).toBe(MerchantExposureState.NORMAL);
  });
});
