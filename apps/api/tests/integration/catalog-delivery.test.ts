import {
  DeliveryMethod,
  FoodType,
  MerchantExposureState,
  PickupVerificationMode,
  PrismaClient,
  RiderStatus,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { saveProduct } from '../../src/catalog/service.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import { getMyCapacity } from '../../src/riders/capacity.js';
import { releaseExpiredCoolingOrders } from '../../src/orders/lifecycle.js';
import { createOrder } from '../../src/orders/service.js';
import type { ItemClassifier } from '../../src/item-classifier/classifier.js';
import { demoPolicy, seedDatabase, seedIds } from '../../prisma/seed.js';

const prisma = new PrismaClient();
const config: AppConfig = {
  databaseUrl: process.env.DATABASE_URL!,
  host: '127.0.0.1',
  port: 3000,
  enableDevAuth: true,
  enableBackgroundJobs: false,
  backgroundSweepIntervalMs: 5000,
  campusTimeZone: 'Asia/Shanghai',
  logLevel: 'silent',
};
const headers = (userId: string) => ({ 'x-user-id': userId });

describe('merchant display catalog and authoritative delivery snapshots', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    await seedDatabase(prisma);
    app = await buildApp(config, prisma);
    await app.ready();
  });

  beforeEach(async () => {
    await prisma.riderCapacityEvent.deleteMany();
    await prisma.compensationAllocation.deleteMany();
    await prisma.compensationObligation.deleteMany();
    await prisma.remakeProposal.deleteMany();
    await prisma.exceptionCaseAction.deleteMany();
    await prisma.exceptionCase.deleteMany();
    await prisma.riderRestrictionAudit.deleteMany();
    await prisma.riderRestriction.deleteMany();
    await prisma.riderCancellationEvent.deleteMany();
    await prisma.merchantExposureDecision.deleteMany();
    await prisma.subsidyRecord.deleteMany();
    await prisma.deliveryTask.deleteMany();
    await prisma.order.deleteMany();
    await prisma.businessConfigAudit.deleteMany();
    await prisma.businessConfig.deleteMany({ where: { id: { not: seedIds.policyConfig } } });
    await prisma.businessConfig.update({ where: { id: seedIds.policyConfig }, data: { payload: demoPolicy, isActive: true } });
    await prisma.merchantSubsidyAccount.update({
      where: { id: seedIds.subsidyAccount },
      data: { subsidyUsedMinor: 0, subsidyUsageBps: 0, subsidyLimitMinor: 1000 },
    });
    await prisma.merchant.update({
      where: { id: seedIds.merchant },
      data: { exposureState: MerchantExposureState.NORMAL, trialExposureOverrideBps: 10_000, pickupVerificationMode: PickupVerificationMode.CONFIRMATION },
    });
    await prisma.product.update({ where: { id: seedIds.productRice }, data: { deliveryCategoryCode: 'ORDINARY_MEAL', name: '鸡腿饭', priceMinor: 1500 } });
    await prisma.deliveryCategory.update({ where: { code: 'CAKE' }, data: { version: 1, coreFragile: true, riskTags: ['CRUSH_RISK', 'TILT_RISK', 'COLD_CHAIN'] } });
    await prisma.rider.update({
      where: { id: seedIds.riderA },
      data: { status: RiderStatus.AVAILABLE, firstNormalDeliveredAt: new Date('2026-09-20T04:00:00.000Z'), capacityOverride: null },
    });
    await prisma.rider.update({
      where: { id: seedIds.riderB },
      data: { status: RiderStatus.AVAILABLE, firstNormalDeliveredAt: null, capacityOverride: null },
    });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function createReady() {
    const created = await app.inject({
      method: 'POST', url: '/orders', headers: headers(seedIds.customer),
      payload: {
        merchantId: seedIds.merchant,
        destinationLocationId: seedIds.dormLocation,
        deliveryMethod: DeliveryMethod.DESIGNATED_POINT,
        items: [{ productId: seedIds.productRice, quantity: 1 }, { productId: seedIds.productTea, quantity: 1 }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const orderId = created.json().id as string;
    await prisma.order.update({ where: { id: orderId }, data: { coolingOffEndsAt: new Date(Date.now() - 1000) } });
    await releaseExpiredCoolingOrders(prisma);
    const confirmed = await app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/confirm`, headers: headers(seedIds.merchantUser) });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    return { orderId, taskId: confirmed.json().deliveryTask.id as string };
  }

  const claim = (taskId: string, riderUser: string) => app.inject({
    method: 'POST', url: `/delivery-tasks/${taskId}/claim`, headers: headers(riderUser),
  });


  const productInput = (deliveryCategoryCode = 'CAKE') => ({
    categoryId: seedIds.category, name: '同名商品', priceMinor: 3000,
    isAvailable: true, deliveryCategoryCode, sortOrder: 2, marketingTags: ['招牌'],
  });
  const customer = { id: seedIds.customer, role: 'CUSTOMER' as const };
  const merchant = { id: seedIds.merchantUser, role: 'MERCHANT' as const, merchantId: seedIds.merchant };
  const orderInput = (productId: string = seedIds.productRice) => ({
    merchantId: seedIds.merchant, destinationLocationId: seedIds.dormLocation,
    deliveryMethod: DeliveryMethod.DESIGNATED_POINT, items: [{ productId, quantity: 1 }],
  });

  it('keeps identical products in different display groups under the same deterministic risk rules', async () => {
    const group = await app.inject({ method: 'POST', url: '/merchant/catalog/categories', headers: headers(seedIds.merchantUser), payload: { name: randomUUID(), sortOrder: 9 } });
    expect(group.statusCode, group.body).toBe(201);
    const first = await saveProduct(prisma, merchant, productInput());
    const second = await saveProduct(prisma, merchant, { ...productInput(), categoryId: group.json().id, marketingTags: ['普通'] });
    expect(first.deliveryCategory).toEqual(second.deliveryCategory);
    expect(first.deliveryCategory).toMatchObject({ code: 'CAKE', coreFragile: true });
    const a = await createOrder(prisma, customer, orderInput(first.id), config.campusTimeZone);
    const b = await createOrder(prisma, customer, orderInput(second.id), config.campusTimeZone);
    expect(a.items[0]!.deliveryRiskTagsSnapshot).toEqual(b.items[0]!.deliveryRiskTagsSnapshot);
    expect(a.items[0]!.coreFragileSnapshot).toBe(true);
    const view = await app.inject({ method: 'GET', url: `/orders/${a.id}`, headers: headers(seedIds.customer) });
    expect(view.json().items[0].deliveryCategory).toMatchObject({ code: 'CAKE', coreFragile: true, reviewRequired: false });
    expect(JSON.stringify(view.json())).not.toContain('platformSubsidyMinor');
    const catalog = await app.inject({ method: 'GET', url: '/merchant/catalog', headers: headers(seedIds.merchantUser) });
    expect(catalog.statusCode).toBe(200);
    expect(JSON.stringify(catalog.json())).not.toContain('merchantId');
  });

  it('checks identity, ownership, stale versions, input bounds and prevents merchant risk-map writes', async () => {
    const own = await saveProduct(prisma, merchant, productInput());
    const otherUser = await prisma.user.create({ data: { displayName: 'other merchant', role: 'MERCHANT' } });
    const other = await prisma.merchant.create({ data: { ownerId: otherUser.id, name: 'other', campusLocationId: seedIds.merchantLocation } });
    const otherGroup = await prisma.productCategory.create({ data: { merchantId: other.id, name: 'other group' } });
    expect((await app.inject({ method: 'PUT', url: `/merchant/catalog/products/${own.id}`, headers: headers(otherUser.id), payload: { ...productInput(), categoryId: otherGroup.id, expectedVersion: own.version } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PUT', url: `/merchant/catalog/categories/${seedIds.category}`, headers: headers(otherUser.id), payload: { name: 'overwrite', sortOrder: 0 } })).statusCode).toBe(404);
    await expect(saveProduct(prisma, merchant, { ...productInput(), categoryId: otherGroup.id })).rejects.toMatchObject({ statusCode: 404 });
    expect((await app.inject({ method: 'POST', url: '/merchant/catalog/products', headers: headers(seedIds.customer), payload: productInput() })).statusCode).toBe(403);
    for (const extra of [ { priceMinor: 0 }, { name: ' ' }, { marketingTags: ['x'.repeat(21)] }, { deliveryCategoryCode: 'UNKNOWN' }]) {
      expect((await app.inject({ method: 'POST', url: '/merchant/catalog/products', headers: headers(seedIds.merchantUser), payload: { ...productInput(), ...extra } })).statusCode).toBe(400);
    }
    await saveProduct(prisma, merchant, productInput('SUNDAE'), own.id, own.version);
    await expect(saveProduct(prisma, merchant, productInput(), own.id, own.version)).rejects.toMatchObject({ statusCode: 409 });
    expect((await prisma.deliveryCategory.findUniqueOrThrow({ where: { code: 'CAKE' } })).coreFragile).toBe(true);
    await prisma.productCategory.delete({ where: { id: otherGroup.id } });
    await prisma.merchant.delete({ where: { id: other.id } });
    await prisma.user.delete({ where: { id: otherUser.id } });
  });

  it('snapshots authoritative cake risk despite classifier failure and later catalog edits', async () => {
    const product = await saveProduct(prisma, merchant, productInput());
    const failing: ItemClassifier = { classify: async () => { throw new Error('offline'); } };
    const order = await createOrder(prisma, customer, orderInput(product.id), config.campusTimeZone, undefined, failing);
    expect(order.items[0]).toMatchObject({ coreFragileSnapshot: true, deliveryCategoryCodeSnapshot: 'CAKE', suggestedFoodType: 'UNKNOWN' });
    await saveProduct(prisma, merchant, { ...productInput('ORDINARY_MEAL'), name: 'later name' }, product.id, product.version);
    expect(await prisma.orderItem.findUniqueOrThrow({ where: { id: order.items[0]!.id } })).toMatchObject({ productNameSnapshot: '同名商品', deliveryCategoryCodeSnapshot: 'CAKE', coreFragileSnapshot: true, unitPriceMinor: 3000 });
  });

  it('rejects changes to product category and platform rule version during preclassification', async () => {
    const product = await saveProduct(prisma, merchant, productInput());
    const mutating: ItemClassifier = { classify: async () => {
      await saveProduct(prisma, merchant, productInput('SUNDAE'), product.id, product.version);
      return { suggestedFoodType: FoodType.OTHER, handlingTags: [], source: 'TEST', version: '1', confidenceBps: 0 };
    } };
    await expect(createOrder(prisma, customer, orderInput(product.id), config.campusTimeZone, undefined, mutating)).rejects.toMatchObject({ code: 'PRODUCT_FACTS_CHANGED' });
    await prisma.product.update({ where: { id: product.id }, data: { deliveryCategoryCode: 'CAKE' } });
    const ruleChange: ItemClassifier = { classify: async () => {
      await prisma.deliveryCategory.update({ where: { code: 'CAKE' }, data: { version: { increment: 1 } } });
      throw new Error('fallback');
    } };
    await expect(createOrder(prisma, customer, orderInput(product.id), config.campusTimeZone, undefined, ruleChange)).rejects.toMatchObject({ code: 'PRODUCT_FACTS_CHANGED' });
    expect(await prisma.order.count()).toBe(0);
  });

  it('preserves explicit UNKNOWN review state for legacy products and does not backfill old orders', async () => {
    const legacy = await prisma.product.create({ data: { merchantId: seedIds.merchant, categoryId: seedIds.category, name: 'legacy cake name', priceMinor: 6000 } });
    const order = await createOrder(prisma, customer, orderInput(legacy.id), config.campusTimeZone);
    expect(order.items[0]).toMatchObject({ deliveryCategoryCodeSnapshot: 'UNKNOWN', deliveryClassificationReviewRequired: true, coreFragileSnapshot: false });
    await saveProduct(prisma, merchant, productInput('CAKE'), legacy.id, legacy.version);
    expect(await prisma.orderItem.findUniqueOrThrow({ where: { id: order.items[0]!.id } })).toMatchObject({ deliveryCategoryCodeSnapshot: 'UNKNOWN', deliveryClassificationReviewRequired: true, unitPriceMinor: 6000 });
    const categories = await app.inject({ method: 'GET', url: '/catalog/delivery-categories', headers: headers(seedIds.merchantUser) });
    expect(categories.json().filter((c: { coreFragile: boolean }) => c.coreFragile).map((c: { code: string }) => c.code).sort()).toEqual(['CAKE', 'SUNDAE']);
  });
});
