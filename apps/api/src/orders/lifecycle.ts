import {
  OrderEventActorType,
  OrderEventType,
  OrderStatus,
  type PrismaClient,
} from '@prisma/client';

export async function releaseExpiredCoolingOrders(
  prisma: PrismaClient,
  now = new Date(),
  limit = 100,
): Promise<number> {
  const candidates = await prisma.order.findMany({
    where: { status: OrderStatus.CREATED, coolingOffEndsAt: { lte: now } },
    select: { id: true },
    orderBy: { coolingOffEndsAt: 'asc' },
    take: limit,
  });

  let released = 0;
  for (const candidate of candidates) {
    released += await prisma.$transaction(async (tx) => {
      const updated = await tx.order.updateMany({
        where: {
          id: candidate.id,
          status: OrderStatus.CREATED,
          coolingOffEndsAt: { lte: now },
        },
        data: { status: OrderStatus.MERCHANT_PENDING },
      });
      if (updated.count !== 1) return 0;
      await tx.orderEvent.create({
        data: {
          orderId: candidate.id,
          eventType: OrderEventType.COOLING_OFF_COMPLETED,
          actorType: OrderEventActorType.SYSTEM,
          fromStatus: OrderStatus.CREATED,
          toStatus: OrderStatus.MERCHANT_PENDING,
          metadata: { coolingOffEndedAt: now.toISOString() },
        },
      });
      return 1;
    });
  }
  return released;
}
