import { Prisma, type PrismaClient } from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Actor } from '../auth/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../shared/errors.js';
import { lockOwnMerchant } from './operating-status.js';
import { recordSaleStatusChange } from './product-status.js';

const Name = Type.String({ minLength: 1, maxLength: 100, pattern: '\\S' });
export const CategoryBody = Type.Object({
  name: Name,
  sortOrder: Type.Integer({ minimum: 0, maximum: 100000 }),
}, { additionalProperties: false });
export const ProductBody = Type.Object({
  categoryId: Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' }),
  name: Name,
  description: Type.Optional(Type.String({ maxLength: 2000 })),
  imageUrl: Type.Optional(Type.String({ maxLength: 1000, pattern: '^https://' })),
  marketingTags: Type.Array(Type.String({ minLength: 1, maxLength: 20, pattern: '\\S' }), { maxItems: 5, uniqueItems: true }),
  sortOrder: Type.Integer({ minimum: 0, maximum: 100000 }),
  priceMinor: Type.Integer({ minimum: 1, maximum: 100000000 }),
  isAvailable: Type.Boolean(),
  deliveryCategoryCode: Type.String({ minLength: 1, maxLength: 50 }),
}, { additionalProperties: false });
export type ProductInput = Static<typeof ProductBody>;
export type CategoryInput = Static<typeof CategoryBody>;
export const deliveryCategorySelect = { code: true, name: true, version: true, riskTags: true, coreFragile: true, selectable: true } as const;
export const productSelect = {
  id: true, categoryId: true, name: true, description: true, imageUrl: true,
  marketingTags: true, sortOrder: true, priceMinor: true, isAvailable: true, saleStatus: true, version: true,
  deliveryCategory: { select: deliveryCategorySelect },
} satisfies Prisma.ProductSelect;

function merchantIdOf(actor: Actor) {
  if (actor.role !== 'MERCHANT' || !actor.merchantId) throw forbidden();
  return actor.merchantId;
}

export async function saveCategory(prisma: PrismaClient, actor: Actor, input: CategoryInput, id?: string) {
  const merchantId = merchantIdOf(actor);
  if (!Value.Check(CategoryBody, input)) throw badRequest('INVALID_CATEGORY', 'Invalid display category');
  try {
    return await prisma.$transaction(async (tx) => {
      await lockOwnMerchant(tx, actor, false);
      if (id) {
        const changed = await tx.productCategory.updateMany({ where: { id, merchantId }, data: input });
        if (!changed.count) throw notFound('Own category');
        return tx.productCategory.findUniqueOrThrow({ where: { id }, select: { id: true, name: true, sortOrder: true } });
      }
      return tx.productCategory.create({ data: { ...input, merchantId }, select: { id: true, name: true, sortOrder: true } });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw conflict('DUPLICATE_CATEGORY', 'Display category name already exists');
    throw error;
  }
}

export async function saveProduct(prisma: PrismaClient, actor: Actor, input: ProductInput, id?: string, expectedVersion?: number) {
  const merchantId = merchantIdOf(actor);
  if (!Value.Check(ProductBody, input)) throw badRequest('INVALID_PRODUCT', 'Invalid product fields');
  return prisma.$transaction(async (tx) => {
    await lockOwnMerchant(tx, actor, false);
    const category = await tx.productCategory.findFirst({ where: { id: input.categoryId, merchantId } });
    if (!category) throw notFound('Own category');
    const deliveryCategory = await tx.deliveryCategory.findUnique({ where: { code: input.deliveryCategoryCode } });
    if (!deliveryCategory?.selectable) throw badRequest('INVALID_DELIVERY_CATEGORY', 'Select an approved platform delivery category');
    if (id) {
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion! < 1) throw badRequest('VERSION_REQUIRED', 'Expected product version is required');
      await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const before = await tx.product.findFirst({ where: { id, merchantId, version: expectedVersion! },
        select: { id: true, merchantId: true, saleStatus: true } });
      if (!before) throw conflict('PRODUCT_UPDATE_CONFLICT', 'Own product is missing or its version changed');
      const changed = await tx.product.updateMany({
        where: { id, merchantId, version: expectedVersion! },
        data: { ...input, description: input.description ?? null, imageUrl: input.imageUrl ?? null, version: { increment: 1 } },
      });
      if (!changed.count) throw conflict('PRODUCT_UPDATE_CONFLICT', 'Own product is missing or its version changed');
      const after = await tx.product.findUniqueOrThrow({ where: { id }, select: productSelect });
      await recordSaleStatusChange(tx, actor, before, after, 'Boolean availability changed in full product edit', 'LEGACY_EDIT');
      return after;
    }
    return tx.product.create({ data: { ...input, merchantId }, select: productSelect });
  });
}
