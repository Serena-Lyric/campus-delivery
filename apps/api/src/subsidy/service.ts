import {
  ClaimSampleType,
  DeliveryTaskStatus,
  OrderEventActorType,
  OrderEventType,
  OrderStatus,
  type PrismaClient,
} from '@prisma/client';
import type { Actor } from '../auth/auth.js';
import { loadPolicyConfig } from '../merchant-policy/policies.js';
import { riderPayoutMinor } from '../pricing/service.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../shared/errors.js';
import {
  BudgetSubsidyEligibilityPolicy,
  CappedSubsidyIncrementPolicy,
  NaturalClaimTimingPolicy,
  type SubsidyEligibilityPolicy,
  type SubsidyIncrementPolicy,
  type SubsidyTimingPolicy,
} from './policies.js';

export type SubsidyPolicies = {
  eligibility: SubsidyEligibilityPolicy;
  timing: SubsidyTimingPolicy;
  increment: SubsidyIncrementPolicy;
};

export const defaultSubsidyPolicies: SubsidyPolicies = {
  eligibility: new BudgetSubsidyEligibilityPolicy(),
  timing: new NaturalClaimTimingPolicy(),
  increment: new CappedSubsidyIncrementPolicy(),
};

export async function addPlatformSubsidy(
  prisma: PrismaClient,
  actor: Actor,
  orderId: string,
  input: { requestedMinor?: number; reason: string },
  policies: SubsidyPolicies = defaultSubsidyPolicies,
  now = new Date(),
) {
  if (actor.role !== 'ADMIN') throw forbidden();
  if (input.requestedMinor !== undefined && (!Number.isSafeInteger(input.requestedMinor) || input.requestedMinor <= 0)) {
    throw badRequest('INVALID_SUBSIDY_INCREMENT', 'requestedMinor must be a positive integer');
  }
  const { version, config } = await loadPolicyConfig(prisma);

  return prisma.$transaction(async (tx) => {
    const initial = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        deliveryTask: true,
        pricing: true,
        merchant: { include: { subsidyAccount: true } },
      },
    });
    if (!initial) throw notFound('Order');
    if (!initial.deliveryTask || !initial.pricing) throw conflict('ORDER_NOT_PUBLISHED', 'Order is not in the rider market');
    if (!initial.merchant.subsidyAccount) throw conflict('SUBSIDY_ACCOUNT_MISSING', 'Merchant has no subsidy budget account');

    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${initial.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "DeliveryTask" WHERE "id" = ${initial.deliveryTask.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "MerchantSubsidyAccount" WHERE "id" = ${initial.merchant.subsidyAccount.id}::uuid FOR UPDATE`;

    const [
      task,
      pricing,
      account,
      lastSubsidy,
      naturalSamples,
      merchantPublishedOrderCount,
      merchantCompletedOrderCount,
    ] = await Promise.all([
      tx.deliveryTask.findUniqueOrThrow({ where: { id: initial.deliveryTask.id } }),
      tx.orderPricing.findUniqueOrThrow({ where: { orderId } }),
      tx.merchantSubsidyAccount.findUniqueOrThrow({ where: { id: initial.merchant.subsidyAccount.id } }),
      tx.subsidyRecord.findFirst({ where: { orderId }, orderBy: { createdAt: 'desc' } }),
      tx.deliveryAssignment.findMany({
        where: {
          claimSampleType: ClaimSampleType.NATURAL,
          order: { merchantId: initial.merchantId },
        },
        select: { claimLatencySeconds: true, merchantQuoteMinorAtClaim: true },
        orderBy: { claimedAt: 'desc' },
        take: 50,
      }),
      tx.deliveryTask.count({ where: { order: { merchantId: initial.merchantId } } }),
      tx.order.count({ where: { merchantId: initial.merchantId, status: OrderStatus.DELIVERED } }),
    ]);

    if (
      initial.status !== OrderStatus.READY_FOR_RIDER
      || task.status !== DeliveryTaskStatus.OPEN
      || task.riderId
    ) {
      throw conflict('ORDER_ALREADY_CLAIMED', 'Platform subsidy can only be added before claim');
    }
    if (!task.firstPublishedAt || !task.claimDeadline) {
      throw new AppError(500, 'MISSING_CLAIM_WINDOW', 'Published task is missing its claim window');
    }

    const timing = policies.timing.evaluate({
      now,
      firstPublishedAt: task.firstPublishedAt,
      claimDeadline: task.claimDeadline,
      lastSubsidyAt: lastSubsidy?.createdAt ?? null,
      naturalClaimLatencySeconds: naturalSamples.map((sample) => sample.claimLatencySeconds),
      config,
    });
    if (!timing.allowed) {
      throw conflict('SUBSIDY_TIMING_NOT_ALLOWED', timing.reason);
    }

    const remainingMerchantBudgetMinor = Math.max(0, account.subsidyLimitMinor - account.subsidyUsedMinor);
    const historicalQuoteAverage = naturalSamples.length > 0
      ? Math.round(
        naturalSamples.reduce((sum, sample) => sum + sample.merchantQuoteMinorAtClaim, 0)
        / naturalSamples.length,
      )
      : null;
    const eligibility = policies.eligibility.evaluate({
      enabled: config.subsidyEnabled,
      remainingMerchantBudgetMinor,
      currentOrderSubsidyMinor: pricing.platformSubsidyMinor,
      merchantBudgetUsageBpsPerOrder: config.merchantSubsidyBudgetMaxUsageBpsPerOrder,
      currentMerchantQuoteMinor: pricing.merchantDeliveryContributionMinor,
      historicalNaturalClaimQuoteAverageMinor: historicalQuoteAverage,
      merchantPublishedOrderCount,
      merchantCompletedOrderCount,
      merchantCompletionRateBps: merchantPublishedOrderCount > 0
        ? Math.floor(merchantCompletedOrderCount * 10_000 / merchantPublishedOrderCount)
        : null,
    });
    if (!eligibility.eligible) {
      throw conflict('SUBSIDY_NOT_ELIGIBLE', eligibility.reason);
    }

    const increment = policies.increment.evaluate({
      ...(input.requestedMinor !== undefined ? { requestedMinor: input.requestedMinor } : {}),
      currentOrderSubsidyMinor: pricing.platformSubsidyMinor,
      remainingBudgetForOrderMinor: eligibility.remainingBudgetForOrderMinor,
      config,
    });
    if (increment.addedMinor <= 0) {
      throw conflict('SUBSIDY_LIMIT_REACHED', increment.reason);
    }

    const previousPlatformSubsidyMinor = pricing.platformSubsidyMinor;
    const newPlatformSubsidyMinor = previousPlatformSubsidyMinor + increment.addedMinor;
    const nextPayout = riderPayoutMinor({
      ...pricing,
      platformSubsidyMinor: newPlatformSubsidyMinor,
    });
    const usedMinor = account.subsidyUsedMinor + increment.addedMinor;
    const subsidyUsageBps = account.subsidyLimitMinor === 0
      ? (usedMinor === 0 ? 0 : 10_000)
      : Math.min(10_000, Math.floor(usedMinor * 10_000 / account.subsidyLimitMinor));

    await tx.orderPricing.update({
      where: { orderId },
      data: {
        platformSubsidyMinor: newPlatformSubsidyMinor,
        riderPayoutMinor: nextPayout,
      },
    });
    await tx.deliveryTask.update({ where: { id: task.id }, data: { payoutMinor: nextPayout } });
    await tx.merchantSubsidyAccount.update({
      where: { id: account.id },
      data: { subsidyUsedMinor: usedMinor, subsidyUsageBps },
    });

    const record = await tx.subsidyRecord.create({
      data: {
        orderId,
        merchantId: initial.merchantId,
        previousPlatformSubsidyMinor,
        addedMinor: increment.addedMinor,
        newPlatformSubsidyMinor,
        policyVersion: version,
        trigger: input.reason,
        createdAt: now,
      },
    });
    await tx.orderEvent.create({
      data: {
        orderId,
        eventType: OrderEventType.PLATFORM_SUBSIDY_ADDED,
        actorType: OrderEventActorType.USER,
        fromStatus: initial.status,
        toStatus: initial.status,
        operatorId: actor.id,
        operatorRole: actor.role,
        metadata: {
          subsidyRecordId: record.id,
          previousPlatformSubsidyMinor,
          addedMinor: increment.addedMinor,
          newPlatformSubsidyMinor,
          policyVersion: version,
          timingReason: timing.reason,
          eligibilityReason: eligibility.reason,
          naturalSampleCount: naturalSamples.length,
        },
      },
    });

    return {
      record,
      currentGuaranteedRiderPayoutMinor: nextPayout,
      timing,
      eligibility,
      increment,
    };
  });
}
