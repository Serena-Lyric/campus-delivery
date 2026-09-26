import {
  ExceptionType,
  RiderSettlementStatus,
  type PrismaClient,
} from '@prisma/client';
import type { Actor } from '../auth/auth.js';
import { forbidden } from '../shared/errors.js';

export async function releaseAvailableRiderSettlements(
  prisma: PrismaClient,
  now = new Date(),
  limit = 100,
): Promise<number> {
  const candidates = await prisma.riderSettlement.findMany({
    where: { status: RiderSettlementStatus.PENDING, pendingUntil: { lte: now } },
    select: { id: true, orderId: true },
    orderBy: { pendingUntil: 'asc' },
    take: limit,
  });

  let released = 0;
  for (const candidate of candidates) {
    released += await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "RiderSettlement" WHERE "id" = ${candidate.id}::uuid FOR UPDATE`;
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
    ...settlement,
    withdrawableMinor: Math.max(0, settlement.amountMinor - settlement.reservedMinor),
  }));
}

