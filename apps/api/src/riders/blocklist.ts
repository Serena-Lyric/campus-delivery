import type { PrismaClient } from '@prisma/client';
import type { Actor } from '../auth/auth.js';
import { forbidden, notFound } from '../shared/errors.js';

export function requireRider(actor: Actor): string {
  if (actor.role !== 'RIDER' || !actor.riderId) throw forbidden();
  return actor.riderId;
}

export async function listBlockedMerchants(prisma: PrismaClient, actor: Actor) {
  return prisma.riderBlockedMerchant.findMany({
    where: { riderId: requireRider(actor) },
    select: { merchantId: true, createdAt: true, merchant: { select: { name: true } } },
    orderBy: [{ createdAt: 'desc' }, { merchantId: 'asc' }],
  });
}

export async function setMerchantBlocked(prisma: PrismaClient, actor: Actor, merchantId: string, blocked: boolean) {
  const riderId = requireRider(actor);
  return prisma.$transaction(async (tx) => {
    // Shared with claim: whichever holds the rider lock first takes effect first.
    await tx.$queryRaw`SELECT "id" FROM "Rider" WHERE "id" = ${riderId}::uuid FOR UPDATE`;
    if (!await tx.merchant.findUnique({ where: { id: merchantId }, select: { id: true } })) throw notFound('Merchant');
    if (blocked) {
      await tx.riderBlockedMerchant.upsert({ where: { riderId_merchantId: { riderId, merchantId } }, create: { riderId, merchantId }, update: {} });
    } else {
      await tx.riderBlockedMerchant.deleteMany({ where: { riderId, merchantId } });
    }
    return { merchantId, blocked };
  });
}
