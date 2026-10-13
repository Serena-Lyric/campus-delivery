import {
  DeliveryTaskStatus,
  OrderEventActorType,
  OrderEventType,
  OrderStatus,
  RiderTipEventType,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
import { expirePausedPreparation } from './preparation-control.js';

export async function expireOpenDeliveryTask(
  tx: Prisma.TransactionClient,
  taskId: string,
  now: Date,
): Promise<number> {
  const task = await tx.deliveryTask.findUnique({
    where: { id: taskId },
    include: { order: { include: { pricing: true } } },
  });
  if (
    !task
    || (task.status !== DeliveryTaskStatus.OPEN && task.status !== DeliveryTaskStatus.RISK_REVIEW)
    || task.riderId
    || !task.claimDeadline
    || task.claimDeadline > now
    || task.order.status !== OrderStatus.READY_FOR_RIDER
    || !task.order.pricing
  ) return 0;

  if (await expirePausedPreparation(tx, task, now)) return 0;
  if (task.order.goodsChangeReviewPending) return 0;

  const pricing = task.order.pricing;
  const refundableTipMinor = pricing.customerRiderTipMinor;
  const customerRefundMinor = pricing.itemSubtotalMinor
    + pricing.customerDeliveryFeeMinor
    + refundableTipMinor;
  await tx.deliveryTask.update({ where: { id: task.id }, data: { status: DeliveryTaskStatus.NO_RIDER_ACCEPTED } });
  await tx.order.update({ where: { id: task.orderId }, data: { status: OrderStatus.NO_RIDER_ACCEPTED } });
  await tx.orderPricing.update({
    where: { orderId: task.orderId },
    data: {
      customerRefundMinor,
      customerRiderTipRefundMinor: { increment: refundableTipMinor },
      customerRiderTipMinor: 0,
      riderGuaranteedPayoutMinor: pricing.riderGuaranteedPayoutMinor - refundableTipMinor,
      riderPayoutMinor: pricing.riderPayoutMinor - refundableTipMinor,
    },
  });
  if (refundableTipMinor > 0) {
    await tx.riderTipEvent.create({
      data: {
        orderId: task.orderId,
        customerId: task.order.customerId,
        type: RiderTipEventType.NO_RIDER_REFUND,
        deltaMinor: -refundableTipMinor,
        balanceAfterMinor: 0,
        reason: 'NO_RIDER_ACCEPTED',
        createdAt: now,
      },
    });
  }
  await tx.orderEvent.create({
    data: {
      orderId: task.orderId,
      eventType: OrderEventType.NO_RIDER_ACCEPTED,
      actorType: OrderEventActorType.SYSTEM,
      fromStatus: OrderStatus.READY_FOR_RIDER,
      toStatus: OrderStatus.NO_RIDER_ACCEPTED,
      reason: 'Claim deadline reached without a rider',
      metadata: {
        firstPublishedAt: task.firstPublishedAt?.toISOString() ?? null,
        claimDeadline: task.claimDeadline.toISOString(),
        customerRefundMinor,
        riderTipRefundMinor: refundableTipMinor,
      },
      createdAt: now,
    },
  });
  return 1;
}

export async function releaseExpiredCoolingOrders(
  prisma: PrismaClient,
  now = new Date(),
  limit = 100,
): Promise<number> {
  const candidates = await prisma.order.findMany({
    where: { status: OrderStatus.CREATED, coolingOffEndsAt: { lte: now } },
    select: { id: true },
    orderBy: { coolingOffEndsAt: 'asc' },
    take: limit,
  });

  let released = 0;
  for (const candidate of candidates) {
    released += await prisma.$transaction(async (tx) => {
      const updated = await tx.order.updateMany({
        where: {
          id: candidate.id,
          status: OrderStatus.CREATED,
          coolingOffEndsAt: { lte: now },
        },
        data: { status: OrderStatus.MERCHANT_PENDING },
      });
      if (updated.count !== 1) return 0;
      await tx.orderEvent.create({
        data: {
          orderId: candidate.id,
          eventType: OrderEventType.COOLING_OFF_COMPLETED,
          actorType: OrderEventActorType.SYSTEM,
          fromStatus: OrderStatus.CREATED,
          toStatus: OrderStatus.MERCHANT_PENDING,
          metadata: { coolingOffEndedAt: now.toISOString() },
        },
      });
      return 1;
    });
  }
  return released;
}

export async function expireUnclaimedDeliveryTasks(
  prisma: PrismaClient,
  now = new Date(),
  limit = 100,
): Promise<number> {
  const candidates = await prisma.deliveryTask.findMany({
    where: {
      status: { in: [DeliveryTaskStatus.OPEN, DeliveryTaskStatus.RISK_REVIEW] },
      riderId: null,
      claimDeadline: { lte: now },
    },
    select: { id: true, orderId: true },
    orderBy: { claimDeadline: 'asc' },
    take: limit,
  });

  let expired = 0;
  for (const candidate of candidates) {
    expired += await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${candidate.orderId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "DeliveryTask" WHERE "id" = ${candidate.id}::uuid FOR UPDATE`;
      return expireOpenDeliveryTask(tx, candidate.id, now);
    });
  }
  return expired;
}
