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
  async function readyFor(productId: string, quantity = 1, extraItems: Array<{ productId: string; quantity: number }> = []) {
    const created = await createOrder(prisma, customer, { ...orderInput(productId), items: [{ productId, quantity }, ...extraItems] }, config.campusTimeZone);
    await prisma.order.update({ where: { id: created.id }, data: { coolingOffEndsAt: new Date(Date.now() - 1000) } });
    await releaseExpiredCoolingOrders(prisma);
    const confirmed = await app.inject({ method: 'POST', url: `/merchant/orders/${created.id}/confirm`, headers: headers(seedIds.merchantUser) });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    return { orderId: created.id, taskId: confirmed.json().deliveryTask.id as string };
  }
  const pickup = (taskId: string, payload = {}) => app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/pick-up`, headers: headers(seedIds.riderAUser), payload });
  async function photo(orderId: string, user = seedIds.riderAUser, contentType = 'image/jpeg') {
    const uploaded = await app.inject({ method: 'POST', url: `/orders/${orderId}/evidence`, headers: headers(user), payload: { evidenceType: 'RIDER_PICKUP_PHOTO', media: { fileName: 'pickup.jpg', contentType, source: 'CAMERA' } } });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    expect(uploaded.json().metadata.authenticityVerified).toBe(false);
    return uploaded.json().id as string;
  }

  it.each([[1500, 'NONE'], [1501, 'RECOMMENDED'], [5000, 'RECOMMENDED'], [5001, 'REQUIRED']])('shows fixed risk before claim and enforces strict threshold at %i', async (amount, level) => {
    const product = await saveProduct(prisma, merchant, { ...productInput(), priceMinor: amount as number });
    const task = await readyFor(product.id);
    const available = await app.inject({ method: 'GET', url: '/delivery-tasks/available', headers: headers(seedIds.riderAUser) });
    const found = available.json().find((t: { id: string }) => t.id === task.taskId);
    expect(found.pickupRisk).toMatchObject({ coreFragileValueMinor: amount, evidenceLevel: level, policyVersion: 1, categories: [{ code: 'CAKE', coreFragile: true }] });
    for (const field of ['customerId', 'platformSubsidyMinor', 'merchantRescueContributionMinor', 'pickupEvidenceRequiredMinor']) expect(JSON.stringify(found)).not.toContain(field);
    expect((await claim(task.taskId, seedIds.riderAUser)).statusCode).toBe(200);
    expect((await pickup(task.taskId)).statusCode).toBe(level === 'REQUIRED' ? 409 : 200);
    const detail = await app.inject({ method: 'GET', url: `/orders/${task.orderId}`, headers: headers(seedIds.riderAUser) });
    expect(detail.json().pickupRisk.evidenceLevel).toBe(level);
  });

  it('combines two sundaes, excludes ordinary lines, and does not block high-value ordinary food', async () => {
    const sundae = await saveProduct(prisma, merchant, productInput('SUNDAE'));
    const combined = await readyFor(sundae.id, 2);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: combined.orderId } })).toMatchObject({ coreFragileValueMinor: 6000, pickupEvidenceLevel: 'REQUIRED' });
    await prisma.product.update({ where: { id: seedIds.productRice }, data: { priceMinor: 8000 } });
    const mixed = await readyFor(sundae.id, 1, [{ productId: seedIds.productRice, quantity: 1 }]);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: mixed.orderId } })).toMatchObject({ coreFragileValueMinor: 3000, pickupEvidenceLevel: 'RECOMMENDED' });
    const ordinary = await readyFor(seedIds.productRice);
    expect((await claim(ordinary.taskId, seedIds.riderAUser)).statusCode).toBe(200);
    expect((await pickup(ordinary.taskId)).statusCode).toBe(200);
  });

  it('versioned super-admin threshold edits affect only new orders before and after claims', async () => {
    const product = await saveProduct(prisma, merchant, { ...productInput(), priceMinor: 6000 });
    const original = await readyFor(product.id);
    const update = (user: string, required: number) => app.inject({ method: 'PUT', url: '/admin/business-configs/ORDER_POLICY', headers: headers(user), payload: { payload: { ...demoPolicy, fragilePickupRequiredMinor: required }, reason: 'threshold test' } });
    expect((await update(seedIds.operator, 7000)).statusCode).toBe(403);
    expect((await update(seedIds.admin, 1500)).statusCode).toBe(400);
    expect((await update(seedIds.admin, 7000)).statusCode).toBe(200);
    expect((await claim(original.taskId, seedIds.riderAUser)).json().pickupRisk).toMatchObject({ evidenceLevel: 'REQUIRED', policyVersion: 1 });
    const later = await readyFor(product.id);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: later.orderId } })).toMatchObject({ pickupEvidenceLevel: 'RECOMMENDED', pickupEvidencePolicyVersion: 2 });
    expect((await update(seedIds.admin, 8000)).statusCode).toBe(200);
    expect((await pickup(original.taskId)).statusCode).toBe(409);
    expect(await prisma.businessConfigAudit.count()).toBe(2);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: original.orderId } })).pickupEvidenceRequiredMinor).toBe(5000);
  });

  it('requires both merchant pickup code and core photo with backward-compatible evidence IDs', async () => {
    await prisma.merchant.update({ where: { id: seedIds.merchant }, data: { pickupVerificationMode: 'PICKUP_CODE' } });
    const product = await saveProduct(prisma, merchant, { ...productInput(), priceMinor: 6000 });
    const task = await readyFor(product.id);
    expect((await claim(task.taskId, seedIds.riderAUser)).statusCode).toBe(200);
    const photoId = await photo(task.orderId);
    expect((await pickup(task.taskId, { evidenceId: photoId, pickupPhotoEvidenceId: photoId })).statusCode).toBe(409);
    const issued = await app.inject({ method: 'POST', url: `/orders/${task.orderId}/pickup-code`, headers: headers(seedIds.merchantUser) });
    const verified = await app.inject({ method: 'POST', url: `/delivery-tasks/${task.taskId}/verify-pickup-code`, headers: headers(seedIds.riderAUser), payload: { code: issued.json().code } });
    expect(verified.statusCode, verified.body).toBe(200);
    expect((await pickup(task.taskId, { evidenceId: verified.json().evidenceId })).statusCode).toBe(409);
    expect((await pickup(task.taskId, { evidenceId: verified.json().evidenceId, pickupPhotoEvidenceId: photoId })).statusCode).toBe(200);
  });

  it('rejects missing, cross-order, wrong actor/role/stage/type and non-image references', async () => {
    const product = await saveProduct(prisma, merchant, { ...productInput(), priceMinor: 6000 });
    const task = await readyFor(product.id);
    const otherTask = await readyFor(product.id);
    await claim(task.taskId, seedIds.riderAUser);
    await claim(otherTask.taskId, seedIds.riderAUser);
    const crossOrder = await photo(otherTask.orderId);
    expect((await pickup(task.taskId, { evidenceId: crossOrder })).statusCode).toBe(409);
    expect((await pickup(task.taskId, { evidenceId: randomUUID() })).statusCode).toBe(409);
    const invalidImage = await photo(task.orderId, seedIds.riderAUser, 'text/plain');
    expect((await pickup(task.taskId, { evidenceId: invalidImage })).statusCode).toBe(409);
    const validId = await photo(task.orderId);
    const original = await prisma.evidence.findUniqueOrThrow({ where: { id: validId } });
    for (const change of [{ actorId: seedIds.riderBUser }, { actorRole: 'ADMIN' as const }, { orderStage: 'READY_FOR_RIDER' as const }, { evidenceType: 'MERCHANT_HANDOFF_PHOTO' as const }, { mediaReference: null }, { createdAt: new Date('2000-01-01') }]) {
      await prisma.evidence.update({ where: { id: validId }, data: change });
      expect((await pickup(task.taskId, { evidenceId: validId })).statusCode).toBe(409);
      await prisma.evidence.update({ where: { id: validId }, data: { actorId: original.actorId, actorRole: original.actorRole, orderStage: original.orderStage, evidenceType: original.evidenceType, mediaReference: original.mediaReference, createdAt: original.createdAt } });
    }
    expect((await pickup(task.taskId, { evidenceId: validId })).statusCode).toBe(200);
  });

  it('audits unavailable photo reports idempotently without granting a pickup waiver', async () => {
    const product = await saveProduct(prisma, merchant, { ...productInput(), priceMinor: 6000 });
    const task = await readyFor(product.id);
    await claim(task.taskId, seedIds.riderAUser);
    const report = () => app.inject({ method: 'POST', url: `/delivery-tasks/${task.taskId}/pickup-evidence-unavailable`, headers: headers(seedIds.riderAUser), payload: { reason: 'merchant refuses photo' } });
    const reports = await Promise.all([report(), report()]);
    expect(reports.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(reports[0]!.json()).toEqual(reports[1]!.json());
    expect(await prisma.exceptionCase.count()).toBe(1);
    expect((await pickup(task.taskId)).statusCode).toBe(409);
    const operator = await app.inject({ method: 'POST', url: `/delivery-tasks/${task.taskId}/pick-up`, headers: headers(seedIds.operator), payload: {} });
    expect(operator.statusCode).toBe(403);
    expect(await prisma.riderCancellationEvent.count()).toBe(0);
    expect((await pickup(task.taskId, { evidenceId: await photo(task.orderId) })).statusCode).toBe(200);
  });

});
