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
import { badRequest, forbidden, notFound } from '../shared/errors.js';
import { openExceptionCase } from '../exception-cases/service.js';

export type CreateExceptionInput = {
  type: ExceptionType;
  description: string;
  evidenceIds?: string[];
};

export async function createExceptionEvent(
  prisma: PrismaClient,
  actor: Actor,
  orderId: string,
  input: CreateExceptionInput,
) {
  const { config } = await loadPolicyConfig(prisma);
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        deliveryTask: true,
        assignments: { select: { riderId: true } },
      },
    });
    if (!order) throw notFound('Order');
    assertOrderAccess(actor, order);

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
    await openExceptionCase(tx, exception);
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

    if (
      stopsDelivery
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
          data: { status: DeliveryAssignmentStatus.EXCEPTION, endedAt: new Date(), reason: input.type },
        });
      }
    }

    return tx.exceptionEvent.findUniqueOrThrow({
      where: { id: exception.id },
      include: { evidences: true },
    });
  });
}
