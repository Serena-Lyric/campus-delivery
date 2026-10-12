import { type Prisma, type PrismaClient, type ProductSaleStatus } from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Actor } from '../auth/auth.js';
import { badRequest, conflict } from '../shared/errors.js';
import { lockOwnMerchant } from './operating-status.js';

export const SaleStatusBody = Type.Object({
  saleStatus: Type.Union([Type.Literal('ON_SALE'), Type.Literal('SOLD_OUT'), Type.Literal('OFF_SHELF')]),
  expectedVersion: Type.Integer({ minimum: 1, maximum: 2147483646 }),
  reason: Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' }),
}, { additionalProperties: false });
export type SaleStatusInput = Static<typeof SaleStatusBody>;
const labels: Record<ProductSaleStatus, string> = { ON_SALE: '在售', SOLD_OUT: '已售罄', OFF_SHELF: '已下架' };
export function productSaleFields(saleStatus: ProductSaleStatus, acceptingOrders: boolean) {
  return { saleStatusLabel: labels[saleStatus], purchasable: acceptingOrders && saleStatus === 'ON_SALE' };
}

export async function recordSaleStatusChange(tx: Prisma.TransactionClient, actor: Actor,
  before: { id: string; merchantId: string; saleStatus: ProductSaleStatus },
  after: { version: number; saleStatus: ProductSaleStatus }, reason: string, source: string) {
  if (before.saleStatus === after.saleStatus) return;
  return tx.productSaleStatusAudit.create({ data: { productId: before.id, merchantId: before.merchantId,
    version: after.version, previousStatus: before.saleStatus, newStatus: after.saleStatus, actorId: actor.id, reason, source },
    select: { version: true, previousStatus: true, newStatus: true, actorId: true, reason: true, source: true, createdAt: true } });
}

export async function updateProductSaleStatus(prisma: PrismaClient, actor: Actor, id: string, input: SaleStatusInput) {
  if (!Value.Check(SaleStatusBody, input)) throw badRequest('INVALID_SALE_STATUS', 'Invalid sale status fields');
  return prisma.$transaction(async (tx) => {
    const merchant = await lockOwnMerchant(tx, actor, false);
    await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const before = await tx.product.findFirst({ where: { id, merchantId: merchant.id },
      select: { id: true, merchantId: true, saleStatus: true, isAvailable: true, version: true } });
    if (!before || before.version !== input.expectedVersion) throw conflict('PRODUCT_UPDATE_CONFLICT', 'Own product is missing or its version changed');
    const view = (product: typeof before) => ({ id: product.id, saleStatus: product.saleStatus, isAvailable: product.isAvailable, version: product.version });
    if (before.saleStatus === input.saleStatus) return { ...view(before), changed: false };
    const changed = await tx.product.updateMany({ where: { id, merchantId: merchant.id, version: input.expectedVersion },
      data: { saleStatus: input.saleStatus, version: { increment: 1 } } });
    if (changed.count !== 1) throw conflict('PRODUCT_UPDATE_CONFLICT', 'Refresh your product before editing');
    const after = await tx.product.findUniqueOrThrow({ where: { id }, select: { id: true, merchantId: true, saleStatus: true, isAvailable: true, version: true } });
    const audit = await recordSaleStatusChange(tx, actor, before, after, input.reason.trim(), 'MANUAL_STATUS');
    return { ...view(after), changed: true, audit };
  });
}
