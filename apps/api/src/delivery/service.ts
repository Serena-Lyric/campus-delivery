import {
  DeliveryAssignmentStatus,
  DeliveryTaskStatus,
  EvidenceType,
  OrderEventType,
  OrderStatus,
  PickupVerificationMode,
  RiderSettlementStatus,
  SettlementStatus,
  VerificationPurpose,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
import type { Actor } from '../auth/auth.js';
import { allowsUnattendedDelivery, loadPolicyConfig } from '../merchant-policy/policies.js';
import { transitionOrder } from '../orders/state-machine.js';
import { conflict, forbidden, notFound } from '../shared/errors.js';
import { verifyOrderCode } from '../verification/service.js';

const taskInclude = {
  assignments: { orderBy: { claimedAt: 'desc' as const } },
  order: {
    include: {
      merchant: { select: { id: true, name: true } },
      destinationLocation: { select: { id: true, name: true, type: true } },
      pricing: true,
    },
  },
};

async function requireEvidence(
  tx: Prisma.TransactionClient,
  evidenceId: string | undefined,
  orderId: string,
  actor: Actor,
  expectedType: EvidenceType,
  stage: OrderStatus,
) {
  if (!evidenceId) throw conflict('EVIDENCE_REQUIRED', `${expectedType} evidence is required`);
  const evidence = await tx.evidence.findFirst({
    where: {
      id: evidenceId,
      orderId,
      actorId: actor.id,
      evidenceType: expectedType,
      orderStage: stage,
    },
  });
  if (!evidence) throw conflict('INVALID_EVIDENCE', 'Evidence does not match this order, actor, type, and stage');
  return evidence;
}

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
    where: { assignments: { some: { riderId: actor.riderId } } },
    include: taskInclude,
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });
}

export async function claimTask(prisma: PrismaClient, actor: Actor, taskId: string) {
  if (!actor.riderId) throw forbidden();
  const riderId = actor.riderId;
  const { config } = await loadPolicyConfig(prisma);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Rider" WHERE "id" = ${riderId}::uuid FOR UPDATE`;
    const rider = await tx.rider.findUnique({ where: { id: riderId } });
    if (!rider || rider.status !== 'AVAILABLE') throw conflict('RIDER_UNAVAILABLE', 'Rider is not available to claim tasks');

    const activeCount = await tx.deliveryTask.count({
      where: {
        riderId,
        status: { in: [DeliveryTaskStatus.CLAIMED, DeliveryTaskStatus.PICKED_UP] },
      },
    });
    const effectiveLimit = Math.min(
      rider.currentConcurrentOrderLimit,
      config.platformMaxConcurrentOrdersPerRider,
    );
    if (activeCount >= effectiveLimit) {
      throw conflict('RIDER_ORDER_LIMIT', 'Rider has reached the current concurrent order limit');
    }

    const claimed = await tx.deliveryTask.updateMany({
      where: { id: taskId, status: DeliveryTaskStatus.OPEN, riderId: null },
      data: { status: DeliveryTaskStatus.CLAIMED, riderId, claimedAt: new Date() },
    });
    if (claimed.count !== 1) throw conflict('TASK_ALREADY_CLAIMED', 'Delivery task is no longer available');

    const task = await tx.deliveryTask.findUnique({ where: { id: taskId }, include: { order: true } });
    if (!task) throw notFound('Delivery task');
    await transitionOrder(tx, task.orderId, task.order.status, OrderStatus.CLAIMED, actor, {
      eventType: OrderEventType.RIDER_CLAIMED,
    });
    await tx.deliveryAssignment.create({
      data: { taskId: task.id, orderId: task.orderId, riderId },
    });
    return tx.deliveryTask.findUniqueOrThrow({ where: { id: taskId }, include: taskInclude });
  });
}

export async function abandonTask(
  prisma: PrismaClient,
  actor: Actor,
  taskId: string,
  reason?: string,
) {
  if (!actor.riderId) throw forbidden();
  return prisma.$transaction(async (tx) => {
    const task = await tx.deliveryTask.findUnique({ where: { id: taskId }, include: { order: true } });
    if (!task) throw notFound('Delivery task');
    if (task.riderId !== actor.riderId) throw forbidden();
    if (task.status !== DeliveryTaskStatus.CLAIMED || task.order.status !== OrderStatus.CLAIMED) {
      throw conflict('TASK_STATE_CONFLICT', 'Only a claimed task can be abandoned before pickup');
    }

    await transitionOrder(tx, task.orderId, task.order.status, OrderStatus.READY_FOR_RIDER, actor, {
      eventType: OrderEventType.RIDER_ABANDONED,
      ...(reason ? { reason } : {}),
    });
    await tx.deliveryAssignment.updateMany({
      where: { taskId: task.id, riderId: actor.riderId, status: DeliveryAssignmentStatus.ACTIVE },
      data: { status: DeliveryAssignmentStatus.ABANDONED, endedAt: new Date(), ...(reason ? { reason } : {}) },
    });
    await tx.deliveryTask.update({
      where: { id: task.id },
      data: { status: DeliveryTaskStatus.OPEN, riderId: null, claimedAt: null },
    });
    return tx.deliveryTask.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
  });
}

export async function pickUpTask(
  prisma: PrismaClient,
  actor: Actor,
  taskId: string,
  evidenceId?: string,
) {
  if (!actor.riderId) throw forbidden();
  return prisma.$transaction(async (tx) => {
    const task = await tx.deliveryTask.findUnique({ where: { id: taskId }, include: { order: true } });
    if (!task) throw notFound('Delivery task');
    if (task.riderId !== actor.riderId) throw forbidden();
    if (task.status !== DeliveryTaskStatus.CLAIMED) throw conflict('TASK_STATE_CONFLICT', 'Task is not ready for pickup');

    if (task.order.pickupVerificationMode === PickupVerificationMode.PHOTO) {
      await requireEvidence(
        tx,
        evidenceId,
        task.orderId,
        actor,
        EvidenceType.RIDER_PICKUP_PHOTO,
        OrderStatus.CLAIMED,
      );
    } else if (task.order.pickupVerificationMode === PickupVerificationMode.PICKUP_CODE) {
      await requireEvidence(
        tx,
        evidenceId,
        task.orderId,
        actor,
        EvidenceType.PICKUP_CODE_VERIFICATION,
        OrderStatus.CLAIMED,
      );
    }

    await transitionOrder(tx, task.orderId, task.order.status, OrderStatus.PICKED_UP, actor, {
      eventType: OrderEventType.PICKED_UP,
    });
    await tx.deliveryTask.update({
      where: { id: task.id },
      data: { status: DeliveryTaskStatus.PICKED_UP, pickedUpAt: new Date() },
    });
    return tx.deliveryTask.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
  });
}

export async function deliverTask(
  prisma: PrismaClient,
  actor: Actor,
  taskId: string,
  input: { evidenceId?: string; code?: string },
  now = new Date(),
) {
  if (!actor.riderId) throw forbidden();
  const { config } = await loadPolicyConfig(prisma);

  return prisma.$transaction(async (tx) => {
    const task = await tx.deliveryTask.findUnique({
      where: { id: taskId },
      include: { order: { include: { pricing: true } } },
    });
    if (!task) throw notFound('Delivery task');
    if (task.riderId !== actor.riderId) throw forbidden();
    if (task.status !== DeliveryTaskStatus.PICKED_UP) throw conflict('TASK_STATE_CONFLICT', 'Task is not ready for delivery');
    if (!task.order.pricing) throw notFound('Order pricing');

    const customerUnreachable = await tx.exceptionEvent.count({
      where: {
        orderId: task.orderId,
        type: 'CUSTOMER_UNREACHABLE',
        resolvedAt: null,
      },
    });
    const unattendedFallback = customerUnreachable > 0
      && allowsUnattendedDelivery(config, task.order.deliveryMethod);

    if (task.order.deliveryVerificationMode === 'DELIVERY_PHOTO' || unattendedFallback) {
      await requireEvidence(
        tx,
        input.evidenceId,
        task.orderId,
        actor,
        EvidenceType.DELIVERY_PHOTO,
        OrderStatus.PICKED_UP,
      );
    } else {
      if (!input.code) throw conflict('VERIFICATION_CODE_REQUIRED', 'Delivery handoff code is required');
      await verifyOrderCode(tx, task.order, VerificationPurpose.DELIVERY, actor, input.code, now);
    }

    await transitionOrder(tx, task.orderId, task.order.status, OrderStatus.DELIVERED, actor, {
      eventType: OrderEventType.DELIVERED,
    });
    await tx.deliveryTask.update({
      where: { id: task.id },
      data: { status: DeliveryTaskStatus.COMPLETED, deliveredAt: now },
    });
    await tx.deliveryAssignment.updateMany({
      where: { taskId: task.id, riderId: actor.riderId, status: DeliveryAssignmentStatus.ACTIVE },
      data: { status: DeliveryAssignmentStatus.COMPLETED, endedAt: now },
    });
    await tx.settlement.update({
      where: { orderId: task.orderId },
      data: {
        status: SettlementStatus.FINALIZED,
        riderPayableMinor: task.order.pricing.riderPayoutMinor,
        merchantPayableMinor: task.order.pricing.merchantSettlementMinor,
        platformRevenueMinor: task.order.pricing.platformCommissionMinor - task.order.pricing.platformSubsidyMinor,
        finalizedAt: now,
      },
    });
    await tx.riderSettlement.create({
      data: {
        orderId: task.orderId,
        riderId: actor.riderId,
        amountMinor: task.order.pricing.riderPayoutMinor,
        status: RiderSettlementStatus.PENDING,
        pendingUntil: new Date(now.getTime() + config.riderSettlementPendingSeconds * 1000),
      },
    });
    return tx.deliveryTask.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
  });
}
