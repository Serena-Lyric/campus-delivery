import {
  ExceptionCaseActionType,
  ExceptionCaseStatus,
  ExceptionResolutionType,
  ExceptionType,
  type ExceptionEvent,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
import { requireAdminLevel, type Actor } from '../auth/auth.js';
import { conflict, forbidden, notFound } from '../shared/errors.js';
import {
  DeterministicExceptionClassifier,
  classifyExceptionSafely,
  type ExceptionClassifier,
} from '../exceptions/classifier.js';
import { assertExceptionCaseAction } from './state-machine.js';
import { resolveLinkedExceptionEvent } from '../settlements/service.js';

export async function openExceptionCase(
  tx: Prisma.TransactionClient,
  event: Pick<ExceptionEvent, 'id' | 'orderId' | 'type' | 'description'>,
  classifier: ExceptionClassifier = new DeterministicExceptionClassifier(),
) {
  const classification = await classifyExceptionSafely(classifier, { type: event.type, description: event.description });
  const exceptionCase = await tx.exceptionCase.create({
    data: {
      orderId: event.orderId,
      exceptionEventId: event.id,
      category: classification.category,
      ...(classification.subtype ? { subtype: classification.subtype } : {}),
      priority: classification.priority,
      classifierSource: classification.source,
      classifierVersion: classification.version,
      classifierResult: classification as unknown as Prisma.InputJsonValue,
      classifierConfidenceBps: classification.confidenceBps,
    },
  });
  await tx.exceptionCaseAction.createMany({
    data: [
      { caseId: exceptionCase.id, type: ExceptionCaseActionType.CREATED, reason: 'EXCEPTION_EVENT_CREATED' },
      {
        caseId: exceptionCase.id,
        type: ExceptionCaseActionType.CLASSIFIED,
        reason: classification.source,
        metadata: classification as unknown as Prisma.InputJsonValue,
      },
    ],
  });
  return exceptionCase;
}

function assertAdmin(actor: Actor) {
  requireAdminLevel(actor, ['OPERATOR', 'SUPER_ADMIN']);
}

export async function listExceptionCases(
  prisma: PrismaClient,
  actor: Actor,
  status?: ExceptionCaseStatus,
) {
  assertAdmin(actor);
  return prisma.exceptionCase.findMany({
    ...(status ? { where: { status } } : {}),
    select: {
      id: true,
      orderId: true,
      category: true,
      subtype: true,
      priority: true,
      status: true,
      currentHandlerAdminId: true,
      claimedAt: true,
      lastActionAt: true,
      version: true,
      createdAt: true,
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    take: 100,
  });
}

export async function getExceptionCaseForAdmin(prisma: PrismaClient, actor: Actor, caseId: string) {
  assertAdmin(actor);
  const value = await prisma.exceptionCase.findUnique({
    where: { id: caseId },
    select: {
      id: true,
      orderId: true,
      category: true,
      subtype: true,
      priority: true,
      status: true,
      currentHandlerAdminId: true,
      claimedAt: true,
      lastActionAt: true,
      resolutionType: true,
      resolutionNote: true,
      escalatedAt: true,
      escalationReason: true,
      version: true,
      classifierSource: true,
      classifierVersion: true,
      classifierResult: true,
      classifierConfidenceBps: true,
      createdAt: true,
      resolvedAt: true,
      exceptionEvent: {
        select: { id: true, reporterRole: true, orderStatus: true, type: true, description: true, createdAt: true },
      },
      order: {
        select: {
          preparationControlState: true,
          preparationControlVersion: true,
          preparationReportedAssignmentId: true,
          status: true,
          shortCode: true,
          customerId: true,
          merchantId: true,
          deliveryTask: { select: { riderId: true, claimedAt: true, pickedUpAt: true, deliveredAt: true } },
          pricing: {
            select: {
              itemSubtotalMinor: true,
              customerDeliveryFeeMinor: true,
              customerRefundMinor: true,
              exceptionCompensationMinor: true,
            },
          },
          events: {
            select: { id: true, eventType: true, fromStatus: true, toStatus: true, reason: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
          },
          evidences: {
            select: { id: true, evidenceType: true, actorRole: true, orderStage: true, mediaReference: true, note: true, createdAt: true },
          },
        },
      },
      actions: {
        select: { id: true, type: true, actorId: true, previousHandlerAdminId: true, nextHandlerAdminId: true, reason: true, metadata: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      },
      remakeProposal: { select: { id: true, message: true, status: true, respondedAt: true, createdAt: true } },
      pickupCustodyDispute: { select: { id: true, handoffId: true, status: true, version: true, reason: true, evidenceIds: true, catalogRiskClaim: true, merchantAcknowledgedAt: true, merchantNote: true, resolutionNote: true } },
      compensationObligation: {
        select: {
          id: true,
          requiredCompensationMinor: true,
          currentOrderReservedMinor: true,
          otherUnwithdrawnReservedMinor: true,
          riderVoluntaryPaymentMinor: true,
          platformAdvancedMinor: true,
          customerRefundMinor: true,
          outstandingMinor: true,
          status: true,
        },
      },
    },
  });
  if (!value) throw notFound('Exception case');
  return value;
}

export async function claimExceptionCase(prisma: PrismaClient, actor: Actor, caseId: string, expectedVersion: number) {
  assertAdmin(actor);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.exceptionCase.updateMany({
      where: {
        id: caseId,
        version: expectedVersion,
        currentHandlerAdminId: null,
        status: ExceptionCaseStatus.OPEN,
      },
      data: {
        currentHandlerAdminId: actor.id,
        claimedAt: new Date(),
        lastActionAt: new Date(),
        status: ExceptionCaseStatus.IN_PROGRESS,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw conflict('CASE_ALREADY_CLAIMED', 'Exception case is no longer unclaimed at this version');
    await tx.exceptionCaseAction.create({
      data: { caseId, type: ExceptionCaseActionType.CLAIMED, actorId: actor.id, nextHandlerAdminId: actor.id, reason: 'SELF_CLAIM' },
    });
    return tx.exceptionCase.findUniqueOrThrow({ where: { id: caseId } });
  });
}

export async function releaseExceptionCase(
  prisma: PrismaClient,
  actor: Actor,
  caseId: string,
  expectedVersion: number,
  reason: string,
) {
  assertAdmin(actor);
  return prisma.$transaction(async (tx) => {
    const current = await tx.exceptionCase.findUnique({ where: { id: caseId } });
    if (!current) throw notFound('Exception case');
    assertExceptionCaseAction(current.status, 'RELEASE');
    if (current.currentHandlerAdminId !== actor.id && actor.adminLevel !== 'SUPER_ADMIN') throw forbidden();
    const updated = await tx.exceptionCase.updateMany({
      where: { id: caseId, version: expectedVersion, currentHandlerAdminId: current.currentHandlerAdminId },
      data: {
        currentHandlerAdminId: null,
        claimedAt: null,
        status: ExceptionCaseStatus.OPEN,
        lastActionAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw conflict('CASE_VERSION_CONFLICT', 'Exception case changed before release');
    await tx.exceptionCaseAction.create({
      data: {
        caseId,
        type: ExceptionCaseActionType.RELEASED,
        actorId: actor.id,
        previousHandlerAdminId: current.currentHandlerAdminId,
        reason,
      },
    });
    return tx.exceptionCase.findUniqueOrThrow({ where: { id: caseId } });
  });
}

export async function escalateExceptionCase(
  prisma: PrismaClient,
  actor: Actor,
  caseId: string,
  expectedVersion: number,
  reason: string,
) {
  assertAdmin(actor);
  return prisma.$transaction(async (tx) => {
    const current = await tx.exceptionCase.findUnique({ where: { id: caseId } });
    if (!current) throw notFound('Exception case');
    assertExceptionCaseAction(current.status, 'ESCALATE');
    if (current.currentHandlerAdminId !== actor.id && actor.adminLevel !== 'SUPER_ADMIN') throw forbidden();
    const now = new Date();
    const updated = await tx.exceptionCase.updateMany({
      where: { id: caseId, version: expectedVersion },
      data: {
        status: ExceptionCaseStatus.ESCALATED,
        escalatedAt: now,
        escalationReason: reason,
        lastActionAt: now,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw conflict('CASE_VERSION_CONFLICT', 'Exception case changed before escalation');
    await tx.exceptionCaseAction.create({
      data: { caseId, type: ExceptionCaseActionType.ESCALATED, actorId: actor.id, reason },
    });
    return tx.exceptionCase.findUniqueOrThrow({ where: { id: caseId } });
  });
}

export async function takeoverExceptionCase(
  prisma: PrismaClient,
  actor: Actor,
  caseId: string,
  expectedVersion: number,
  nextHandlerAdminId: string,
  reason: string,
) {
  requireAdminLevel(actor, ['SUPER_ADMIN']);
  return prisma.$transaction(async (tx) => {
    const current = await tx.exceptionCase.findUnique({ where: { id: caseId } });
    if (!current) throw notFound('Exception case');
    assertExceptionCaseAction(current.status, 'TAKEOVER');
    const target = await tx.user.findUnique({ where: { id: nextHandlerAdminId }, include: { adminProfile: true } });
    if (!target?.adminProfile || target.role !== 'ADMIN') throw conflict('INVALID_ADMIN_HANDLER', 'Target user is not an administrator');
    if (current.status === ExceptionCaseStatus.ESCALATED && target.adminProfile.level !== 'SUPER_ADMIN') {
      throw conflict('ESCALATED_CASE_REQUIRES_SUPER_ADMIN', 'An escalated case can be assigned only to a super admin');
    }
    const now = new Date();
    const updated = await tx.exceptionCase.updateMany({
      where: { id: caseId, version: expectedVersion },
      data: {
        currentHandlerAdminId: nextHandlerAdminId,
        claimedAt: now,
        status: ExceptionCaseStatus.IN_PROGRESS,
        lastActionAt: now,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw conflict('CASE_VERSION_CONFLICT', 'Exception case changed before takeover');
    await tx.exceptionCaseAction.create({
      data: {
        caseId,
        type: ExceptionCaseActionType.TAKEN_OVER,
        actorId: actor.id,
        ...(current.currentHandlerAdminId ? { previousHandlerAdminId: current.currentHandlerAdminId } : {}),
        nextHandlerAdminId,
        reason,
      },
    });
    return tx.exceptionCase.findUniqueOrThrow({ where: { id: caseId } });
  });
}

export async function transferExceptionCase(
  prisma: PrismaClient,
  actor: Actor,
  caseId: string,
  expectedVersion: number,
  nextHandlerAdminId: string,
  reason: string,
) {
  assertAdmin(actor);
  return prisma.$transaction(async (tx) => {
    const current = await tx.exceptionCase.findUnique({ where: { id: caseId } });
    if (!current) throw notFound('Exception case');
    assertExceptionCaseAction(current.status, 'TRANSFER');
    if (current.currentHandlerAdminId !== actor.id && actor.adminLevel !== 'SUPER_ADMIN') throw forbidden();
    const target = await tx.user.findUnique({ where: { id: nextHandlerAdminId }, include: { adminProfile: true } });
    if (!target?.adminProfile || target.role !== 'ADMIN') throw conflict('INVALID_ADMIN_HANDLER', 'Target user is not an administrator');
    const updated = await tx.exceptionCase.updateMany({
      where: { id: caseId, version: expectedVersion, currentHandlerAdminId: current.currentHandlerAdminId },
      data: { currentHandlerAdminId: nextHandlerAdminId, lastActionAt: new Date(), version: { increment: 1 } },
    });
    if (updated.count !== 1) throw conflict('CASE_VERSION_CONFLICT', 'Exception case changed before transfer');
    await tx.exceptionCaseAction.create({
      data: {
        caseId,
        type: ExceptionCaseActionType.TRANSFERRED,
        actorId: actor.id,
        previousHandlerAdminId: current.currentHandlerAdminId,
        nextHandlerAdminId,
        reason,
      },
    });
    return tx.exceptionCase.findUniqueOrThrow({ where: { id: caseId } });
  });
}

export async function resolveNonEconomicCase(
  prisma: PrismaClient,
  actor: Actor,
  caseId: string,
  expectedVersion: number,
  resolutionType: Exclude<ExceptionResolutionType, 'REFUND_AND_CLOSE' | 'REMAKE_AND_CONTINUE'>,
  note: string,
) {
  assertAdmin(actor);
  return prisma.$transaction(async (tx) => {
    let current = await tx.exceptionCase.findUnique({ where: { id: caseId } });
    if (!current) throw notFound('Exception case');
    if (current.category === 'PICKUP_CUSTODY_DISPUTE') throw conflict('USE_PICKUP_DISPUTE_REVIEW', 'Resolve through the versioned pickup custody review action');
    let controlledResume = false;
    const initialOrder = await tx.order.findUniqueOrThrow({ where: { id: current.orderId } });
    if (initialOrder.preparationControlVersion > 0 || current.category === 'MERCHANT_PREPARATION_UNAVAILABLE') {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id"=${current.orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({ where: { id: current.orderId } });
      await tx.$queryRaw`SELECT "id" FROM "ExceptionCase" WHERE "id"=${caseId}::uuid FOR UPDATE`;
      current = await tx.exceptionCase.findUniqueOrThrow({ where: { id: caseId } });
      if (current.currentHandlerAdminId !== actor.id) throw forbidden();
      if (order.preparationSourceExceptionId === current.exceptionEventId && order.preparationControlState !== 'NORMAL') {
        if (current.category === 'MERCHANT_PREPARATION_UNAVAILABLE') throw conflict('PREPARATION_REVIEW_REQUIRED', 'The active preparation pause must be handled through its guarded review workflow');
        if (!['RIDER_DELIVERY_EXCEPTION', 'CUSTOMER_UNREACHABLE'].includes(current.category) || !['CONTINUE_FULFILLMENT', 'WAITING_FOR_INFORMATION'].includes(resolutionType)) throw conflict('CONTROLLED_FULFILLMENT_DECISION_REQUIRED', 'The paused delivery requires an explicit continuation or further information; no automatic termination');
        controlledResume = resolutionType === 'CONTINUE_FULFILLMENT';
      }
    }
    assertExceptionCaseAction(current.status, 'RESOLVE');
    if (current.currentHandlerAdminId !== actor.id && actor.adminLevel !== 'SUPER_ADMIN') throw forbidden();
    if (resolutionType === ExceptionResolutionType.ESCALATED_OTHER) {
      throw conflict('USE_ESCALATION_ACTION', 'Escalation must use the audited escalate action');
    }
    if (
      resolutionType === ExceptionResolutionType.CONTINUE_FULFILLMENT
      && (
        current.category === ExceptionType.SEVERE_FOOD_DAMAGE
        || current.category === ExceptionType.FOOD_LOST
      )
    ) {
      throw conflict(
        'SEVERE_REMAKE_CONFIRMATION_REQUIRED',
        'Severe damage or loss can continue only after the customer accepts a remake',
      );
    }
    const waiting = resolutionType === ExceptionResolutionType.WAITING_FOR_INFORMATION;
    const now = new Date();
    const updated = await tx.exceptionCase.updateMany({
      where: { id: caseId, version: expectedVersion },
      data: {
        status: waiting ? ExceptionCaseStatus.WAITING_FOR_PARTICIPANT : ExceptionCaseStatus.RESOLVED,
        resolutionType,
        resolutionNote: note,
        lastActionAt: now,
        ...(!waiting ? { resolvedAt: now } : {}),
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw conflict('CASE_VERSION_CONFLICT', 'Exception case changed before resolution');
    if (controlledResume) {
      if (await tx.exceptionCase.count({ where: { orderId: current.orderId, id: { not: caseId }, status: { notIn: ['RESOLVED', 'CLOSED'] } } })) throw conflict('OTHER_EXCEPTION_UNRESOLVED', 'Other current conflicts must be reviewed before continuation');
      const order = await tx.order.findUniqueOrThrow({ where: { id: current.orderId } });
      await tx.order.update({ where: { id: current.orderId }, data: { preparationControlState: 'NORMAL', preparationControlVersion: { increment: 1 }, preparationControlUpdatedAt: now } });
      await tx.preparationControlAudit.create({ data: { orderId: current.orderId, version: order.preparationControlVersion + 1, action: 'HANDLER_CONTINUE_DELIVERY',
        previousState: order.preparationControlState, newState: 'NORMAL', actorId: actor.id, payloadSignature: caseId, createdAt: now } });
    }
    if (!waiting) await resolveLinkedExceptionEvent(tx, current, now);
    await tx.exceptionCaseAction.create({
      data: {
        caseId,
        type: waiting ? ExceptionCaseActionType.REQUESTED_INFORMATION : ExceptionCaseActionType.RESOLVED,
        actorId: actor.id,
        reason: note,
        metadata: { resolutionType },
      },
    });
    return tx.exceptionCase.findUniqueOrThrow({ where: { id: caseId } });
  });
}
