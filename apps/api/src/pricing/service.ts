import {
  DeliveryAssignmentStatus,
  DeliveryTaskStatus,
  OrderEventActorType,
  OrderEventType,
  OrderStatus,
  RiderTipEventType,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
import type { Actor } from '../auth/auth.js';
import { loadPolicyConfig, type PolicyConfig } from '../merchant-policy/policies.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../shared/errors.js';
import { addMinor, basisPoints } from '../shared/money.js';

export function riderPayoutMinor(pricing: {
  customerDeliveryFeeMinor: number;
  merchantDeliveryContributionMinor: number;
  customerRiderTipMinor: number;
  platformSubsidyMinor: number;
}): number {
  return addMinor(
    pricing.customerDeliveryFeeMinor,
    pricing.merchantDeliveryContributionMinor,
    pricing.customerRiderTipMinor,
    pricing.platformSubsidyMinor,
  );
}

export function merchantSettlementMinor(
  itemSubtotalMinor: number,
  platformCommissionMinor: number,
  merchantQuoteMinor: number,
): number {
  const value = itemSubtotalMinor - platformCommissionMinor - merchantQuoteMinor;
  if (value < 0) {
    throw badRequest('MERCHANT_QUOTE_TOO_HIGH', 'Merchant quote exceeds the payable order subtotal');
  }
  return value;
}

export async function initializeMerchantQuote(
  tx: Prisma.TransactionClient,
  orderId: string,
  merchantId: string,
  operatorId: string,
  configuredQuoteMinor: number,
  config: PolicyConfig,
  now: Date,
) {
  const pricing = await tx.orderPricing.findUnique({ where: { orderId } });
  if (!pricing) throw new AppError(500, 'MISSING_PRICING', 'Order pricing is missing');
  const platformCommissionMinor = basisPoints(pricing.itemSubtotalMinor, config.platformCommissionBps);
  const quoteVersion = 1;
  const updated = await tx.orderPricing.update({
    where: { orderId },
    data: {
      customerDeliveryFeeMinor: config.customerDeliveryFeeMinor,
      merchantDeliveryContributionMinor: configuredQuoteMinor,
      platformSubsidyMinor: 0,
      riderPayoutMinor: riderPayoutMinor({
        customerDeliveryFeeMinor: config.customerDeliveryFeeMinor,
        merchantDeliveryContributionMinor: configuredQuoteMinor,
        customerRiderTipMinor: pricing.customerRiderTipMinor,
        platformSubsidyMinor: 0,
      }),
      platformCommissionMinor,
      merchantSettlementMinor: merchantSettlementMinor(
        pricing.itemSubtotalMinor,
        platformCommissionMinor,
        configuredQuoteMinor,
      ),
      merchantQuoteVersion: quoteVersion,
      merchantQuoteUpdatedAt: now,
    },
  });
  await tx.merchantDeliveryQuote.create({
    data: {
      orderId,
      version: quoteVersion,
      previousMinor: 0,
      newMinor: configuredQuoteMinor,
      operatorId,
      reason: 'INITIAL_ORDER_QUOTE',
      createdAt: now,
    },
  });
  return updated;
}

export async function repriceOrder(
  prisma: PrismaClient,
  actor: Actor,
  orderId: string,
  newMinor: number,
  reason: string | undefined,
  now = new Date(),
) {
  if (!actor.merchantId) throw forbidden();
  if (!Number.isSafeInteger(newMinor) || newMinor < 0) {
    throw badRequest('INVALID_MONEY', 'newMinor must be a non-negative integer');
  }
  const { config } = await loadPolicyConfig(prisma);

  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { deliveryTask: true } });
    if (!order) throw notFound('Order');
    if (order.merchantId !== actor.merchantId) throw forbidden();
    if (!order.deliveryTask) throw conflict('ORDER_NOT_PUBLISHED', 'Order has not entered the rider pool');
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "DeliveryTask" WHERE "id" = ${order.deliveryTask.id}::uuid FOR UPDATE`;

    const task = await tx.deliveryTask.findUniqueOrThrow({ where: { id: order.deliveryTask.id } });
    if (task.status !== DeliveryTaskStatus.OPEN || task.riderId) {
      throw conflict('ORDER_ALREADY_CLAIMED', 'Merchant quote is locked after a rider claims the order');
    }
    if (task.claimDeadline && now >= task.claimDeadline) {
      throw conflict('CLAIM_DEADLINE_REACHED', 'Order claim deadline has been reached');
    }

    const pricing = await tx.orderPricing.findUnique({ where: { orderId } });
    if (!pricing) throw new AppError(500, 'MISSING_PRICING', 'Order pricing is missing');
    if (
      pricing.merchantQuoteUpdatedAt
      && now.getTime() < pricing.merchantQuoteUpdatedAt.getTime()
        + (task.merchantRepriceCooldownSeconds ?? config.merchantRepriceCooldownSeconds) * 1000
    ) {
      throw conflict('MERCHANT_REPRICE_COOLDOWN', 'Merchant quote is still in its update cooldown');
    }

    const version = pricing.merchantQuoteVersion + 1;
    const nextPayout = riderPayoutMinor({
      ...pricing,
      merchantDeliveryContributionMinor: newMinor,
    });
    const updated = await tx.orderPricing.updateMany({
      where: { orderId, merchantQuoteVersion: pricing.merchantQuoteVersion },
      data: {
        merchantDeliveryContributionMinor: newMinor,
        merchantSettlementMinor: merchantSettlementMinor(
          pricing.itemSubtotalMinor,
          pricing.platformCommissionMinor,
          newMinor,
        ),
        riderPayoutMinor: nextPayout,
        merchantQuoteVersion: version,
        merchantQuoteUpdatedAt: now,
      },
    });
    if (updated.count !== 1) throw conflict('PRICING_VERSION_CONFLICT', 'Order pricing changed concurrently');

    await tx.deliveryTask.update({ where: { id: task.id }, data: { payoutMinor: nextPayout } });
    await tx.merchantDeliveryQuote.create({
      data: {
        orderId,
        version,
        previousMinor: pricing.merchantDeliveryContributionMinor,
        newMinor,
        operatorId: actor.id,
        ...(reason ? { reason } : {}),
        createdAt: now,
      },
    });
    await tx.orderEvent.create({
      data: {
        orderId,
        eventType: OrderEventType.MERCHANT_QUOTE_UPDATED,
        actorType: OrderEventActorType.USER,
        fromStatus: order.status,
        toStatus: order.status,
        operatorId: actor.id,
        operatorRole: actor.role,
        metadata: {
          previousMinor: pricing.merchantDeliveryContributionMinor,
          newMinor,
          version,
          platformSubsidyAlreadyActive: pricing.platformSubsidyMinor > 0,
          merchantQuoteLowered: newMinor < pricing.merchantDeliveryContributionMinor,
        },
      },
    });

    return tx.orderPricing.findUniqueOrThrow({ where: { orderId } });
  });
}

export async function adjustRiderTip(
  prisma: PrismaClient,
  actor: Actor,
  orderId: string,
  deltaMinor: number,
  reason?: string,
  now = new Date(),
) {
  if (actor.role !== 'CUSTOMER') throw forbidden();
  if (!Number.isSafeInteger(deltaMinor) || deltaMinor === 0) {
    throw badRequest('INVALID_TIP_ADJUSTMENT', 'deltaMinor must be a non-zero integer');
  }

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { deliveryTask: true },
    });
    if (!order) throw notFound('Order');
    if (order.customerId !== actor.id) throw forbidden();
    if (
      order.status === OrderStatus.CANCELLED
      || order.status === OrderStatus.EXCEPTION
      || order.status === OrderStatus.NO_RIDER_ACCEPTED
    ) {
      throw conflict('ORDER_NOT_TIPPABLE', 'Rider incentive cannot be changed for this order');
    }

    if (order.deliveryTask) {
      await tx.$queryRaw`SELECT "id" FROM "DeliveryTask" WHERE "id" = ${order.deliveryTask.id}::uuid FOR UPDATE`;
    }
    await tx.$queryRaw`SELECT "id" FROM "OrderPricing" WHERE "orderId" = ${orderId}::uuid FOR UPDATE`;
    const pricing = await tx.orderPricing.findUniqueOrThrow({ where: { orderId } });
    const claimed = Boolean(order.deliveryTask?.riderId);
    if (claimed && deltaMinor < 0) {
      throw conflict('TIP_LOCKED_AFTER_CLAIM', 'Accepted rider incentive cannot be reduced after claim');
    }
    const balanceAfterMinor = pricing.customerRiderTipMinor + deltaMinor;
    if (balanceAfterMinor < 0) {
      throw conflict('TIP_BALANCE_NEGATIVE', 'Rider incentive cannot be reduced below zero');
    }

    const activeAssignment = claimed
      ? await tx.deliveryAssignment.findFirst({
        where: {
          taskId: order.deliveryTask!.id,
          status: { in: [DeliveryAssignmentStatus.ACTIVE, DeliveryAssignmentStatus.COMPLETED] },
        },
        orderBy: { claimedAt: 'desc' },
      })
      : null;
    if (claimed && !activeAssignment) {
      throw new AppError(500, 'MISSING_ASSIGNMENT', 'Claimed task is missing its assignment');
    }

    const nextPayout = pricing.riderPayoutMinor + deltaMinor;
    await tx.orderPricing.update({
      where: { orderId },
      data: {
        customerRiderTipMinor: balanceAfterMinor,
        riderPayoutMinor: nextPayout,
      },
    });
    if (order.deliveryTask) {
      await tx.deliveryTask.update({
        where: { id: order.deliveryTask.id },
        data: { payoutMinor: nextPayout },
      });
    }
    if (activeAssignment) {
      await tx.deliveryAssignment.update({
        where: { id: activeAssignment.id },
        data: { postClaimTipMinor: { increment: deltaMinor } },
      });
      await tx.settlement.updateMany({
        where: { orderId, status: 'FINALIZED' },
        data: { riderPayableMinor: { increment: deltaMinor } },
      });
      await tx.riderSettlement.updateMany({
        where: { orderId },
        data: { amountMinor: { increment: deltaMinor } },
      });
    }

    const type = claimed
      ? RiderTipEventType.POST_CLAIM_ADDITION
      : RiderTipEventType.PRE_CLAIM_ADJUSTMENT;
    const event = await tx.riderTipEvent.create({
      data: {
        orderId,
        customerId: actor.id,
        ...(activeAssignment ? { deliveryAssignmentId: activeAssignment.id } : {}),
        type,
        deltaMinor,
        balanceAfterMinor,
        ...(reason ? { reason } : {}),
        createdAt: now,
      },
    });
    await tx.orderEvent.create({
      data: {
        orderId,
        eventType: OrderEventType.RIDER_TIP_UPDATED,
        actorType: OrderEventActorType.USER,
        fromStatus: order.status,
        toStatus: order.status,
        operatorId: actor.id,
        operatorRole: actor.role,
        metadata: { deltaMinor, balanceAfterMinor, lockedToRider: claimed },
        createdAt: now,
      },
    });
    return event;
  });
}
