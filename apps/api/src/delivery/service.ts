import {
  ClaimSampleType,
  DeliveryAssignmentStatus,
  DeliveryTaskStatus,
  EvidenceType,
  OrderEventType,
  OrderStatus,
  ExceptionType,
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
import { openExceptionCase } from '../exception-cases/service.js';
import { recordFirstNormalDelivery, resolveRiderCapacity } from '../riders/capacity.js';
import { requireRider } from '../riders/blocklist.js';
import { assertNoPickupDispute } from './custody-guard.js';

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
  assignments: { where: { status: DeliveryAssignmentStatus.ACTIVE }, select: { id: true, riderId: true } },
  order: {
    select: {
      id: true,
      shortCode: true,
      status: true,
      destinationLabelSnapshot: true,
      destinationRegionSnapshot: true,
      pickupMerchantNameSnapshot: true,
      pickupLocationNameSnapshot: true,
      pickupRegionSnapshot: true,
      deliveryMethod: true,
      merchantPreparationStatus: true,
      pickupRiskRevision: true,
      pickupHandoffRevision: true,
      pickupHandoffs: { select: { id: true, assignmentId: true, revision: true, eventId: true, createdAt: true, dispute: { select: { id: true, caseId: true, status: true, version: true, merchantAcknowledgedAt: true } } }, orderBy: { revision: 'desc' }, take: 1 },
      coreFragileValueMinor: true,
      pickupEvidenceLevel: true,
      pickupEvidencePolicyVersion: true,
      pickupVerificationMode: true,
      merchantId: true,
      destinationLocationId: true,
      items: {
        select: {
          deliveryCategoryCodeSnapshot: true,
          deliveryCategoryNameSnapshot: true,
          deliveryCategoryVersionSnapshot: true,
          deliveryRiskTagsSnapshot: true,
          coreFragileSnapshot: true,
          deliveryClassificationReviewRequired: true,
          suggestedFoodType: true,
          handlingTags: true,
          quantity: true,
        },
      },
    },
  },
} satisfies Prisma.DeliveryTaskSelect;

type RiderTask = Prisma.DeliveryTaskGetPayload<{ select: typeof taskSelect }>;

function presentRiderTask(task: RiderTask, actor?: Actor) {
  const activeAssignmentId = task.assignments.find((assignment) => assignment.riderId === actor?.riderId)?.id;
  const latestHandoff = task.order.pickupHandoffs[0];
  const handoff = latestHandoff?.assignmentId === activeAssignmentId ? latestHandoff ?? null : null;
  const totalQuantity = task.order.items.reduce((sum, item) => sum + item.quantity, 0);
  return {
    id: task.id,
    orderId: task.orderId,
    activeAssignmentId,
    pickupProtocol: { confirmationBy: 'MERCHANT', revision: task.order.pickupHandoffRevision, handoff, canDisputePickup: task.status === 'PICKED_UP' && handoff?.revision === task.order.pickupHandoffRevision },
    status: task.status,
    riderGuaranteedPayoutMinor: task.payoutMinor,
    firstPublishedAt: task.firstPublishedAt,
    claimDeadline: task.claimDeadline,
    claimedAt: task.claimedAt,
    pickedUpAt: task.pickedUpAt,
    deliveredAt: task.deliveredAt,
    pickup: {
      merchantId: task.order.merchantId,
      merchantName: task.order.pickupMerchantNameSnapshot,
      locationName: task.order.pickupLocationNameSnapshot,
      region: task.order.pickupRegionSnapshot,
    },
    destination: {
      label: task.order.destinationLabelSnapshot,
      region: task.order.destinationRegionSnapshot,
      locationId: task.order.destinationLocationId,
    },
    carrying: {
      totalQuantity,
      lineItemCount: task.order.items.length,
      foodTypes: [...new Set(task.order.items.map((item) => item.suggestedFoodType))],
      handlingTags: [...new Set(task.order.items.flatMap((item) => item.handlingTags))],
    },
    pickupRisk: {
      revision: task.order.pickupRiskRevision,
      coreFragileValueMinor: task.order.coreFragileValueMinor,
      evidenceLevel: task.order.pickupEvidenceLevel,
      policyVersion: task.order.pickupEvidencePolicyVersion,
      originalVerificationMode: task.order.pickupVerificationMode,
      mediaValidation: 'MOCK_REFERENCE_ONLY',
      categories: task.order.items.map((item) => ({
        code: item.deliveryCategoryCodeSnapshot,
        name: item.deliveryCategoryNameSnapshot,
        version: item.deliveryCategoryVersionSnapshot,
        riskTags: item.deliveryRiskTagsSnapshot,
        coreFragile: item.coreFragileSnapshot,
        reviewRequired: item.deliveryClassificationReviewRequired,
      })),
    },
    preparationStatus: task.order.merchantPreparationStatus,
    orderStatus: task.order.status,
    shortCode: task.order.shortCode,
  };
}

async function requireEvidence(
  tx: Prisma.TransactionClient,
  evidenceId: string | undefined,
  orderId: string,
  actor: Actor,
  expectedType: EvidenceType,
  stage: OrderStatus,
  notBefore?: Date,
) {
  if (!evidenceId) throw conflict('EVIDENCE_REQUIRED', `${expectedType} evidence is required`);
  const evidence = await tx.evidence.findFirst({
    where: {
      id: evidenceId,
      orderId,
      actorId: actor.id,
      actorRole: actor.role,
      ...(notBefore ? { createdAt: { gte: notBefore } } : {}),
      evidenceType: expectedType,
      orderStage: stage,
    },
  });
  if (!evidence) throw conflict('INVALID_EVIDENCE', 'Evidence does not match this order, actor, type, and stage');
  return evidence;
}

export async function listAvailableTasks(prisma: PrismaClient, actor: Actor, limit: number, offset: number) {
  const riderId = requireRider(actor);
  const tasks = await prisma.deliveryTask.findMany({
    where: {
      status: DeliveryTaskStatus.OPEN,
      riderId: null,
      claimDeadline: { gt: new Date() },
      order: { merchant: { blockedBy: { none: { riderId } } } },
    },
    select: taskSelect,
    orderBy: { createdAt: 'asc' },
    take: limit,
    skip: offset,
  });
  return tasks.map((task) => presentRiderTask(task));
}

export async function listRiderTasks(prisma: PrismaClient, actor: Actor, limit: number, offset: number) {
  if (!actor.riderId) throw forbidden();
  const tasks = await prisma.deliveryTask.findMany({
    where: { assignments: { some: { riderId: actor.riderId } } },
    select: taskSelect,
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });
  return tasks.map((task) => presentRiderTask(task, actor));
}

export async function claimTask(
  prisma: PrismaClient,
  actor: Actor,
  taskId: string,
  now = new Date(),
  campusTimeZone = 'Asia/Shanghai',
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
    const capacity = await resolveRiderCapacity(tx, riderId, config, campusTimeZone, now);

    const activeCount = await tx.deliveryTask.count({
      where: {
        riderId,
        status: { in: [DeliveryTaskStatus.CLAIMED, DeliveryTaskStatus.PICKED_UP] },
      },
    });
    if (activeCount >= capacity.effectiveCapacity) {
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
    if (await tx.riderBlockedMerchant.findUnique({ where: { riderId_merchantId: { riderId, merchantId: task.order.merchantId } } })) {
      throw conflict('MERCHANT_BLOCKED', 'Unblock this merchant before claiming its orders');
    }

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
        merchantQuoteMinorAtClaim: 0,
        customerTipMinorAtClaim: pricing.customerRiderTipMinor,
        platformSubsidyMinorAtClaim: pricing.platformSubsidyMinor,
        riderPayoutMinorAtClaim: pricing.riderGuaranteedPayoutMinor,
        riderGuaranteedPayoutMinorAtClaim: pricing.riderGuaranteedPayoutMinor,
        quoteVersionAtClaim: pricing.merchantRescueContributionVersion,
        customerDeliveryFeeMinorAtClaim: pricing.customerDeliveryFeeMinor,
        riderBasePayoutMinorAtClaim: pricing.riderBasePayoutMinor,
        merchantRescueContributionMinorAtClaim: pricing.merchantRescueContributionMinor,
        deliveryPlatformContributionMinorAtClaim: pricing.deliveryPlatformContributionMinor,
        pricingPolicyVersionAtClaim: pricing.pricingPolicyVersion,
        pricingInputsSnapshotAtClaim: pricing.pricingInputsSnapshot ?? {},
        claimSampleType: pricing.platformSubsidyMinor > 0
          ? ClaimSampleType.SUBSIDIZED
          : ClaimSampleType.NATURAL,
        claimLatencySeconds,
      },
    });
    return presentRiderTask(await tx.deliveryTask.findUniqueOrThrow({ where: { id: taskId }, select: taskSelect }), actor);
  });
}

export async function pickUpTask(
  _prisma: PrismaClient, actor: Actor, _taskId: string, _evidenceId?: string, _pickupPhotoEvidenceId?: string,
) {
  if (actor.role !== 'RIDER' || !actor.riderId) throw forbidden();
  throw conflict('MERCHANT_PICKUP_CONFIRMATION_REQUIRED', 'Pickup must be confirmed by the merchant using the current assignment; this rider endpoint is retired');
}

export async function deliverTask(
  prisma: PrismaClient,
  actor: Actor,
  taskId: string,
  input: { evidenceId?: string; code?: string },
  now = new Date(),
  campusTimeZone = 'Asia/Shanghai',
  afterLocks?: () => Promise<void>,
) {
  if (!actor.riderId) throw forbidden();
  const { config } = await loadPolicyConfig(prisma);

  return prisma.$transaction(async (tx) => {
    const taskIdentity = await tx.deliveryTask.findUnique({ where: { id: taskId }, select: { orderId: true } });
    if (!taskIdentity) throw notFound('Delivery task');
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${taskIdentity.orderId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "DeliveryTask" WHERE "id" = ${taskId}::uuid FOR UPDATE`;
    if (afterLocks) await afterLocks();
    const task = await tx.deliveryTask.findUnique({
      where: { id: taskId },
      include: { order: { include: { pricing: true } } },
    });
    if (!task) throw notFound('Delivery task');
    if (task.riderId !== actor.riderId) throw forbidden();
    if (task.status !== DeliveryTaskStatus.PICKED_UP) throw conflict('TASK_STATE_CONFLICT', 'Task is not ready for delivery');
    await assertNoPickupDispute(tx, task.orderId);
    if (!task.order.pricing) throw notFound('Order pricing');

    const severeCases = await tx.exceptionCase.findMany({
      where: { orderId: task.orderId, category: { in: ['SEVERE_FOOD_DAMAGE', 'FOOD_LOST'] } },
      select: { status: true, resolutionType: true },
    });
    const hasBlockingSevereCase = severeCases.some((exceptionCase) => !(
      exceptionCase.status === 'RESOLVED'
      && exceptionCase.resolutionType === 'REMAKE_AND_CONTINUE'
    ));
    if (hasBlockingSevereCase) {
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
    const finalRiderPayoutMinor = assignment.riderGuaranteedPayoutMinorAtClaim + assignment.postClaimTipMinor;
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
        platformRevenueMinor: task.order.pricing.platformCommissionMinor
          + task.order.pricing.deliveryPlatformContributionMinor,
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
    await recordFirstNormalDelivery(tx, actor.riderId, now, campusTimeZone);
    return presentRiderTask(await tx.deliveryTask.findUniqueOrThrow({ where: { id: task.id }, select: taskSelect }), actor);
  });
}

// Records inability to collect evidence; no role receives a pickup waiver here.
export async function reportPickupEvidenceUnavailable(prisma: PrismaClient, actor: Actor, taskId: string, reason: string) {
  if (actor.role !== 'RIDER' || !actor.riderId) throw forbidden();
  return prisma.$transaction(async (tx) => {
    const identity = await tx.deliveryTask.findUnique({ where: { id: taskId }, select: { orderId: true } });
    if (!identity) throw notFound('Delivery task');
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${identity.orderId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "DeliveryTask" WHERE "id" = ${taskId}::uuid FOR UPDATE`;
    const task = await tx.deliveryTask.findUniqueOrThrow({ where: { id: taskId }, include: { order: true } });
    if (task.riderId !== actor.riderId) throw forbidden();
    if (task.status !== 'CLAIMED' || task.order.pickupEvidenceLevel !== 'REQUIRED') throw conflict('PICKUP_REPORT_NOT_ALLOWED', 'Required pickup evidence can only be reported unavailable before pickup');
    const existing = await tx.exceptionEvent.findFirst({ where: { orderId: task.orderId, reporterId: actor.id, type: ExceptionType.PICKUP_EVIDENCE_UNAVAILABLE, createdAt: { gte: task.claimedAt! } }, select: { id: true } });
    if (existing) return { exceptionEventId: existing.id, pickupBlockedWithoutPhoto: true };
    const event = await tx.exceptionEvent.create({ data: { orderId: task.orderId, reporterId: actor.id, reporterRole: actor.role, orderStatus: task.order.status, type: ExceptionType.PICKUP_EVIDENCE_UNAVAILABLE, description: reason } });
    await openExceptionCase(tx, event);
    await tx.orderEvent.create({ data: { orderId: task.orderId, eventType: 'EXCEPTION_RECORDED', actorType: 'USER', operatorId: actor.id, operatorRole: actor.role, fromStatus: task.order.status, toStatus: task.order.status, reason, metadata: { exceptionEventId: event.id, pickupEvidenceWaived: false } } });
    return { exceptionEventId: event.id, pickupBlockedWithoutPhoto: true };
  });
}
