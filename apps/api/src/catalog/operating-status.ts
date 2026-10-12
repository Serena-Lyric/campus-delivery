import { MerchantExposureState, type Prisma, type PrismaClient } from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Actor } from '../auth/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../shared/errors.js';

export const OperatingStatusBody = Type.Object({
  isOpen: Type.Boolean(),
  expectedVersion: Type.Integer({ minimum: 0, maximum: 2147483646 }),
  reason: Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' }),
}, { additionalProperties: false });
export type OperatingStatusInput = Static<typeof OperatingStatusBody>;

export function operatingStatusFields(merchant: { isOpen: boolean; exposureState: MerchantExposureState }) {
  return {
    acceptingOrders: merchant.isOpen && merchant.exposureState !== 'HIDDEN' && merchant.exposureState !== 'SUSPENDED',
    operatingStatusLabel: merchant.isOpen ? '营业中' : '休息中',
  };
}

export async function lockOwnMerchant(tx: Prisma.TransactionClient, actor: Actor, write = true) {
  if (actor.role !== 'MERCHANT' || !actor.merchantId) throw forbidden();
  // Checkout takes FOR SHARE at this same point in config -> merchant -> catalog -> locations.
  if (write) await tx.$queryRaw`SELECT "id" FROM "Merchant" WHERE "id" = ${actor.merchantId}::uuid FOR UPDATE`;
  else await tx.$queryRaw`SELECT "id" FROM "Merchant" WHERE "id" = ${actor.merchantId}::uuid FOR SHARE`;
  const merchant = await tx.merchant.findFirst({ where: { id: actor.merchantId, ownerId: actor.id },
    select: { id: true, isOpen: true, operatingVersion: true, exposureState: true } });
  if (!merchant) throw notFound('Own merchant');
  return merchant;
}

const auditSelect = { version: true, previousIsOpen: true, newIsOpen: true, actorId: true, reason: true, createdAt: true } as const;
const ownStatus = (merchant: Awaited<ReturnType<typeof lockOwnMerchant>>) => ({
  id: merchant.id, isOpen: merchant.isOpen, operatingVersion: merchant.operatingVersion, ...operatingStatusFields(merchant),
});

export async function getOperatingStatus(prisma: PrismaClient, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const merchant = await lockOwnMerchant(tx, actor, false);
    const history = await tx.merchantOperatingStatusAudit.findMany({ where: { merchantId: merchant.id },
      orderBy: { version: 'desc' }, take: 100, select: auditSelect });
    return { ...ownStatus(merchant), history };
  });
}

export async function updateOperatingStatus(prisma: PrismaClient, actor: Actor, input: OperatingStatusInput) {
  if (!Value.Check(OperatingStatusBody, input)) throw badRequest('INVALID_OPERATING_STATUS', 'Invalid operating status fields');
  return prisma.$transaction(async (tx) => {
    const merchant = await lockOwnMerchant(tx, actor);
    if (merchant.operatingVersion !== input.expectedVersion) throw conflict('OPERATING_VERSION_CONFLICT', 'Refresh your operating status');
    if (merchant.isOpen === input.isOpen) return { ...ownStatus(merchant), changed: false };
    const changed = await tx.merchant.updateMany({ where: { id: merchant.id, ownerId: actor.id, operatingVersion: input.expectedVersion },
      data: { isOpen: input.isOpen, operatingVersion: { increment: 1 } } });
    if (changed.count !== 1) throw conflict('OPERATING_VERSION_CONFLICT', 'Refresh your operating status');
    const audit = await tx.merchantOperatingStatusAudit.create({ data: { merchantId: merchant.id,
      version: input.expectedVersion + 1, previousIsOpen: merchant.isOpen, newIsOpen: input.isOpen,
      actorId: actor.id, reason: input.reason.trim() }, select: auditSelect });
    return { ...ownStatus({ ...merchant, isOpen: input.isOpen, operatingVersion: audit.version }), changed: true, audit };
  });
}
