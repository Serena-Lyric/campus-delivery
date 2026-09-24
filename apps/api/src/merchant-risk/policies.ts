import {
  MerchantCompletionRisk,
  MerchantExposureState,
  MerchantTimeRisk,
} from '@prisma/client';
import type { PolicyConfig } from '../merchant-policy/policies.js';

export type RiskFacts = {
  observableTerminalOrderCount: number;
  deliveredOrderCount: number;
  noRiderAcceptedRateBps: number | null;
  averageTotalFulfillmentSeconds: number | null;
};

export function classifyMerchantRisk(facts: RiskFacts, config: PolicyConfig) {
  const enoughCompletionSamples = facts.observableTerminalOrderCount >= config.merchantRiskMinimumSampleSize;
  const completionRisk = !enoughCompletionSamples || facts.noRiderAcceptedRateBps === null
    ? MerchantCompletionRisk.UNKNOWN
    : facts.noRiderAcceptedRateBps >= config.completionRiskHighThresholdBps
      ? MerchantCompletionRisk.HIGH
      : facts.noRiderAcceptedRateBps >= config.completionRiskElevatedThresholdBps
        ? MerchantCompletionRisk.ELEVATED
        : MerchantCompletionRisk.NORMAL;
  const timeRisk = facts.deliveredOrderCount < config.merchantRiskMinimumSampleSize
    || facts.averageTotalFulfillmentSeconds === null
    ? MerchantTimeRisk.UNKNOWN
    : facts.averageTotalFulfillmentSeconds >= config.slowFulfillmentThresholdSeconds
      ? MerchantTimeRisk.SLOW
      : MerchantTimeRisk.NORMAL;
  return { timeRisk, completionRisk };
}

export type ExposurePolicyInput = {
  currentState: MerchantExposureState;
  timeRisk: MerchantTimeRisk;
  completionRisk: MerchantCompletionRisk;
  noRiderAcceptedRateBps: number | null;
  observableTerminalOrderCount: number;
  subsidyDependencyBps: number | null;
  subsidizedClaimConversionBps: number | null;
  exceptionCounts: Readonly<Record<string, number>>;
  forcedState?: MerchantExposureState;
};

export type ExposurePolicyDecision = {
  state: MerchantExposureState;
  reason: string;
};

export class MerchantExposurePolicy {
  evaluate(input: ExposurePolicyInput, config: PolicyConfig): ExposurePolicyDecision {
    if (input.forcedState) return { state: input.forcedState, reason: 'ADMIN_FORCED_STATE' };
    if (
      input.observableTerminalOrderCount < config.merchantRiskMinimumSampleSize
      || input.noRiderAcceptedRateBps === null
    ) {
      return { state: input.currentState, reason: 'INSUFFICIENT_DATA' };
    }

    const failureBps = input.noRiderAcceptedRateBps;
    if (input.currentState === MerchantExposureState.HIDDEN || input.currentState === MerchantExposureState.SUSPENDED) {
      return { state: input.currentState, reason: 'ADMIN_STATE_PRESERVED' };
    }
    if (input.currentState === MerchantExposureState.SEVERELY_LIMITED) {
      return failureBps <= config.exposureLimitedRecoveryThresholdBps
        ? { state: MerchantExposureState.LIMITED, reason: 'RECOVERY_THRESHOLD_MET' }
        : { state: input.currentState, reason: 'RECOVERY_THRESHOLD_NOT_MET' };
    }
    if (input.currentState === MerchantExposureState.LIMITED) {
      if (failureBps >= config.exposureSeverelyLimitedThresholdBps) {
        return { state: MerchantExposureState.SEVERELY_LIMITED, reason: 'OBSERVED_FAILURE_RATE_SEVERE' };
      }
      return failureBps <= config.exposureReducedRecoveryThresholdBps
        ? { state: MerchantExposureState.REDUCED, reason: 'RECOVERY_THRESHOLD_MET' }
        : { state: input.currentState, reason: 'RECOVERY_THRESHOLD_NOT_MET' };
    }
    if (input.currentState === MerchantExposureState.REDUCED) {
      if (failureBps >= config.exposureSeverelyLimitedThresholdBps) {
        return { state: MerchantExposureState.SEVERELY_LIMITED, reason: 'OBSERVED_FAILURE_RATE_SEVERE' };
      }
      if (failureBps >= config.exposureLimitedThresholdBps) {
        return { state: MerchantExposureState.LIMITED, reason: 'OBSERVED_FAILURE_RATE_HIGH' };
      }
      return failureBps <= config.exposureNormalRecoveryThresholdBps
        ? { state: MerchantExposureState.NORMAL, reason: 'RECOVERY_THRESHOLD_MET' }
        : { state: input.currentState, reason: 'RECOVERY_THRESHOLD_NOT_MET' };
    }
    if (failureBps >= config.exposureSeverelyLimitedThresholdBps) {
      return { state: MerchantExposureState.SEVERELY_LIMITED, reason: 'OBSERVED_FAILURE_RATE_SEVERE' };
    }
    if (failureBps >= config.exposureLimitedThresholdBps) {
      return { state: MerchantExposureState.LIMITED, reason: 'OBSERVED_FAILURE_RATE_HIGH' };
    }
    if (failureBps >= config.exposureReducedThresholdBps) {
      return { state: MerchantExposureState.REDUCED, reason: 'OBSERVED_FAILURE_RATE_ELEVATED' };
    }
    return { state: MerchantExposureState.NORMAL, reason: 'OBSERVED_FAILURE_RATE_NORMAL' };
  }
}
