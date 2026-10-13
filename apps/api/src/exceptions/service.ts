import {
  DeliveryAssignmentStatus,
  DeliveryTaskStatus,
  ExceptionType,
  OrderEventType,
  OrderStatus,
  RiderSettlementStatus,
  type PrismaClient,
} from '@prisma/client';
import type { Actor } from '../auth/auth.js';
import { allowsUnattendedDelivery, loadPolicyConfig } from '../merchant-policy/policies.js';
import { assertOrderAccess } from '../orders/access.js';
import { transitionOrder } from '../orders/state-machine.js';
import { badRequest, conflict, forbidden, notFound } from '../shared/errors.js';
import { assertNoPickupDispute } from '../delivery/custody-guard.js';
import { openExceptionCase } from '../exception-cases/service.js';
import { DeterministicExceptionClassifier, type ExceptionClassifier } from './classifier.js';

export type CreateExceptionInput = {
  type: ExceptionType;
  description: string;
  evidenceIds?: string[];
};

const severeTypes: ExceptionType[] = [ExceptionType.SEVERE_FOOD_DAMAGE, ExceptionType.FOOD_LOST];

export async function createExceptionEvent(
  prisma: PrismaClient,
  actor: Actor,
  orderId: string,
  input: CreateExceptionInput,
  classifier: ExceptionClassifier = new DeterministicExceptionClassifier(),
) {
  if (input.type === 'GOODS_CHANGE_OBJECTION') throw conflict('USE_BOUND_GOODS_REPORT', 'Goods objections require the current assignment and goods-change version');
  if (input.type === 'MERCHANT_PREPARATION_UNAVAILABLE') throw conflict('USE_BOUND_PREPARATION_REPORT', 'Preparation unavailability needs the current assignment and workflow version');
  if (input.type === ExceptionType.PICKUP_CUSTODY_DISPUTE) throw conflict('PICKUP_DISPUTE_REQUIRES_DEDICATED_ROUTE', 'Report custody disputes through the current task and handoff');
  if (input.type === ExceptionType.PICKUP_EVIDENCE_UNAVAILABLE) {
    throw conflict('PICKUP_EXCEPTION_REQUIRES_DEDICATED_ROUTE', 'Report pickup evidence unavailable through the bound delivery task route');
  }
  if (severeTypes.includes(input.type)) {
    throw conflict(
      'SEVERE_EXCEPTION_REQUIRES_DEDICATED_ROUTE',
      'Severe damage or loss must be reported by the responsible rider through the dedicated route after pickup',
    );
  }
  return createExceptionEventInternal(prisma, actor, orderId, input, classifier, false);
}

export async function createSevereRiderExceptionEvent(
  prisma: PrismaClient,
  actor: Actor,
  orderId: string,
  input: CreateExceptionInput,
  classifier: ExceptionClassifier = new DeterministicExceptionClassifier(),
) {
  if (!actor.riderId || !severeTypes.includes(input.type)) throw forbidden();
  return createExceptionEventInternal(prisma, actor, orderId, input, classifier, true);
}

async function createExceptionEventInternal(
  prisma: PrismaClient,
  actor: Actor,
  orderId: string,
  input: CreateExceptionInput,
  classifier: ExceptionClassifier,
  severeRiderReport: boolean,
) {
  const { config } = await loadPolicyConfig(prisma);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
    const taskIdentity = await tx.deliveryTask.findUnique({
        where: { orderId },
        select: { id: true },
      });
    if (taskIdentity) {
      await tx.$queryRaw`SELECT "id" FROM "DeliveryTask" WHERE "id" = ${taskIdentity.id}::uuid FOR UPDATE`;
    }
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        deliveryTask: true,
        assignments: { select: { riderId: true } },
      },
    });
    if (!order) throw notFound('Order');
    assertOrderAccess(actor, order);
    await assertNoPickupDispute(tx, order.id);

    if (
      severeRiderReport
      && (
        !order.deliveryTask
        || order.deliveryTask.riderId !== actor.riderId
        || order.deliveryTask.status !== DeliveryTaskStatus.PICKED_UP
      )
    ) {
      throw conflict(
        'SEVERE_EXCEPTION_STAGE_INVALID',
        'Severe damage or loss can be reported only by the responsible rider after pickup',
      );
    }

    if (
      input.type === ExceptionType.CUSTOMER_UNREACHABLE
      && actor.role !== 'RIDER'
      && actor.role !== 'ADMIN'
    ) {
      throw forbidden();
    }

    const evidenceIds = [...new Set(input.evidenceIds ?? [])];
    if (evidenceIds.length > 0) {
      const count = await tx.evidence.count({ where: { id: { in: evidenceIds }, orderId: order.id } });
      if (count !== evidenceIds.length) {
        throw badRequest('INVALID_EVIDENCE', 'Every linked evidence item must belong to this order');
      }
    }

    const exception = await tx.exceptionEvent.create({
      data: {
        orderId: order.id,
        reporterId: actor.id,
        reporterRole: actor.role,
        orderStatus: order.status,
        type: input.type,
        description: input.description,
      },
    });
    if (input.type !== ExceptionType.WRONG_ADDRESS) {
      await openExceptionCase(tx, exception, classifier);
    }
    if (evidenceIds.length > 0) {
      await tx.evidence.updateMany({
        where: { id: { in: evidenceIds }, orderId: order.id },
        data: { exceptionEventId: exception.id },
      });
    }

    if (input.type === ExceptionType.DELIVERY_DISPUTE) {
      const settlement = await tx.riderSettlement.findUnique({ where: { orderId: order.id } });
      if (settlement) {
        await tx.$queryRaw`SELECT "id" FROM "RiderSettlement" WHERE "id" = ${settlement.id}::uuid FOR UPDATE`;
        await tx.riderSettlement.updateMany({
          where: {
            id: settlement.id,
            status: { in: [RiderSettlementStatus.PENDING, RiderSettlementStatus.AVAILABLE] },
          },
          data: {
            status: RiderSettlementStatus.HELD,
            heldAt: new Date(),
            holdReason: ExceptionType.DELIVERY_DISPUTE,
          },
        });
      }
    }

    const stopsDelivery = (
      input.type === ExceptionType.CUSTOMER_UNREACHABLE
      && !allowsUnattendedDelivery(config, order.deliveryMethod)
    ) || input.type === ExceptionType.RIDER_DELIVERY_EXCEPTION;

    if (stopsDelivery && (order.preparationControlVersion > 0 || order.goodsChangeVersion > 0) && !['DELIVERED', 'CANCELLED', 'EXCEPTION', 'NO_RIDER_ACCEPTED'].includes(order.status)) {
      const now = new Date();
      const sourceId = order.preparationControlState === 'NORMAL' ? exception.id : order.preparationSourceExceptionId ?? exception.id;
      await tx.order.update({ where: { id: order.id }, data: { preparationControlState: 'MANUAL_REVIEW', preparationControlVersion: { increment: 1 },
        preparationControlUpdatedAt: now, preparationSourceExceptionId: sourceId } });
      await tx.preparationControlAudit.create({ data: { orderId: order.id, version: order.preparationControlVersion + 1, action: 'DELIVERY_EXCEPTION_PAUSED',
        previousState: order.preparationControlState, newState: 'MANUAL_REVIEW', actorId: actor.id, payloadSignature: exception.id, createdAt: now } });
      await tx.orderEvent.create({ data: { orderId: order.id, eventType: 'EXCEPTION_RECORDED', actorType: 'USER', fromStatus: order.status, toStatus: order.status,
        operatorId: actor.id, operatorRole: actor.role, metadata: { action: 'DELIVERY_EXCEPTION_PAUSED', exceptionEventId: exception.id, automaticTermination: false, fundsChanged: false }, createdAt: now } });
    }

    if (
      stopsDelivery
      && order.preparationControlVersion === 0
      && order.goodsChangeVersion === 0
      && order.status !== OrderStatus.DELIVERED
      && order.status !== OrderStatus.CANCELLED
      && order.status !== OrderStatus.EXCEPTION
    ) {
      await transitionOrder(tx, order.id, order.status, OrderStatus.EXCEPTION, actor, {
        eventType: OrderEventType.EXCEPTION_RECORDED,
        reason: input.description,
        metadata: { exceptionEventId: exception.id, exceptionType: input.type },
      });
      if (order.deliveryTask) {
        await tx.deliveryTask.update({
          where: { id: order.deliveryTask.id },
          data: { status: DeliveryTaskStatus.EXCEPTION },
        });
        await tx.deliveryAssignment.updateMany({
          where: { taskId: order.deliveryTask.id, status: DeliveryAssignmentStatus.ACTIVE },
          data: { status: DeliveryAssignmentStatus.EXCEPTION, endedAt: new Date(), reason: input.type, temporaryPersonalCapacityRelease: false },
        });
      }
    }

    return tx.exceptionEvent.findUniqueOrThrow({
      where: { id: exception.id },
      include: { evidences: true },
    });
  });
}
