import { DeliveryTaskStatus, OrderStatus, SettlementStatus, type PrismaClient } from '@prisma/client';
import type { Actor } from '../auth/auth.js';
import { conflict, forbidden, notFound } from '../shared/errors.js';
import { transitionOrder } from '../orders/state-machine.js';

const taskInclude = {
  order: {
    include: {
      merchant: { select: { id: true, name: true } },
      destinationLocation: { select: { id: true, name: true, type: true } },
      pricing: true,
    },
  },
};

export function listAvailableTasks(prisma: PrismaClient, limit: number, offset: number) {
  return prisma.deliveryTask.findMany({
    where: { status: DeliveryTaskStatus.OPEN, riderId: null },
    include: taskInclude,
    orderBy: { createdAt: 'asc' },
    take: limit,
    skip: offset,
  });
}

export function listRiderTasks(prisma: PrismaClient, actor: Actor, limit: number, offset: number) {
  if (!actor.riderId) throw forbidden();
  return prisma.deliveryTask.findMany({
    where: { riderId: actor.riderId },
    include: taskInclude,
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });
}

export async function claimTask(prisma: PrismaClient, actor: Actor, taskId: string) {
  if (!actor.riderId) throw forbidden();
  const riderId = actor.riderId;
  return prisma.$transaction(async (tx) => {
    const rider = await tx.rider.findUnique({ where: { id: riderId } });
    if (!rider || rider.status !== 'AVAILABLE') throw conflict('RIDER_UNAVAILABLE', 'Rider is not available to claim tasks');

    const claimed = await tx.deliveryTask.updateMany({
      where: { id: taskId, status: DeliveryTaskStatus.OPEN, riderId: null },
      data: { status: DeliveryTaskStatus.CLAIMED, riderId, claimedAt: new Date() },
    });
    if (claimed.count !== 1) throw conflict('TASK_ALREADY_CLAIMED', 'Delivery task is no longer available');

    const task = await tx.deliveryTask.findUnique({ where: { id: taskId }, include: { order: true } });
    if (!task) throw notFound('Delivery task');
    await transitionOrder(tx, task.orderId, task.order.status, OrderStatus.CLAIMED, actor);
    return tx.deliveryTask.findUniqueOrThrow({ where: { id: taskId }, include: taskInclude });
  });
}

export async function pickUpTask(prisma: PrismaClient, actor: Actor, taskId: string) {
  if (!actor.riderId) throw forbidden();
  return prisma.$transaction(async (tx) => {
    const task = await tx.deliveryTask.findUnique({ where: { id: taskId }, include: { order: true } });
    if (!task) throw notFound('Delivery task');
    if (task.riderId !== actor.riderId) throw forbidden();
    if (task.status !== DeliveryTaskStatus.CLAIMED) throw conflict('TASK_STATE_CONFLICT', 'Task is not ready for pickup');
    await transitionOrder(tx, task.orderId, task.order.status, OrderStatus.PICKED_UP, actor);
    await tx.deliveryTask.update({
      where: { id: task.id },
      data: { status: DeliveryTaskStatus.PICKED_UP, pickedUpAt: new Date() },
    });
    return tx.deliveryTask.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
  });
}

export async function deliverTask(prisma: PrismaClient, actor: Actor, taskId: string) {
  if (!actor.riderId) throw forbidden();
  return prisma.$transaction(async (tx) => {
    const task = await tx.deliveryTask.findUnique({
      where: { id: taskId },
      include: { order: { include: { pricing: true } } },
    });
    if (!task) throw notFound('Delivery task');
    if (task.riderId !== actor.riderId) throw forbidden();
    if (task.status !== DeliveryTaskStatus.PICKED_UP) throw conflict('TASK_STATE_CONFLICT', 'Task is not ready for delivery');
    if (!task.order.pricing) throw notFound('Order pricing');

    await transitionOrder(tx, task.orderId, task.order.status, OrderStatus.DELIVERED, actor);
    await tx.deliveryTask.update({
      where: { id: task.id },
      data: { status: DeliveryTaskStatus.COMPLETED, deliveredAt: new Date() },
    });
    await tx.settlement.update({
      where: { orderId: task.orderId },
      data: {
        status: SettlementStatus.FINALIZED,
        riderPayableMinor: task.order.pricing.riderPayoutMinor,
        merchantPayableMinor: task.order.pricing.merchantSettlementMinor,
        platformRevenueMinor: task.order.pricing.platformCommissionMinor - task.order.pricing.platformSubsidyMinor,
        finalizedAt: new Date(),
      },
    });
    return tx.deliveryTask.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
  });
}
