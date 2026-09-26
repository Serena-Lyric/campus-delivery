import {
  ClaimSampleType,
  MerchantExposureState,
  OrderStatus,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
import { requireAdminLevel, type Actor } from '../auth/auth.js';
import { loadPolicyConfig, type PolicyConfig } from '../merchant-policy/policies.js';
import { notFound } from '../shared/errors.js';
import { classifyMerchantRisk, MerchantExposurePolicy } from './policies.js';

function average(values: number[]): number | null {
  return values.length === 0 ? null : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function elapsedSeconds(from: Date | null, to: Date | null): number | null {
  return from && to ? Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000)) : null;
}

function percentile(values: number[], percentage: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * percentage) - 1] ?? null;
}

export async function getMerchantFulfillmentMetrics(
  prisma: PrismaClient | Prisma.TransactionClient,
  merchantId: string,
  config: PolicyConfig,
) {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId }, select: { id: true } });
  if (!merchant) throw notFound('Merchant');
  const terminalStatuses = [OrderStatus.DELIVERED, OrderStatus.NO_RIDER_ACCEPTED];
  const [terminalTasks, claims, subsidizedTerminalClaims, publishedTasks, exceptions, recoveryTasks] = await Promise.all([
    prisma.deliveryTask.findMany({
      where: { order: { merchantId, status: { in: terminalStatuses } }, firstPublishedAt: { not: null } },
      orderBy: { firstPublishedAt: 'desc' },
      take: config.merchantRiskWindowOrderCount,
      include: {
        assignments: { orderBy: { claimedAt: 'asc' }, take: 1 },
        order: { select: { status: true, pricing: { select: { platformSubsidyMinor: true } } } },
      },
    }),
    prisma.deliveryAssignment.findMany({
      where: { order: { merchantId } },
      orderBy: { claimedAt: 'desc' },
      take: config.merchantRiskWindowOrderCount,
      select: { claimLatencySeconds: true, claimSampleType: true },
    }),
    prisma.deliveryAssignment.findMany({
      where: {
        claimSampleType: ClaimSampleType.SUBSIDIZED,
        order: { merchantId, status: { in: terminalStatuses } },
      },
      orderBy: { claimedAt: 'desc' },
      take: config.merchantRiskWindowOrderCount,
      select: { order: { select: { status: true } } },
    }),
    prisma.deliveryTask.findMany({
      where: { order: { merchantId }, firstPublishedAt: { not: null } },
      orderBy: { firstPublishedAt: 'desc' },
      take: config.merchantRiskWindowOrderCount,
      select: { order: { select: { status: true, pricing: { select: { platformSubsidyMinor: true } } } } },
    }),
    prisma.exceptionEvent.findMany({
      where: { order: { merchantId } },
      orderBy: { createdAt: 'desc' },
      take: config.merchantRiskWindowOrderCount,
      select: { type: true },
    }),
    prisma.deliveryTask.findMany({
      where: { order: { merchantId, status: { in: terminalStatuses } }, firstPublishedAt: { not: null } },
      orderBy: { firstPublishedAt: 'desc' },
      take: config.merchantExposureRecoveryWindowOrderCount,
      select: { order: { select: { status: true, pricing: { select: { platformSubsidyMinor: true } } } } },
    }),
  ]);
  const delivered = terminalTasks.filter((task) => task.order.status === OrderStatus.DELIVERED);
  const noRiderAccepted = terminalTasks.filter((task) => task.order.status === OrderStatus.NO_RIDER_ACCEPTED);
  const observableTerminalOrderCount = delivered.length + noRiderAccepted.length;
  const naturalClaims = claims.filter((assignment) => assignment.claimSampleType === ClaimSampleType.NATURAL);
  const subsidizedClaims = claims.filter((assignment) => assignment.claimSampleType === ClaimSampleType.SUBSIDIZED);
  const subsidizedRescued = subsidizedTerminalClaims.filter(({ order }) => order.status === OrderStatus.DELIVERED);
  const claimToPickup = terminalTasks.map((task) => elapsedSeconds(task.claimedAt, task.pickedUpAt)).filter((value): value is number => value !== null);
  const pickupToDelivery = terminalTasks.map((task) => elapsedSeconds(task.pickedUpAt, task.deliveredAt)).filter((value): value is number => value !== null);
  const totalFulfillment = delivered.map((task) => elapsedSeconds(task.firstPublishedAt, task.deliveredAt)).filter((value): value is number => value !== null);
  const exceptionCounts: Record<string, number> = {};
  for (const exception of exceptions) {
    exceptionCounts[exception.type] = (exceptionCounts[exception.type] ?? 0) + 1;
  }
  const platformSubsidyUsedMinor = publishedTasks.reduce((sum, task) => sum + (task.order.pricing?.platformSubsidyMinor ?? 0), 0);
  const completedOrderSubsidyMinor = delivered.reduce((sum, task) => sum + (task.order.pricing?.platformSubsidyMinor ?? 0), 0);
  const recoveryNoRiderCount = recoveryTasks.filter(({ order }) => order.status === OrderStatus.NO_RIDER_ACCEPTED).length;
  const recoverySubsidized = recoveryTasks.filter(({ order }) => (order.pricing?.platformSubsidyMinor ?? 0) > 0);
  const recoverySubsidizedDelivered = recoverySubsidized.filter(({ order }) => order.status === OrderStatus.DELIVERED);

  return {
    windowOrderCount: config.merchantRiskWindowOrderCount,
    publishedOrderCount: publishedTasks.length,
    observableTerminalOrderCount,
    deliveredOrderCount: delivered.length,
    noRiderAcceptedCount: noRiderAccepted.length,
    observableCompletionRateBps: observableTerminalOrderCount === 0
      ? null
      : Math.floor(delivered.length * 10_000 / observableTerminalOrderCount),
    noRiderAcceptedRateBps: observableTerminalOrderCount === 0
      ? null
      : Math.floor(noRiderAccepted.length * 10_000 / observableTerminalOrderCount),
    claimSampleCount: claims.length,
    averageClaimLatencySeconds: average(claims.map((assignment) => assignment.claimLatencySeconds)),
    claimLatencyP50Seconds: percentile(claims.map((assignment) => assignment.claimLatencySeconds), 0.5),
    claimLatencyP90Seconds: percentile(claims.map((assignment) => assignment.claimLatencySeconds), 0.9),
    averageClaimToPickupSeconds: average(claimToPickup),
    averagePickupToDeliverySeconds: average(pickupToDelivery),
    averageTotalFulfillmentSeconds: average(totalFulfillment),
    naturalClaimCount: naturalClaims.length,
    subsidizedClaimCount: subsidizedClaims.length,
    subsidyDependencyBps: claims.length === 0 ? null : Math.floor(subsidizedClaims.length * 10_000 / claims.length),
    subsidizedTerminalClaimCount: subsidizedTerminalClaims.length,
    subsidizedRescuedOrderCount: subsidizedRescued.length,
    subsidizedClaimRescueRateBps: subsidizedTerminalClaims.length === 0
      ? null
      : Math.floor(subsidizedRescued.length * 10_000 / subsidizedTerminalClaims.length),
    platformSubsidyUsedMinor,
    completedOrderSubsidyMinor,
    platformSubsidyPerCompletedOrderMinor: delivered.length === 0
      ? null
      : Math.floor(completedOrderSubsidyMinor / delivered.length),
    exceptionCounts,
    recovery: {
      windowOrderCount: config.merchantExposureRecoveryWindowOrderCount,
      terminalOrderCount: recoveryTasks.length,
      noRiderAcceptedRateBps: recoveryTasks.length === 0
        ? null
        : Math.floor(recoveryNoRiderCount * 10_000 / recoveryTasks.length),
      subsidyDependencyBps: recoveryTasks.length === 0
        ? null
        : Math.floor(recoverySubsidized.length * 10_000 / recoveryTasks.length),
      subsidizedClaimRescueRateBps: recoverySubsidized.length === 0
        ? null
        : Math.floor(recoverySubsidizedDelivered.length * 10_000 / recoverySubsidized.length),
    },
  };
}

export async function getMerchantRiskSummary(prisma: PrismaClient, merchantId: string) {
  const { version, config } = await loadPolicyConfig(prisma);
  const metrics = await getMerchantFulfillmentMetrics(prisma, merchantId, config);
  const risk = classifyMerchantRisk(metrics, config);
  return {
    policyVersion: version,
    metrics,
    ...risk,
    sampleStatus: metrics.observableTerminalOrderCount >= config.merchantRiskMinimumSampleSize
      ? 'SUFFICIENT'
      : 'INSUFFICIENT_DATA',
    subsidyDependencyElevated: metrics.subsidyDependencyBps !== null
      && metrics.subsidyDependencyBps >= config.subsidyDependencyThresholdBps,
    subsidyRescueHealthy: metrics.subsidizedClaimRescueRateBps !== null
      && metrics.subsidizedClaimRescueRateBps >= config.subsidyRescueThresholdBps,
  };
}

export async function evaluateMerchantExposure(
  prisma: PrismaClient,
  actor: Actor,
  merchantId: string,
  forcedState?: MerchantExposureState,
) {
  requireAdminLevel(actor, ['SUPER_ADMIN']);
  const { version, config } = await loadPolicyConfig(prisma);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Merchant" WHERE "id" = ${merchantId}::uuid FOR UPDATE`;
    const merchant = await tx.merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) throw notFound('Merchant');
    const metrics = await getMerchantFulfillmentMetrics(tx, merchantId, config);
    const risk = classifyMerchantRisk(metrics, config);
    const decision = new MerchantExposurePolicy().evaluate({
      currentState: merchant.exposureState,
      timeRisk: risk.timeRisk,
      completionRisk: risk.completionRisk,
      noRiderAcceptedRateBps: metrics.noRiderAcceptedRateBps,
      observableTerminalOrderCount: metrics.observableTerminalOrderCount,
      subsidyDependencyBps: metrics.subsidyDependencyBps,
      subsidizedClaimRescueRateBps: metrics.subsidizedClaimRescueRateBps,
      recoveryTerminalOrderCount: metrics.recovery.terminalOrderCount,
      recoveryNoRiderAcceptedRateBps: metrics.recovery.noRiderAcceptedRateBps,
      recoverySubsidyDependencyBps: metrics.recovery.subsidyDependencyBps,
      recoverySubsidizedClaimRescueRateBps: metrics.recovery.subsidizedClaimRescueRateBps,
      exceptionCounts: metrics.exceptionCounts,
      ...(forcedState ? { forcedState } : {}),
    }, config);
    if (decision.state !== merchant.exposureState) {
      await tx.merchant.update({ where: { id: merchantId }, data: { exposureState: decision.state } });
      await tx.merchantExposureDecision.create({
        data: {
          merchantId,
          previousState: merchant.exposureState,
          newState: decision.state,
          timeRisk: risk.timeRisk,
          completionRisk: risk.completionRisk,
          policyVersion: version,
          reason: decision.reason,
          metricsSnapshot: metrics as Prisma.InputJsonValue,
          actorId: actor.id,
        },
      });
    }
    return { previousState: merchant.exposureState, newState: decision.state, ...decision, ...risk, metrics };
  });
}
