import type { PolicyConfig } from '../merchant-policy/policies.js';

export type SubsidyEligibilityContext = {
  enabled: boolean;
  remainingMerchantBudgetMinor: number;
  currentOrderSubsidyMinor: number;
  merchantBudgetUsageBpsPerOrder: number;
  currentMerchantQuoteMinor: number;
  historicalNaturalClaimQuoteAverageMinor: number | null;
  merchantPublishedOrderCount: number;
  merchantCompletedOrderCount: number;
  merchantCompletionRateBps: number | null;
};

export type SubsidyEligibilityDecision = {
  eligible: boolean;
  remainingBudgetForOrderMinor: number;
  reason: string;
};

export interface SubsidyEligibilityPolicy {
  evaluate(context: SubsidyEligibilityContext): SubsidyEligibilityDecision;
}

export class BudgetSubsidyEligibilityPolicy implements SubsidyEligibilityPolicy {
  evaluate(context: SubsidyEligibilityContext): SubsidyEligibilityDecision {
    if (!context.enabled) return { eligible: false, remainingBudgetForOrderMinor: 0, reason: 'SUBSIDY_DISABLED' };
    const budgetBeforeThisOrder = context.remainingMerchantBudgetMinor + context.currentOrderSubsidyMinor;
    const orderBudgetCap = Math.floor(
      budgetBeforeThisOrder * context.merchantBudgetUsageBpsPerOrder / 10_000,
    );
    const remainingBudgetForOrderMinor = Math.max(
      0,
      Math.min(
        Math.max(0, context.remainingMerchantBudgetMinor - 1),
        orderBudgetCap - context.currentOrderSubsidyMinor,
      ),
    );
    return {
      eligible: remainingBudgetForOrderMinor > 0,
      remainingBudgetForOrderMinor,
      reason: remainingBudgetForOrderMinor > 0 ? 'BUDGET_AVAILABLE' : 'ORDER_BUDGET_EXHAUSTED',
    };
  }
}

export type SubsidyTimingContext = {
  now: Date;
  firstPublishedAt: Date;
  claimDeadline: Date;
  lastSubsidyAt: Date | null;
  naturalClaimLatencySeconds: number[];
  config: PolicyConfig;
};

export type SubsidyTimingDecision = {
  allowed: boolean;
  baselineSeconds: number;
  nextAllowedAt: Date;
  reason: string;
};

export interface SubsidyTimingPolicy {
  evaluate(context: SubsidyTimingContext): SubsidyTimingDecision;
}

export class NaturalClaimTimingPolicy implements SubsidyTimingPolicy {
  evaluate(context: SubsidyTimingContext): SubsidyTimingDecision {
    const baselineSeconds = context.naturalClaimLatencySeconds.length > 0
      ? Math.round(
        context.naturalClaimLatencySeconds.reduce((sum, value) => sum + value, 0)
        / context.naturalClaimLatencySeconds.length,
      )
      : context.config.defaultNaturalClaimBaselineSeconds;
    const nextAllowedAt = context.lastSubsidyAt
      ? new Date(context.lastSubsidyAt.getTime() + context.config.platformSubsidyMinIntervalSeconds * 1000)
      : new Date(context.firstPublishedAt.getTime() + baselineSeconds * 1000);
    if (context.now >= context.claimDeadline) {
      return { allowed: false, baselineSeconds, nextAllowedAt, reason: 'CLAIM_DEADLINE_REACHED' };
    }
    return {
      allowed: context.now >= nextAllowedAt,
      baselineSeconds,
      nextAllowedAt,
      reason: context.now >= nextAllowedAt ? 'TIMING_ALLOWED' : 'WAITING_FOR_MARKET',
    };
  }
}

export type SubsidyIncrementContext = {
  requestedMinor?: number;
  currentOrderSubsidyMinor: number;
  remainingBudgetForOrderMinor: number;
  config: PolicyConfig;
};

export type SubsidyIncrementDecision = {
  addedMinor: number;
  reason: string;
};

export interface SubsidyIncrementPolicy {
  evaluate(context: SubsidyIncrementContext): SubsidyIncrementDecision;
}

export class CappedSubsidyIncrementPolicy implements SubsidyIncrementPolicy {
  evaluate(context: SubsidyIncrementContext): SubsidyIncrementDecision {
    const requested = context.requestedMinor ?? context.config.platformSubsidyStepMinor;
    const remainingPerOrder = Math.max(
      0,
      context.config.platformSubsidyMaxPerOrderMinor - context.currentOrderSubsidyMinor,
    );
    const addedMinor = Math.max(
      0,
      Math.min(
        requested,
        context.config.platformSubsidyMaxStepMinor,
        remainingPerOrder,
        context.remainingBudgetForOrderMinor,
      ),
    );
    return {
      addedMinor,
      reason: addedMinor > 0 ? 'CAPPED_INCREMENT' : 'NO_INCREMENT_AVAILABLE',
    };
  }
}
