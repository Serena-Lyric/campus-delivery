import {
  CompensationFundingSource,
  CompensationStatus,
  DeliveryAssignmentStatus,
  DeliveryTaskStatus,
  ExceptionCaseActionType,
  ExceptionCaseStatus,
  ExceptionResolutionType,
  ExceptionType,
  OrderEventActorType,
  OrderEventType,
  OrderStatus,
  Prisma,
  RiderSettlementStatus,
  type PrismaClient,
} from '@prisma/client';
import { requireAdminLevel, type Actor } from '../auth/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../shared/errors.js';
import { assertExceptionCaseAction } from '../exception-cases/state-machine.js';

function assertMinor(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw badRequest('INVALID_MONEY', `${name} must be a non-negative integer`);
}

export async function refundAndCloseExceptionCase(
  prisma: PrismaClient,
  actor: Actor,
  caseId: string,
  input: { expectedVersion: number; idempotencyKey: string; voluntaryPaymentMinor?: number; reason: string },
  now = new Date(),
) {
  const voluntaryPaymentMinor = input.voluntaryPaymentMinor ?? 0;
  assertMinor(voluntaryPaymentMinor, 'voluntaryPaymentMinor');
  if (voluntaryPaymentMinor > 0) {
    throw badRequest(
      'VOLUNTARY_PAYMENT_UNFUNDED',
      'Non-zero voluntary payment requires a verified funding source and is not currently available',
    );
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ExceptionCase" WHERE "id" = ${caseId}::uuid FOR UPDATE`;
    const exceptionCase = await tx.exceptionCase.findUnique({
      where: { id: caseId },
      include: {
        compensationObligation: { include: { allocations: true } },
        order: {
          include: {
            pricing: true,
            deliveryTask: { include: { assignments: { orderBy: { claimedAt: 'desc' } } } },
          },
        },
      },
    });
    if (!exceptionCase) throw notFound('Exception case');
    const task = exceptionCase.order.deliveryTask;
    const assignment = task?.assignments.find((candidate) => candidate.riderId === task.riderId)
      ?? task?.assignments[0];
    if (!task || !assignment) throw conflict('RIDER_RESPONSIBILITY_MISSING', 'Exception order has no rider assignment');
    if (actor.role === 'RIDER') {
      if (actor.riderId !== assignment.riderId) throw forbidden();
      const voluntaryTypes: ExceptionType[] = [ExceptionType.SEVERE_FOOD_DAMAGE, ExceptionType.FOOD_LOST];
      if (!voluntaryTypes.includes(exceptionCase.category)) {
        throw conflict('VOLUNTARY_COMPENSATION_NOT_ALLOWED', 'Rider voluntary compensation is limited to severe damage or loss cases');
      }
    } else {
      requireAdminLevel(actor, ['OPERATOR', 'SUPER_ADMIN']);
      if (exceptionCase.currentHandlerAdminId !== actor.id && actor.adminLevel !== 'SUPER_ADMIN') throw forbidden();
    }
    if (exceptionCase.compensationObligation) {
      if (exceptionCase.compensationObligation.idempotencyKey !== input.idempotencyKey) {
        throw conflict('COMPENSATION_ALREADY_EXISTS', 'This case already has a compensation obligation');
      }
      return exceptionCase.compensationObligation;
    }
    const action = actor.role === 'RIDER' ? 'RIDER_COMPENSATE' : 'ADMIN_REFUND';
    assertExceptionCaseAction(exceptionCase.status, action);
    if (exceptionCase.version !== input.expectedVersion) {
      throw conflict('CASE_VERSION_CONFLICT', 'Exception case changed before compensation');
    }
    const reservedCase = await tx.exceptionCase.updateMany({
      where: { id: caseId, version: input.expectedVersion, status: exceptionCase.status },
      data: { version: { increment: 1 }, lastActionAt: now },
    });
    if (reservedCase.count !== 1) throw conflict('CASE_VERSION_CONFLICT', 'Exception case changed before compensation');
    const pricing = exceptionCase.order.pricing;
    if (!pricing) throw conflict('MISSING_PRICING', 'Order pricing is missing');
    const customerRefundMinor = pricing.itemSubtotalMinor + pricing.customerDeliveryFeeMinor;
    if (voluntaryPaymentMinor > customerRefundMinor) {
      throw badRequest('VOLUNTARY_PAYMENT_TOO_HIGH', 'Voluntary payment cannot exceed the order refund');
    }

    let currentSettlement = await tx.riderSettlement.findUnique({ where: { orderId: exceptionCase.orderId } });
    if (!currentSettlement) {
      currentSettlement = await tx.riderSettlement.create({
        data: {
          orderId: exceptionCase.orderId,
          riderId: assignment.riderId,
          amountMinor: assignment.riderGuaranteedPayoutMinorAtClaim + assignment.postClaimTipMinor,
          status: RiderSettlementStatus.HELD,
          pendingUntil: now,
          heldAt: now,
          holdReason: 'COMPENSATION_OBLIGATION',
        },
      });
    }
    await tx.$queryRaw`SELECT "id" FROM "RiderSettlement" WHERE "riderId" = ${assignment.riderId}::uuid ORDER BY "id" FOR UPDATE`;
    const settlements = await tx.riderSettlement.findMany({
      where: { riderId: assignment.riderId },
      orderBy: { createdAt: 'asc' },
    });
    const ordered = [
      ...settlements.filter((settlement) => settlement.id === currentSettlement!.id),
      ...settlements.filter((settlement) => settlement.id !== currentSettlement!.id && settlement.status !== RiderSettlementStatus.HELD),
    ];
    let remaining = customerRefundMinor - voluntaryPaymentMinor;
    let currentOrderReservedMinor = 0;
    let otherUnwithdrawnReservedMinor = 0;
    const reservations: Array<{ settlementId: string; source: CompensationFundingSource; amountMinor: number }> = [];
    for (const settlement of ordered) {
      if (remaining <= 0) break;
      const available = Math.max(0, settlement.amountMinor - settlement.reservedMinor);
      const amountMinor = Math.min(available, remaining);
      if (amountMinor <= 0) continue;
      await tx.riderSettlement.update({
        where: { id: settlement.id },
        data: { reservedMinor: { increment: amountMinor } },
      });
      const current = settlement.orderId === exceptionCase.orderId;
      if (current) currentOrderReservedMinor += amountMinor;
      else otherUnwithdrawnReservedMinor += amountMinor;
      reservations.push({
        settlementId: settlement.id,
        source: current
          ? CompensationFundingSource.CURRENT_ORDER_SETTLEMENT
          : CompensationFundingSource.OTHER_UNWITHDRAWN_SETTLEMENT,
        amountMinor,
      });
      remaining -= amountMinor;
    }
    const platformAdvancedMinor = remaining;
    const obligation = await tx.compensationObligation.create({
      data: {
        caseId,
        orderId: exceptionCase.orderId,
        riderId: assignment.riderId,
        requiredCompensationMinor: customerRefundMinor,
        currentOrderReservedMinor,
        otherUnwithdrawnReservedMinor,
        riderVoluntaryPaymentMinor: voluntaryPaymentMinor,
        platformAdvancedMinor,
        customerRefundMinor,
        outstandingMinor: platformAdvancedMinor,
        status: platformAdvancedMinor > 0 ? CompensationStatus.PARTIALLY_FUNDED : CompensationStatus.FUNDED,
        idempotencyKey: input.idempotencyKey,
        actorId: actor.id,
        reason: input.reason,
        ...(platformAdvancedMinor === 0 ? { resolvedAt: now } : {}),
      },
    });
    if (reservations.length > 0) {
      await tx.compensationAllocation.createMany({
        data: reservations.map((reservation) => ({
          obligationId: obligation.id,
          riderSettlementId: reservation.settlementId,
          source: reservation.source,
          amountMinor: reservation.amountMinor,
        })),
      });
    }
    if (voluntaryPaymentMinor > 0) {
      await tx.compensationAllocation.create({
        data: {
          obligationId: obligation.id,
          source: CompensationFundingSource.RIDER_VOLUNTARY_PAYMENT,
          amountMinor: voluntaryPaymentMinor,
        },
      });
    }
    if (platformAdvancedMinor > 0) {
      await tx.compensationAllocation.create({
        data: {
          obligationId: obligation.id,
          source: CompensationFundingSource.PLATFORM_ADVANCE,
          amountMinor: platformAdvancedMinor,
        },
      });
    }

    await tx.orderPricing.update({
      where: { orderId: exceptionCase.orderId },
      data: {
        customerRefundMinor: Math.max(pricing.customerRefundMinor, customerRefundMinor),
        exceptionCompensationMinor: customerRefundMinor,
      },
    });
    if (exceptionCase.order.status !== OrderStatus.EXCEPTION) {
      await tx.order.update({ where: { id: exceptionCase.orderId }, data: { status: OrderStatus.EXCEPTION } });
      await tx.orderEvent.create({
        data: {
          orderId: exceptionCase.orderId,
          eventType: OrderEventType.EXCEPTION_RECORDED,
          actorType: OrderEventActorType.USER,
          fromStatus: exceptionCase.order.status,
          toStatus: OrderStatus.EXCEPTION,
          operatorId: actor.id,
          operatorRole: actor.role,
          reason: 'REFUND_AND_CLOSE',
          metadata: { caseId, obligationId: obligation.id, customerRefundMinor },
          createdAt: now,
        },
      });
    }
    await tx.deliveryTask.update({ where: { id: task.id }, data: { status: DeliveryTaskStatus.EXCEPTION } });
    await tx.deliveryAssignment.updateMany({
      where: { taskId: task.id, status: DeliveryAssignmentStatus.ACTIVE },
      data: { status: DeliveryAssignmentStatus.EXCEPTION, endedAt: now, reason: 'REFUND_AND_CLOSE' },
    });
    const resolvedCase = await tx.exceptionCase.updateMany({
      where: { id: caseId, version: input.expectedVersion + 1, status: exceptionCase.status },
      data: {
        status: ExceptionCaseStatus.RESOLVED,
        resolutionType: ExceptionResolutionType.REFUND_AND_CLOSE,
        resolutionNote: input.reason,
        resolvedAt: now,
        lastActionAt: now,
      },
    });
    if (resolvedCase.count !== 1) throw conflict('CASE_VERSION_CONFLICT', 'Exception case changed before final resolution');
    await tx.exceptionCaseAction.createMany({
      data: [
        {
          caseId,
          type: ExceptionCaseActionType.REFUND_EXECUTED,
          actorId: actor.id,
          reason: input.reason,
          metadata: { obligationId: obligation.id, idempotencyKey: input.idempotencyKey, customerRefundMinor },
        },
        {
          caseId,
          type: ExceptionCaseActionType.RESOLVED,
          actorId: actor.id,
          reason: 'REFUND_AND_CLOSE',
          metadata: { resolutionType: ExceptionResolutionType.REFUND_AND_CLOSE },
        },
      ],
    });
    return obligation;
  });
}

export async function getRiderCompensationSummary(prisma: PrismaClient, actor: Actor) {
  if (!actor.riderId) throw forbidden();
  return prisma.compensationObligation.findMany({
    where: { riderId: actor.riderId },
    select: {
      id: true,
      orderId: true,
      requiredCompensationMinor: true,
      currentOrderReservedMinor: true,
      otherUnwithdrawnReservedMinor: true,
      riderVoluntaryPaymentMinor: true,
      platformAdvancedMinor: true,
      outstandingMinor: true,
      status: true,
      createdAt: true,
      resolvedAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function releaseCompensationReservations(
  prisma: PrismaClient,
  actor: Actor,
  caseId: string,
  expectedVersion: number,
  idempotencyKey: string,
  reason: string,
  now = new Date(),
) {
  requireAdminLevel(actor, ['OPERATOR', 'SUPER_ADMIN']);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ExceptionCase" WHERE "id" = ${caseId}::uuid FOR UPDATE`;
    const exceptionCase = await tx.exceptionCase.findUnique({
      where: { id: caseId },
      include: { compensationObligation: { include: { allocations: true } } },
    });
    if (!exceptionCase?.compensationObligation) throw notFound('Compensation obligation');
    if (exceptionCase.currentHandlerAdminId !== actor.id && actor.adminLevel !== 'SUPER_ADMIN') throw forbidden();
    const obligation = exceptionCase.compensationObligation;
    if (obligation.releaseIdempotencyKey) {
      if (obligation.releaseIdempotencyKey !== idempotencyKey) {
        throw conflict('COMPENSATION_ALREADY_RELEASED', 'Reservations were already released');
      }
      return obligation;
    }
    if (
      exceptionCase.status !== ExceptionCaseStatus.RESOLVED
      || exceptionCase.resolutionType !== ExceptionResolutionType.REFUND_AND_CLOSE
    ) {
      throw conflict('CASE_STATE_CONFLICT', 'Compensation reservations can be released only after refund-and-close resolution');
    }
    if (exceptionCase.version !== expectedVersion) {
      throw conflict('CASE_VERSION_CONFLICT', 'Exception case changed before compensation release');
    }
    const reservedCase = await tx.exceptionCase.updateMany({
      where: { id: caseId, version: expectedVersion, status: ExceptionCaseStatus.RESOLVED },
      data: { version: { increment: 1 }, lastActionAt: now },
    });
    if (reservedCase.count !== 1) throw conflict('CASE_VERSION_CONFLICT', 'Exception case changed before compensation release');
    const reservations = obligation.allocations.filter((allocation) => allocation.riderSettlementId && !allocation.releasedAt);
    const settlementIds = reservations.map((allocation) => allocation.riderSettlementId!);
    if (settlementIds.length > 0) {
      const ids = Prisma.join(settlementIds.map((id) => Prisma.sql`${id}::uuid`));
      await tx.$queryRaw`SELECT "id" FROM "RiderSettlement" WHERE "id" IN (${ids}) ORDER BY "id" FOR UPDATE`;
    }
    let releasedMinor = 0;
    for (const allocation of reservations) {
      await tx.riderSettlement.update({
        where: { id: allocation.riderSettlementId! },
        data: { reservedMinor: { decrement: allocation.amountMinor } },
      });
      releasedMinor += allocation.amountMinor;
    }
    await tx.compensationAllocation.updateMany({
      where: { obligationId: obligation.id, riderSettlementId: { not: null }, releasedAt: null },
      data: { releasedAt: now },
    });
    const platformAllocation = obligation.allocations.find(
      (allocation) => allocation.source === CompensationFundingSource.PLATFORM_ADVANCE,
    );
    if (releasedMinor > 0) {
      if (platformAllocation) {
        await tx.compensationAllocation.update({
          where: { id: platformAllocation.id },
          data: { amountMinor: { increment: releasedMinor } },
        });
      } else {
        await tx.compensationAllocation.create({
          data: { obligationId: obligation.id, source: CompensationFundingSource.PLATFORM_ADVANCE, amountMinor: releasedMinor },
        });
      }
    }
    const updated = await tx.compensationObligation.update({
      where: { id: obligation.id },
      data: {
        currentOrderReservedMinor: 0,
        otherUnwithdrawnReservedMinor: 0,
        platformAdvancedMinor: { increment: releasedMinor },
        outstandingMinor: { increment: releasedMinor },
        status: CompensationStatus.PARTIALLY_FUNDED,
        releaseIdempotencyKey: idempotencyKey,
        releasedAt: now,
        resolvedAt: null,
      },
    });
    await tx.exceptionCaseAction.create({
      data: {
        caseId,
        type: ExceptionCaseActionType.RESERVATION_RELEASED,
        actorId: actor.id,
        reason,
        metadata: { obligationId: obligation.id, idempotencyKey, releasedMinor },
      },
    });
    return updated;
  });
}
