import {
  ExceptionType,
  Prisma,
  RiderSettlementStatus,
  type PrismaClient,
} from '@prisma/client';
import type { Actor } from '../auth/auth.js';
import { forbidden } from '../shared/errors.js';
import { unverifiedRiderBalanceView } from '../finance/permissions.js';

type TerminalExceptionCase = {
  exceptionEventId: string;
  orderId: string;
  category: ExceptionType;
};

async function reconcileDeliveryDisputeHold(
  tx: Prisma.TransactionClient,
  settlementId: string,
  now: Date,
): Promise<number> {
  await tx.$queryRaw`SELECT "id" FROM "RiderSettlement" WHERE "id" = ${settlementId}::uuid FOR UPDATE`;
  const settlement = await tx.riderSettlement.findUnique({ where: { id: settlementId } });
  if (
    !settlement
    || settlement.status !== RiderSettlementStatus.HELD
    || settlement.holdReason !== ExceptionType.DELIVERY_DISPUTE
  ) {
    return 0;
  }
  const unresolvedDisputes = await tx.exceptionEvent.count({
    where: {
      orderId: settlement.orderId,
      type: ExceptionType.DELIVERY_DISPUTE,
      resolvedAt: null,
    },
  });
  if (unresolvedDisputes > 0) return 0;
  const available = settlement.pendingUntil <= now;
  const updated = await tx.riderSettlement.updateMany({
    where: {
      id: settlement.id,
      status: RiderSettlementStatus.HELD,
      holdReason: ExceptionType.DELIVERY_DISPUTE,
    },
    data: {
      status: available ? RiderSettlementStatus.AVAILABLE : RiderSettlementStatus.PENDING,
      availableAt: available ? now : null,
      heldAt: null,
      holdReason: null,
    },
  });
  return updated.count;
}

export async function resolveLinkedExceptionEvent(
  tx: Prisma.TransactionClient,
  exceptionCase: TerminalExceptionCase,
  now: Date,
): Promise<void> {
  await tx.exceptionEvent.updateMany({
    where: { id: exceptionCase.exceptionEventId, resolvedAt: null },
    data: { resolvedAt: now },
  });
  if (exceptionCase.category !== ExceptionType.DELIVERY_DISPUTE) return;
  const settlement = await tx.riderSettlement.findUnique({
    where: { orderId: exceptionCase.orderId },
    select: { id: true },
  });
  if (settlement) await reconcileDeliveryDisputeHold(tx, settlement.id, now);
}

export async function releaseAvailableRiderSettlements(
  prisma: PrismaClient,
  now = new Date(),
  limit = 100,
): Promise<number> {
  const candidates = await prisma.riderSettlement.findMany({
    where: {
      OR: [
        { status: RiderSettlementStatus.PENDING, pendingUntil: { lte: now } },
        { status: RiderSettlementStatus.HELD, holdReason: ExceptionType.DELIVERY_DISPUTE },
      ],
    },
    select: { id: true, orderId: true },
    orderBy: { pendingUntil: 'asc' },
    take: limit,
  });

  let released = 0;
  for (const candidate of candidates) {
    released += await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "RiderSettlement" WHERE "id" = ${candidate.id}::uuid FOR UPDATE`;
      const settlement = await tx.riderSettlement.findUnique({ where: { id: candidate.id } });
      if (!settlement) return 0;
      if (
        settlement.status === RiderSettlementStatus.HELD
        && settlement.holdReason === ExceptionType.DELIVERY_DISPUTE
      ) {
        return reconcileDeliveryDisputeHold(tx, settlement.id, now);
      }
      const disputes = await tx.exceptionEvent.count({
        where: {
          orderId: candidate.orderId,
          type: ExceptionType.DELIVERY_DISPUTE,
          resolvedAt: null,
        },
      });
      if (disputes > 0) return 0;
      const updated = await tx.riderSettlement.updateMany({
        where: {
          id: candidate.id,
          status: RiderSettlementStatus.PENDING,
          pendingUntil: { lte: now },
        },
        data: { status: RiderSettlementStatus.AVAILABLE, availableAt: now },
      });
      return updated.count;
    });
  }
  return released;
}

export async function listRiderSettlements(
  prisma: PrismaClient,
  actor: Actor,
  limit: number,
  offset: number,
) {
  if (!actor.riderId) throw forbidden();
  const settlements = await prisma.riderSettlement.findMany({
    where: { riderId: actor.riderId },
    select: {
      id: true,
      amountMinor: true,
      reservedMinor: true,
      status: true,
      pendingUntil: true,
      availableAt: true,
      heldAt: true,
      holdReason: true,
      createdAt: true,
      order: {
        select: {
          id: true,
          shortCode: true,
          status: true,          merchant: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });
  return settlements.map((settlement) => ({
    id: settlement.id,
    ...unverifiedRiderBalanceView(settlement.amountMinor, settlement.reservedMinor),
    status: settlement.status,
    pendingUntil: settlement.pendingUntil,
    availableAt: settlement.availableAt,
    heldAt: settlement.heldAt,
    holdReason: settlement.holdReason,
    createdAt: settlement.createdAt,
    order: { id: settlement.order.id, shortCode: settlement.order.shortCode, status: settlement.order.status,
      merchant: { id: settlement.order.merchant.id, name: settlement.order.merchant.name } },
  }));
}

