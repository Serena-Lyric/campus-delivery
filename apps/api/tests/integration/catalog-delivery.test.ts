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
import { correctCatalogRisk, republishCorrectedOrder, reportCatalogRisk } from '../../src/catalog/risk-correction.js';
import { expireUnclaimedDeliveryTasks, releaseExpiredCoolingOrders } from '../../src/orders/lifecycle.js';
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

  async function misdeclared() {
    const task = await readyFor(seedIds.productRice);
    const claimed = await claim(task.taskId, seedIds.riderAUser);
    expect(claimed.statusCode, claimed.body).toBe(200);
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: task.orderId } });
    return { ...task, input: { assignmentId: claimed.json().activeAssignmentId as string, orderItemId: item.id, observedCategoryCode: 'CAKE' as const, reason: 'actual cake not declared' } };
  }
  const riderActor = { id: seedIds.riderAUser, role: 'RIDER' as const, riderId: seedIds.riderA };
  const reportRisk = (task: Awaited<ReturnType<typeof misdeclared>>, payload = task.input) => app.inject({ method: 'POST', url: `/delivery-tasks/${task.taskId}/report-catalog-risk`, headers: headers(seedIds.riderAUser), payload });
  const correct = (orderId: string, reportId: string, expectedRevision = 1) => app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/correct-catalog-risk`, headers: headers(seedIds.merchantUser), payload: { reportId, expectedRevision, deliveryCategoryCode: 'CAKE' } });
  const republish = (orderId: string, reportId: string, expectedRevision = 2) => app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/republish-corrected`, headers: headers(seedIds.merchantUser), payload: { reportId, expectedRevision } });

  it('releases capacity independently of ordinary cancellation and requires correction plus explicit republish', async () => {
    await prisma.rider.update({ where: { id: seedIds.riderA }, data: { capacityOverride: 1 } });
    const task = await misdeclared();
    const original = await prisma.deliveryTask.findUniqueOrThrow({ where: { id: task.taskId } });
    await prisma.order.update({ where: { id: task.orderId }, data: { merchantPreparationStatus: 'READY_FOR_PICKUP' } });
    const report = await reportRisk(task);
    expect(report.statusCode, report.body).toBe(200);
    const reportId = report.json().report.id as string;
    expect(await prisma.deliveryTask.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ status: 'RISK_REVIEW', riderId: null, firstPublishedAt: original.firstPublishedAt, claimDeadline: original.claimDeadline });
    expect(await prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: task.input.assignmentId } })).toMatchObject({ status: 'ABANDONED', reason: 'MERCHANT_CORE_FRAGILE_MISDECLARATION' });
    expect(await prisma.riderCancellationEvent.count()).toBe(0);
    expect(await prisma.riderRestriction.count()).toBe(0);
    expect((await claim(task.taskId, seedIds.riderBUser)).statusCode).toBe(409);
    expect((await republish(task.orderId, reportId, 1)).statusCode).toBe(409);
    const next = await readyFor(seedIds.productTea);
    expect((await claim(next.taskId, seedIds.riderAUser)).statusCode).toBe(200);
    const corrected = await correct(task.orderId, reportId);
    expect(corrected.statusCode, corrected.body).toBe(200);
    expect(corrected.body).not.toContain('pickupEvidenceRecommendedMinor');
    expect(corrected.body).not.toContain('pickupEvidenceRequiredMinor');
    expect(corrected.json()).toMatchObject({ revision: 2, requiresExplicitRepublish: true, risk: { coreFragileValueMinor: 1500, pickupEvidenceLevel: 'NONE' } });
    expect((await claim(task.taskId, seedIds.riderBUser)).statusCode).toBe(409);
    const publications = await Promise.all([republish(task.orderId, reportId), republish(task.orderId, reportId)]);
    expect(publications.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(await prisma.orderEvent.count({ where: { orderId: task.orderId, eventType: 'CATALOG_RISK_REPUBLISHED' } })).toBe(1);
    expect(await prisma.deliveryTask.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ status: 'OPEN', firstPublishedAt: original.firstPublishedAt, claimDeadline: original.claimDeadline });
    expect((await claim(task.taskId, seedIds.riderBUser)).statusCode).toBe(200);
    const staleRetry = await reportRisk(task);
    expect(staleRetry.statusCode).toBe(200);
    expect((await prisma.deliveryTask.findUniqueOrThrow({ where: { id: task.taskId } })).riderId).toBe(seedIds.riderB);
  });

  it('makes concurrent duplicate reports idempotent and rejects a changed retry payload', async () => {
    const task = await misdeclared();
    const results = await Promise.all([reportRisk(task), reportRisk(task)]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(results[0]!.json().report.id).toBe(results[1]!.json().report.id);
    expect(await prisma.catalogRiskReport.count()).toBe(1);
    expect(await prisma.orderEvent.count({ where: { eventType: 'RIDER_CATALOG_RISK_REPORTED' } })).toBe(1);
    expect((await reportRisk(task, { ...task.input, reason: 'changed reason' })).statusCode).toBe(409);
  });

  it('serializes report versus actual pickup without releasing an already picked-up task', async () => {
    const task = await misdeclared();
    const [reported, picked] = await Promise.all([reportRisk(task), pickup(task.taskId)]);
    expect([reported.statusCode, picked.statusCode].filter((code) => code === 200)).toHaveLength(1);
    const current = await prisma.deliveryTask.findUniqueOrThrow({ where: { id: task.taskId } });
    if (reported.statusCode === 200) {
      expect(current).toMatchObject({ status: 'RISK_REVIEW', riderId: null, pickedUpAt: null });
      expect(await prisma.catalogRiskReport.count()).toBe(1);
    } else {
      expect(current).toMatchObject({ status: 'PICKED_UP', riderId: seedIds.riderA });
      expect(await prisma.catalogRiskReport.count()).toBe(0);
    }
    expect(await prisma.riderCancellationEvent.count()).toBe(0);
  });

  it('keeps custody terminal when reporting races delivery after pickup', async () => {
    const task = await misdeclared();
    expect((await pickup(task.taskId)).statusCode).toBe(200);
    const [reported, delivered] = await Promise.all([reportRisk(task), app.inject({ method: 'POST', url: `/delivery-tasks/${task.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {} })]);
    expect(reported.statusCode).toBe(409);
    expect(delivered.statusCode, delivered.body).toBe(200);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: task.orderId } })).toMatchObject({ status: 'DELIVERED' });
    expect(await prisma.catalogRiskReport.count()).toBe(0);
  });

  it('expires late refusal exactly once under an expiry sweep race and refunds the original order', async () => {
    const task = await misdeclared();
    const deadline = (await prisma.deliveryTask.findUniqueOrThrow({ where: { id: task.taskId } })).claimDeadline!;
    const expiredAt = new Date(deadline.getTime() + 1);
    await Promise.all([reportCatalogRisk(prisma, riderActor, task.taskId, task.input, expiredAt), expireUnclaimedDeliveryTasks(prisma, expiredAt)]);
    await expireUnclaimedDeliveryTasks(prisma, expiredAt);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: task.orderId } })).toMatchObject({ status: 'NO_RIDER_ACCEPTED' });
    expect(await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: task.orderId } })).toMatchObject({ customerRefundMinor: 1800 });
    expect(await prisma.orderEvent.count({ where: { orderId: task.orderId, eventType: 'NO_RIDER_ACCEPTED' } })).toBe(1);
    expect(await prisma.riderSettlement.count({ where: { orderId: task.orderId } })).toBe(0);
    expect((await claim(task.taskId, seedIds.riderBUser)).statusCode).toBe(409);
  });

  it('expires a paused or corrected order at its original deadline and rejects stale correction/republish', async () => {
    const task = await misdeclared();
    const report = await reportRisk(task);
    const reportId = report.json().report.id as string;
    expect((await correct(task.orderId, reportId, 0)).statusCode).toBe(409);
    expect((await correct(task.orderId, reportId)).statusCode).toBe(200);
    expect((await republish(task.orderId, reportId, 1)).statusCode).toBe(409);
    const deadline = (await prisma.deliveryTask.findUniqueOrThrow({ where: { id: task.taskId } })).claimDeadline!;
    const expiredAt = new Date(deadline.getTime() + 1);
    const race = await Promise.allSettled([republishCorrectedOrder(prisma, merchant, task.orderId, { reportId, expectedRevision: 2 }, expiredAt), expireUnclaimedDeliveryTasks(prisma, expiredAt)]);
    expect(race[1]!.status).toBe('fulfilled');
    if (race[0]!.status === 'rejected') expect(race[0]!.reason).toMatchObject({ code: 'RISK_REPUBLISH_NOT_ALLOWED', statusCode: 409 });
    else expect(race[0]!.value).toMatchObject({ expired: true });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: task.orderId } })).status).toBe('NO_RIDER_ACCEPTED');
    expect(await prisma.orderEvent.count({ where: { orderId: task.orderId, eventType: 'CATALOG_RISK_REPUBLISHED' } })).toBe(0);
    expect((await claim(task.taskId, seedIds.riderBUser)).statusCode).toBe(409);
    await prisma.product.update({ where: { id: seedIds.productRice }, data: { deliveryCategoryCode: 'ORDINARY_MEAL' } });
    const paused = await misdeclared();
    expect((await reportRisk(paused)).statusCode).toBe(200);
    const pausedDeadline = (await prisma.deliveryTask.findUniqueOrThrow({ where: { id: paused.taskId } })).claimDeadline!;
    expect(await expireUnclaimedDeliveryTasks(prisma, new Date(pausedDeadline.getTime() + 1))).toBe(1);
    expect((await prisma.deliveryTask.findUniqueOrThrow({ where: { id: paused.taskId } })).status).toBe('NO_RIDER_ACCEPTED');
  });

  it('preserves sold contents, money, other earned balances and original threshold policy through correction', async () => {
    const earned = await readyFor(seedIds.productTea);
    await claim(earned.taskId, seedIds.riderAUser);
    await pickup(earned.taskId);
    expect((await app.inject({ method: 'POST', url: `/delivery-tasks/${earned.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {} })).statusCode).toBe(200);
    const balance = await prisma.riderSettlement.findUniqueOrThrow({ where: { orderId: earned.orderId } });
    const task = await misdeclared();
    expect((await app.inject({ method: 'POST', url: `/orders/${task.orderId}/rider-tip-adjustments`, headers: headers(seedIds.customer), payload: { deltaMinor: 80 } })).statusCode).toBe(201);
    const prices = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: task.orderId } });
    const sold = await prisma.orderItem.findUniqueOrThrow({ where: { id: task.input.orderItemId } });
    const report = await reportRisk(task);
    expect((await app.inject({ method: 'PUT', url: '/admin/business-configs/ORDER_POLICY', headers: headers(seedIds.admin), payload: { payload: { ...demoPolicy, fragilePickupRecommendedMinor: 1000, fragilePickupRequiredMinor: 1200 }, reason: 'new policy after sale' } })).statusCode).toBe(200);
    expect((await correct(task.orderId, report.json().report.id)).statusCode).toBe(200);
    const corrected = await prisma.orderItem.findUniqueOrThrow({ where: { id: sold.id } });
    expect(corrected).toMatchObject({ productId: sold.productId, productNameSnapshot: sold.productNameSnapshot, unitPriceMinor: sold.unitPriceMinor, quantity: sold.quantity, subtotalMinor: sold.subtotalMinor, deliveryCategoryCodeSnapshot: 'CAKE' });
    expect(await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: task.orderId } })).toEqual(prices);
    expect(await prisma.riderSettlement.findUniqueOrThrow({ where: { id: balance.id } })).toEqual(balance);
    expect(await prisma.riderSettlement.count({ where: { orderId: task.orderId } })).toBe(0);
    expect(await prisma.compensationObligation.count()).toBe(0);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: task.orderId } })).toMatchObject({ pickupEvidenceLevel: 'NONE', pickupEvidencePolicyVersion: 1, pickupEvidenceRecommendedMinor: 1500 });
    expect(await prisma.riderCancellationEvent.count()).toBe(0);
  });

  it('isolates merchant correction, prevents amount changes, and publishes the new endpoints in OpenAPI', async () => {
    const task = await misdeclared();
    const report = await reportRisk(task);
    const reportId = report.json().report.id as string;
    await expect(correctCatalogRisk(prisma, { ...merchant, merchantId: randomUUID() }, task.orderId, { reportId, expectedRevision: 1, deliveryCategoryCode: 'CAKE' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(republishCorrectedOrder(prisma, { ...merchant, merchantId: randomUUID() }, task.orderId, { reportId, expectedRevision: 1 })).rejects.toMatchObject({ statusCode: 403 });
    await expect(reportCatalogRisk(prisma, { ...riderActor, riderId: seedIds.riderB }, task.taskId, task.input)).rejects.toMatchObject({ statusCode: 403 });
    const bad = await app.inject({ method: 'POST', url: `/merchant/orders/${task.orderId}/correct-catalog-risk`, headers: headers(seedIds.merchantUser), payload: { reportId, expectedRevision: 1, deliveryCategoryCode: 'ORDINARY_MEAL', priceMinor: 1 } });
    expect(bad.statusCode).toBe(400);
    const state = await app.inject({ method: 'GET', url: `/merchant/orders/${task.orderId}/catalog-risk`, headers: headers(seedIds.merchantUser) });
    expect(state.json()).toMatchObject({ revision: 1, task: { status: 'RISK_REVIEW' }, reports: [{ id: reportId }] });
    expect(JSON.stringify(state.json())).not.toContain('assignmentId');
    const paths = app.swagger().paths!;
    for (const path of ['/delivery-tasks/{taskId}/report-catalog-risk', '/merchant/orders/{orderId}/correct-catalog-risk', '/merchant/orders/{orderId}/republish-corrected', '/delivery-tasks/{taskId}/pickup-evidence-unavailable']) expect(paths[path]).toBeDefined();
  });

  it('does not reuse a photo from an abandoned claim when the same rider reclaims a corrected core order', async () => {
    await prisma.product.update({ where: { id: seedIds.productRice }, data: { priceMinor: 6000 } });
    const task = await misdeclared();
    const oldPhoto = await photo(task.orderId);
    const report = await reportRisk(task);
    const reportId = report.json().report.id as string;
    expect((await correct(task.orderId, reportId)).statusCode).toBe(200);
    expect((await republish(task.orderId, reportId)).statusCode).toBe(200);
    expect((await claim(task.taskId, seedIds.riderAUser)).statusCode).toBe(200);
    expect((await pickup(task.taskId, { evidenceId: oldPhoto })).statusCode).toBe(409);
    expect((await pickup(task.taskId, { evidenceId: await photo(task.orderId) })).statusCode).toBe(200);
  });

  it('preserves rescue, tip and subsidy funding while refusing, correcting and reclaiming an order', async () => {
    const task = await readyFor(seedIds.productRice);
    await prisma.orderPricing.update({ where: { orderId: task.orderId }, data: { merchantRescueUpdatedAt: new Date(Date.now() - 16000) } });
    expect((await app.inject({ method: 'PATCH', url: `/merchant/orders/${task.orderId}/delivery-quote`, headers: headers(seedIds.merchantUser), payload: { newRescueContributionMinor: 100 } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/orders/${task.orderId}/rider-tip-adjustments`, headers: headers(seedIds.customer), payload: { deltaMinor: 50 } })).statusCode).toBe(201);
    await prisma.deliveryTask.update({ where: { id: task.taskId }, data: { firstPublishedAt: new Date(Date.now() - 700000) } });
    const subsidy = await app.inject({ method: 'POST', url: `/admin/orders/${task.orderId}/platform-subsidies`, headers: headers(seedIds.admin), payload: { requestedMinor: 50, reason: 'funding regression' } });
    expect(subsidy.statusCode, subsidy.body).toBe(201);
    const claimed = await claim(task.taskId, seedIds.riderAUser);
    expect(claimed.statusCode, claimed.body).toBe(200);
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: task.orderId } });
    const snapshot = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: task.orderId } });
    const subsidyAccount = await prisma.merchantSubsidyAccount.findUniqueOrThrow({ where: { id: seedIds.subsidyAccount } });
    const reported = await reportRisk({ ...task, input: { assignmentId: claimed.json().activeAssignmentId, orderItemId: item.id, observedCategoryCode: 'CAKE', reason: 'core cake omitted' } });
    expect(reported.statusCode, reported.body).toBe(200);
    const reportId = reported.json().report.id as string;
    expect((await correct(task.orderId, reportId)).statusCode).toBe(200);
    expect((await republish(task.orderId, reportId)).statusCode).toBe(200);
    const replacement = await claim(task.taskId, seedIds.riderBUser);
    expect(replacement.statusCode).toBe(200);
    expect(replacement.json().riderGuaranteedPayoutMinor).toBe(snapshot.riderGuaranteedPayoutMinor);
    expect(await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: task.orderId } })).toEqual(snapshot);
    expect(await prisma.merchantSubsidyAccount.findUniqueOrThrow({ where: { id: subsidyAccount.id } })).toEqual(subsidyAccount);
    expect(await prisma.riderSettlement.count({ where: { orderId: task.orderId } })).toBe(0);
    expect(await prisma.compensationObligation.count()).toBe(0);
    expect(await prisma.riderCancellationEvent.count()).toBe(0);
    expect(await prisma.deliveryAssignment.count({ where: { taskId: task.taskId, status: 'ACTIVE' } })).toBe(1);
  });

});
