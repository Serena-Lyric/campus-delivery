import {
  ClaimSampleType,
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
import { assertRiderCanClaim } from '../riders/restrictions.js';

const taskSelect = {
  id: true,
  orderId: true,
  status: true,
  payoutMinor: true,
  firstPublishedAt: true,
  claimDeadline: true,
  claimedAt: true,
  pickedUpAt: true,
  deliveredAt: true,
  createdAt: true,
  updatedAt: true,
  order: {
    select: {
      id: true,
      shortCode: true,
      status: true,
      destinationLabelSnapshot: true,
      deliveryMethod: true,
      merchantPreparationStatus: true,
      merchant: { select: { id: true, name: true } },
      destinationLocation: { select: { id: true, name: true, type: true } },
    },
  },
} satisfies Prisma.DeliveryTaskSelect;

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
    where: {
      status: DeliveryTaskStatus.OPEN,
      riderId: null,
      claimDeadline: { gt: new Date() },
    },
    select: taskSelect,
    orderBy: { createdAt: 'asc' },
    take: limit,
    skip: offset,
  });
}

export function listRiderTasks(prisma: PrismaClient, actor: Actor, limit: number, offset: number) {
  if (!actor.riderId) throw forbidden();
  return prisma.deliveryTask.findMany({
    where: { assignments: { some: { riderId: actor.riderId } } },
    select: taskSelect,
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });
}

export async function claimTask(
  prisma: PrismaClient,
  actor: Actor,
  taskId: string,
  now = new Date(),
) {
  if (!actor.riderId) throw forbidden();
  const riderId = actor.riderId;
  const { config } = await loadPolicyConfig(prisma);

  return prisma.$transaction(async (tx) => {
    const taskIdentity = await tx.deliveryTask.findUnique({
      where: { id: taskId },
      select: { orderId: true },
    });
    if (!taskIdentity) throw notFound('Delivery task');
    await tx.$queryRaw`SELECT "id" FROM "Rider" WHERE "id" = ${riderId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${taskIdentity.orderId}::uuid FOR UPDATE`;
    const rider = await tx.rider.findUnique({ where: { id: riderId } });
    if (!rider || rider.status !== 'AVAILABLE') throw conflict('RIDER_UNAVAILABLE', 'Rider is not available to claim tasks');
    await assertRiderCanClaim(tx, riderId, now);

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

    await tx.$queryRaw`SELECT "id" FROM "DeliveryTask" WHERE "id" = ${taskId}::uuid FOR UPDATE`;
    const task = await tx.deliveryTask.findUnique({
      where: { id: taskId },
      include: { order: { include: { pricing: true } } },
    });
    if (!task) throw notFound('Delivery task');
    if (
      task.status !== DeliveryTaskStatus.OPEN
      || task.riderId
      || !task.firstPublishedAt
      || !task.claimDeadline
      || now >= task.claimDeadline
    ) {
      throw conflict('TASK_NOT_CLAIMABLE', 'Delivery task is no longer claimable');
    }
    if (!task.order.pricing) throw notFound('Order pricing');

    const claimed = await tx.deliveryTask.updateMany({
      where: {
        id: taskId,
        status: DeliveryTaskStatus.OPEN,
        riderId: null,
        claimDeadline: { gt: now },
      },
      data: { status: DeliveryTaskStatus.CLAIMED, riderId, claimedAt: now },
    });
    if (claimed.count !== 1) throw conflict('TASK_ALREADY_CLAIMED', 'Delivery task is no longer available');

    await transitionOrder(tx, task.orderId, task.order.status, OrderStatus.CLAIMED, actor, {
      eventType: OrderEventType.RIDER_CLAIMED,
    });
    const pricing = task.order.pricing;
    const claimLatencySeconds = Math.max(
      0,
      Math.floor((now.getTime() - task.firstPublishedAt.getTime()) / 1000),
    );
    await tx.deliveryAssignment.create({
      data: {
        taskId: task.id,
        orderId: task.orderId,
        riderId,
        claimedAt: now,
        merchantQuoteMinorAtClaim: pricing.merchantDeliveryContributionMinor,
        customerTipMinorAtClaim: pricing.customerRiderTipMinor,
        platformSubsidyMinorAtClaim: pricing.platformSubsidyMinor,
        riderPayoutMinorAtClaim: pricing.riderPayoutMinor,
        quoteVersionAtClaim: pricing.merchantQuoteVersion,
        claimSampleType: pricing.platformSubsidyMinor > 0
          ? ClaimSampleType.SUBSIDIZED
          : ClaimSampleType.NATURAL,
        claimLatencySeconds,
      },
    });
    return tx.deliveryTask.findUniqueOrThrow({ where: { id: taskId }, select: taskSelect });
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
    const taskIdentity = await tx.deliveryTask.findUnique({ where: { id: taskId }, select: { orderId: true } });
    if (!taskIdentity) throw notFound('Delivery task');
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${taskIdentity.orderId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "DeliveryTask" WHERE "id" = ${taskId}::uuid FOR UPDATE`;
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
    return tx.deliveryTask.findUniqueOrThrow({ where: { id: task.id }, select: taskSelect });
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
    const taskIdentity = await tx.deliveryTask.findUnique({ where: { id: taskId }, select: { orderId: true } });
    if (!taskIdentity) throw notFound('Delivery task');
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${taskIdentity.orderId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "DeliveryTask" WHERE "id" = ${taskId}::uuid FOR UPDATE`;
    const task = await tx.deliveryTask.findUnique({
      where: { id: taskId },
      include: { order: { include: { pricing: true } } },
    });
    if (!task) throw notFound('Delivery task');
    if (task.riderId !== actor.riderId) throw forbidden();
    if (task.status !== DeliveryTaskStatus.PICKED_UP) throw conflict('TASK_STATE_CONFLICT', 'Task is not ready for delivery');
    if (!task.order.pricing) throw notFound('Order pricing');

    const severeCase = await tx.exceptionCase.findFirst({
      where: { orderId: task.orderId, category: { in: ['SEVERE_FOOD_DAMAGE', 'FOOD_LOST'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (
      severeCase
      && !(
        severeCase.status === 'RESOLVED'
        && ['REMAKE_AND_CONTINUE', 'CONTINUE_FULFILLMENT'].includes(severeCase.resolutionType ?? '')
      )
    ) {
      throw conflict('SEVERE_EXCEPTION_UNRESOLVED', 'Severe damage or loss must be resolved before delivery can continue');
    }

    const customerUnreachable = await tx.exceptionEvent.count({
      where: {
        orderId: task.orderId,
        type: 'CUSTOMER_UNREACHABLE',
        resolvedAt: null,
      },
    });
    const unattendedFallback = customerUnreachable > 0
      && allowsUnattendedDelivery(config, task.order.deliveryMethod);

    if (task.order.deliveryVerificationMode === 'HANDOFF_CODE' && !unattendedFallback) {
      if (!input.code) throw conflict('VERIFICATION_CODE_REQUIRED', 'Delivery handoff code is required');
      await verifyOrderCode(tx, task.order, VerificationPurpose.DELIVERY, actor, input.code, now);
    } else if (task.order.deliveryEvidenceRequired || unattendedFallback) {
      await requireEvidence(
        tx,
        input.evidenceId,
        task.orderId,
        actor,
        EvidenceType.DELIVERY_PHOTO,
        OrderStatus.PICKED_UP,
      );
    } else if (input.evidenceId) {
      await requireEvidence(
        tx,
        input.evidenceId,
        task.orderId,
        actor,
        EvidenceType.DELIVERY_PHOTO,
        OrderStatus.PICKED_UP,
      );
    }

    await transitionOrder(tx, task.orderId, task.order.status, OrderStatus.DELIVERED, actor, {
      eventType: OrderEventType.DELIVERED,
    });
    await tx.deliveryTask.update({
      where: { id: task.id },
      data: { status: DeliveryTaskStatus.COMPLETED, deliveredAt: now },
    });
    const assignment = await tx.deliveryAssignment.findFirst({
      where: { taskId: task.id, riderId: actor.riderId, status: DeliveryAssignmentStatus.ACTIVE },
      orderBy: { claimedAt: 'desc' },
    });
    if (!assignment) throw notFound('Delivery assignment');
    const finalRiderPayoutMinor = assignment.riderPayoutMinorAtClaim + assignment.postClaimTipMinor;
    await tx.deliveryAssignment.update({
      where: { id: assignment.id },
      data: { status: DeliveryAssignmentStatus.COMPLETED, endedAt: now },
    });
    await tx.settlement.update({
      where: { orderId: task.orderId },
      data: {
        status: SettlementStatus.FINALIZED,
        riderPayableMinor: finalRiderPayoutMinor,
        merchantPayableMinor: task.order.pricing.merchantSettlementMinor,
        platformRevenueMinor: task.order.pricing.platformCommissionMinor - task.order.pricing.platformSubsidyMinor,
        finalizedAt: now,
      },
    });
    await tx.riderSettlement.create({
      data: {
        orderId: task.orderId,
        riderId: actor.riderId,
        amountMinor: finalRiderPayoutMinor,
        status: RiderSettlementStatus.PENDING,
        pendingUntil: new Date(
          now.getTime()
          + (task.riderSettlementPendingSeconds ?? config.riderSettlementPendingSeconds) * 1000,
        ),
      },
    });
    return tx.deliveryTask.findUniqueOrThrow({ where: { id: task.id }, select: taskSelect });
  });
}
