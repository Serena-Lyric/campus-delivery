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
import { loadPolicyConfig } from '../merchant-policy/policies.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../shared/errors.js';
import { addMinor } from '../shared/money.js';
import { assertStoredMinor, maxStoredMinor } from './config.js';

export function riderGuaranteedPayoutMinor(pricing: {
  riderBasePayoutMinor: number;
  merchantRescueContributionMinor: number;
  customerRiderTipMinor: number;
  platformSubsidyMinor: number;
}): number {
  return assertStoredMinor(addMinor(
    pricing.riderBasePayoutMinor,
    pricing.merchantRescueContributionMinor,
    pricing.customerRiderTipMinor,
    pricing.platformSubsidyMinor,
  ));
}

export function deliveryPlatformContributionMinor(pricing: {
  customerDeliveryFeeMinor: number;
  riderBasePayoutMinor: number;
  platformSubsidyMinor: number;
}): number {
  return pricing.customerDeliveryFeeMinor - pricing.riderBasePayoutMinor - pricing.platformSubsidyMinor;
}

export function merchantSettlementMinor(
  itemSubtotalMinor: number,
  platformCommissionMinor: number,
  merchantRescueContributionMinor: number,
): number {
  const value = itemSubtotalMinor - platformCommissionMinor - merchantRescueContributionMinor;
  if (value < 0) {
    throw badRequest('MERCHANT_RESCUE_TOO_HIGH', 'Merchant rescue contribution exceeds the payable order subtotal');
  }
  return value;
}

export async function initializeMerchantPricingForMarket(
  tx: Prisma.TransactionClient,
  orderId: string,
  now: Date,
) {
  const pricing = await tx.orderPricing.findUnique({ where: { orderId } });
  if (!pricing) throw new AppError(500, 'MISSING_PRICING', 'Order pricing is missing');
  return tx.orderPricing.update({
    where: { orderId },
    data: {
      merchantRescueUpdatedAt: now,
    },
  });
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
  assertStoredMinor(newMinor);
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
      pricing.merchantRescueUpdatedAt
      && now.getTime() < pricing.merchantRescueUpdatedAt.getTime()
        + (task.merchantRepriceCooldownSeconds ?? config.merchantRepriceCooldownSeconds) * 1000
    ) {
      throw conflict('MERCHANT_REPRICE_COOLDOWN', 'Merchant quote is still in its update cooldown');
    }

    if (newMinor <= pricing.merchantRescueContributionMinor) {
      throw conflict('RESCUE_CONTRIBUTION_MUST_INCREASE', 'Merchant rescue contribution can only increase before claim');
    }
    const addedMinor = newMinor - pricing.merchantRescueContributionMinor;
    const version = pricing.merchantRescueContributionVersion + 1;
    const nextPayout = riderGuaranteedPayoutMinor({ ...pricing, merchantRescueContributionMinor: newMinor });
    const updated = await tx.orderPricing.updateMany({
      where: { orderId, merchantRescueContributionVersion: pricing.merchantRescueContributionVersion },
      data: {
        merchantRescueContributionMinor: newMinor,
        merchantSettlementMinor: merchantSettlementMinor(
          pricing.itemSubtotalMinor,
          pricing.platformCommissionMinor,
          newMinor,
        ),
        riderGuaranteedPayoutMinor: nextPayout,
        riderPayoutMinor: nextPayout,
        merchantRescueContributionVersion: version,
        merchantRescueUpdatedAt: now,
      },
    });
    if (updated.count !== 1) throw conflict('PRICING_VERSION_CONFLICT', 'Order pricing changed concurrently');

    await tx.deliveryTask.update({ where: { id: task.id }, data: { payoutMinor: nextPayout } });
    await tx.merchantRescueContributionEvent.create({
      data: {
        orderId,
        version,
        previousMinor: pricing.merchantRescueContributionMinor,
        addedMinor,
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
          previousMinor: pricing.merchantRescueContributionMinor,
          addedMinor,
          newMinor,
          version,
          platformSubsidyAlreadyActive: pricing.platformSubsidyMinor > 0,
          semantic: 'MERCHANT_RESCUE_CONTRIBUTION',
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
  if (!Number.isSafeInteger(deltaMinor) || deltaMinor === 0 || Math.abs(deltaMinor) > maxStoredMinor) {
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
    if (now >= order.tipDeadline) {
      throw conflict('RIDER_TIP_WINDOW_ENDED', 'The rider incentive window has ended');
    }
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
    assertStoredMinor(balanceAfterMinor);
    assertStoredMinor(pricing.itemSubtotalMinor + pricing.customerDeliveryFeeMinor + balanceAfterMinor);

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

    const nextPayout = assertStoredMinor(pricing.riderGuaranteedPayoutMinor + deltaMinor);
    await tx.orderPricing.update({
      where: { orderId },
      data: {
        customerRiderTipMinor: balanceAfterMinor,
        riderGuaranteedPayoutMinor: nextPayout,
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
