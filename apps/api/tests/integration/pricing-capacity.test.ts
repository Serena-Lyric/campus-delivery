import { merchantPickup } from './pickup-helper.js';
import {
  DeliveryMethod,
  FoodType,
  MerchantExposureState,
  PickupVerificationMode,
  PrismaClient,
  RiderStatus,
} from '@prisma/client';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import { getMyCapacity } from '../../src/riders/capacity.js';
import { releaseExpiredCoolingOrders } from '../../src/orders/lifecycle.js';
import { createOrder } from '../../src/orders/service.js';
import type { ItemClassifier } from '../../src/item-classifier/classifier.js';
import { demoPolicy, seedDatabase, seedIds } from '../../prisma/seed.js';
import { updateMerchantBaseQuote } from '../../src/pricing/merchant-quote.js';
import { defaultDeliveryPricingPolicy } from '../../src/pricing/policy.js';
import { repriceOrder } from '../../src/pricing/service.js';
import { addPlatformSubsidy } from '../../src/subsidy/service.js';
import { claimTask } from '../../src/delivery/service.js';

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

describe('rider capacity, order pool facts, and split delivery pricing', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    await seedDatabase(prisma);
    app = await buildApp(config, prisma);
    await app.ready();
  });

  beforeEach(async () => {
    await prisma.merchantBaseDeliveryQuoteAudit.deleteMany();
    await prisma.riderBlockedMerchant.deleteMany();
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
      data: { baseDeliveryPriceMinor: 100, baseDeliveryQuoteVersion: 0, exposureState: MerchantExposureState.NORMAL, trialExposureOverrideBps: 10_000, pickupVerificationMode: PickupVerificationMode.CONFIRMATION },
    });
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
    await prisma.merchantBaseDeliveryQuoteAudit.deleteMany();
    await prisma.merchant.update({ where: { id: seedIds.merchant }, data: { baseDeliveryPriceMinor: 100, baseDeliveryQuoteVersion: 0 } });
    await app.close();
    await prisma.$disconnect();
  });

  async function createReady() {
    const input = {
      merchantId: seedIds.merchant,
      destinationLocationId: seedIds.dormLocation,
      deliveryMethod: DeliveryMethod.DESIGNATED_POINT,
      items: [{ productId: seedIds.productRice, quantity: 1 }, { productId: seedIds.productTea, quantity: 1 }],
    };
    const preview = await app.inject({ method: 'POST', url: '/orders/price-preview', headers: headers(seedIds.customer), payload: input });
    expect(preview.statusCode, preview.body).toBe(200);
    const created = await app.inject({
      method: 'POST', url: '/orders', headers: headers(seedIds.customer),
      payload: { ...input, expectedQuoteToken: preview.json().quoteToken },
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

  it('enforces tutorial capacity 1 atomically, upgrades to 2 after first delivery, then 5 next campus day', async () => {
    const first = await createReady();
    const second = await createReady();
    const concurrent = await Promise.all([claim(first.taskId, seedIds.riderBUser), claim(second.taskId, seedIds.riderBUser)]);
    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const claimedTaskId = concurrent[0]!.statusCode === 200 ? first.taskId : second.taskId;
    expect(await prisma.deliveryTask.count({ where: { riderId: seedIds.riderB, status: 'CLAIMED' } })).toBe(1);

    expect((await merchantPickup(app, prisma, claimedTaskId)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/delivery-tasks/${claimedTaskId}/deliver`, headers: headers(seedIds.riderBUser), payload: {} })).statusCode).toBe(200);
    const sameDay = await app.inject({ method: 'GET', url: '/riders/me/capacity', headers: headers(seedIds.riderBUser) });
    expect(sameDay.json()).toMatchObject({ stage: 'FIRST_DELIVERY_SAME_DAY', stageCapacity: 2, effectiveCapacity: 2 });
    expect(sameDay.json().events[0]).toMatchObject({ type: 'FIRST_DELIVERY_UPGRADE', previousCapacity: 1, newCapacity: 2 });

    const firstDeliveredAt = (await prisma.rider.findUniqueOrThrow({ where: { id: seedIds.riderB } })).firstNormalDeliveredAt!;
    const nextDay = await getMyCapacity(
      prisma,
      { id: seedIds.riderBUser, role: 'RIDER', riderId: seedIds.riderB },
      config,
      new Date(firstDeliveredAt.getTime() + 86_400_000),
    );
    expect(nextDay).toMatchObject({ stage: 'STANDARD', stageCapacity: 5, effectiveCapacity: 5 });
    expect(nextDay.events.some((event) => event.type === 'NEXT_DAY_UPGRADE' && event.newCapacity === 5)).toBe(true);
  });

  it('applies super-admin override and global cap without breaking already held orders', async () => {
    const override = await app.inject({
      method: 'PUT', url: `/admin/riders/${seedIds.riderA}/capacity-override`, headers: headers(seedIds.admin),
      payload: { capacityOverride: 2, reason: 'Controlled capacity test' },
    });
    expect(override.statusCode).toBe(200);
    const first = await createReady();
    const second = await createReady();
    expect((await claim(first.taskId, seedIds.riderAUser)).statusCode).toBe(200);
    expect((await claim(second.taskId, seedIds.riderAUser)).statusCode).toBe(200);
    expect((await app.inject({
      method: 'PUT', url: `/admin/riders/${seedIds.riderA}/capacity-override`, headers: headers(seedIds.admin),
      payload: { capacityOverride: 1, reason: 'Lower without cancelling held work' },
    })).statusCode).toBe(200);
    expect(await prisma.deliveryTask.count({ where: { riderId: seedIds.riderA, status: 'CLAIMED' } })).toBe(2);
    const third = await createReady();
    expect((await claim(third.taskId, seedIds.riderAUser)).statusCode).toBe(409);
    expect(await prisma.riderCapacityEvent.count({ where: { riderId: seedIds.riderA, type: 'ADMIN_OVERRIDE_SET' } })).toBe(2);

    const operator = await app.inject({
      method: 'PUT', url: `/admin/riders/${seedIds.riderA}/capacity-override`, headers: headers(seedIds.operator),
      payload: { capacityOverride: 3, reason: 'Operator must not override' },
    });
    expect(operator.statusCode).toBe(403);
  });

  it('takes the minimum of personal override and the versioned global absolute cap', async () => {
    expect((await app.inject({
      method: 'PUT', url: `/admin/riders/${seedIds.riderA}/capacity-override`, headers: headers(seedIds.admin),
      payload: { capacityOverride: 8, reason: 'High personal capacity within current global cap' },
    })).statusCode).toBe(200);
    const held = await Promise.all(Array.from({ length: 4 }, () => createReady()));
    for (const task of held) expect((await claim(task.taskId, seedIds.riderAUser)).statusCode).toBe(200);
    expect((await app.inject({
      method: 'PUT', url: '/admin/business-configs/ORDER_POLICY', headers: headers(seedIds.admin),
      payload: { payload: { ...demoPolicy, platformMaxConcurrentOrdersPerRider: 3 }, reason: 'Lower global capacity for safety test' },
    })).statusCode).toBe(200);
    const response = await app.inject({ method: 'GET', url: '/riders/me/capacity', headers: headers(seedIds.riderAUser) });
    expect(response.json()).toMatchObject({ personalCapacity: 8, globalAbsoluteCapacity: 3, effectiveCapacity: 3, activeHeldOrders: 4 });
    const extra = await createReady();
    expect((await claim(extra.taskId, seedIds.riderAUser)).statusCode).toBe(409);
    expect(await prisma.deliveryTask.count({ where: { riderId: seedIds.riderA, status: 'CLAIMED' } })).toBe(4);
  });

  it('returns the minimum rider decision DTO without leaking customer or internal funding fields', async () => {
    const ready = await createReady();
    const response = await app.inject({ method: 'GET', url: '/delivery-tasks/available', headers: headers(seedIds.riderAUser) });
    expect(response.statusCode).toBe(200);
    const task = response.json().find((candidate: { id: string }) => candidate.id === ready.taskId);
    expect(task).toMatchObject({
      riderGuaranteedPayoutMinor: 220,
      pickup: {
        merchantId: seedIds.merchant,
        merchantName: '校园饭堂演示店',
        locationName: '第一食堂',
        region: '东门片区',
      },
      destination: { locationId: seedIds.dormLocation, label: '学生宿舍 3 号楼', region: '一期' },
      carrying: { totalQuantity: 2, lineItemCount: 2 },
    });
    expect(task.carrying.foodTypes).toEqual(expect.arrayContaining(['RICE_MEAL', 'DRINK']));
    for (const sensitive of ['customerId', 'customerDeliveryFeeMinor', 'riderBasePayoutMinor', 'merchantRescueContributionMinor', 'platformSubsidyMinor', 'deliveryPlatformContributionMinor']) {
      expect(JSON.stringify(task)).not.toContain(sensitive);
    }
    const items = await prisma.orderItem.findMany({ where: { orderId: ready.orderId } });
    expect(items.map((item) => item.productNameSnapshot)).toEqual(expect.arrayContaining(['鸡腿饭', '柠檬茶']));
    expect(items.every((item) => item.merchantCategoryNameSnapshot === '主食')).toBe(true);
  });

  it('keeps rider fulfillment text on order snapshots after merchant and location renames', async () => {
    const ready = await createReady();
    await Promise.all([
      prisma.merchant.update({ where: { id: seedIds.merchant }, data: { name: '改名后的商家' } }),
      prisma.campusLocation.update({ where: { id: seedIds.merchantLocation }, data: { name: '改名后的取餐点' } }),
      prisma.campusLocation.update({ where: { id: seedIds.dormLocation }, data: { name: '改名后的目的地' } }),
    ]);
    try {
      const response = await app.inject({ method: 'GET', url: '/delivery-tasks/available', headers: headers(seedIds.riderAUser) });
      const task = response.json().find((candidate: { id: string }) => candidate.id === ready.taskId);
      expect(task).toMatchObject({
        pickup: {
          merchantId: seedIds.merchant,
          merchantName: '校园饭堂演示店',
          locationName: '第一食堂',
          region: '东门片区',
        },
        destination: { locationId: seedIds.dormLocation, label: '学生宿舍 3 号楼', region: '一期' },
      });
      expect(JSON.stringify(task)).not.toMatch(/改名后的商家|改名后的取餐点|改名后的目的地/);
    } finally {
      await Promise.all([
        prisma.merchant.update({ where: { id: seedIds.merchant }, data: { name: '校园饭堂演示店' } }),
        prisma.campusLocation.update({ where: { id: seedIds.merchantLocation }, data: { name: '第一食堂' } }),
        prisma.campusLocation.update({ where: { id: seedIds.dormLocation }, data: { name: '学生宿舍 3 号楼' } }),
      ]);
    }
  });

  it('falls back safely when the item classifier fails and does not change money or block order creation', async () => {
    const failingClassifier: ItemClassifier = { classify: async () => { throw new Error('Jev unavailable'); } };
    const order = await createOrder(
      prisma,
      { id: seedIds.customer, role: 'CUSTOMER' },
      {
        merchantId: seedIds.merchant,
        destinationLocationId: seedIds.dormLocation,
        deliveryMethod: DeliveryMethod.DESIGNATED_POINT,
        items: [{ productId: seedIds.productRice, quantity: 1 }],
      },
      config.campusTimeZone,
      new Date(),
      failingClassifier,
    );
    const [item, pricing] = await Promise.all([
      prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } }),
      prisma.orderPricing.findUniqueOrThrow({ where: { orderId: order.id } }),
    ]);
    expect(item).toMatchObject({ suggestedFoodType: 'UNKNOWN', classificationSource: 'MANUAL_FALLBACK' });
    expect(pricing).toMatchObject({ customerDeliveryFeeMinor: 300, riderBasePayoutMinor: 200, deliveryPlatformContributionMinor: 100 });
  });

  it('runs item classification before the write transaction and rejects stale product facts', async () => {
    const beforeCount = await prisma.order.count();
    const mutatingClassifier: ItemClassifier = {
      classify: async () => {
        await prisma.product.update({ where: { id: seedIds.productRice }, data: { name: '鸡腿饭（分类期间已变更）' } });
        return {
          suggestedFoodType: FoodType.RICE_MEAL,
          handlingTags: [],
          source: 'JEV_TEST_ADAPTER',
          version: 'test',
          confidenceBps: 9000,
        };
      },
    };
    try {
      await expect(createOrder(
        prisma,
        { id: seedIds.customer, role: 'CUSTOMER' },
        {
          merchantId: seedIds.merchant,
          destinationLocationId: seedIds.dormLocation,
          deliveryMethod: DeliveryMethod.DESIGNATED_POINT,
          items: [{ productId: seedIds.productRice, quantity: 1 }],
        },
        config.campusTimeZone,
        new Date(),
        mutatingClassifier,
      )).rejects.toMatchObject({ code: 'PRODUCT_FACTS_CHANGED' });
      expect(await prisma.order.count()).toBe(beforeCount);
    } finally {
      await prisma.product.update({ where: { id: seedIds.productRice }, data: { name: '鸡腿饭' } });
    }
  });

  it('backfills only riders with a completed assignment on a delivered order', async () => {
    const ready = await createReady();
    expect((await claim(ready.taskId, seedIds.riderAUser)).statusCode).toBe(200);
    expect((await merchantPickup(app, prisma, ready.taskId)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/delivery-tasks/${ready.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {} })).statusCode).toBe(200);
    await prisma.rider.updateMany({ data: { firstNormalDeliveredAt: null } });
    const migrationSql = await readFile(
      new URL('../../prisma/migrations/20260927000200_audit_handoff_safety_fixes/migration.sql', import.meta.url),
      'utf8',
    );
    for (const statement of migrationSql.split(';').map((part) => part.trim()).filter(Boolean)) {
      await prisma.$executeRawUnsafe(statement);
    }
    const [historical, noHistory] = await Promise.all([
      prisma.rider.findUniqueOrThrow({ where: { id: seedIds.riderA } }),
      prisma.rider.findUniqueOrThrow({ where: { id: seedIds.riderB } }),
    ]);
    expect(historical.firstNormalDeliveredAt).not.toBeNull();
    expect(noHistory.firstNormalDeliveredAt).toBeNull();
    const capacity = await getMyCapacity(
      prisma,
      { id: seedIds.riderAUser, role: 'RIDER', riderId: seedIds.riderA },
      config,
      new Date(historical.firstNormalDeliveredAt!.getTime() + 86_400_000),
    );
    expect(capacity).toMatchObject({ stage: 'STANDARD', stageCapacity: 5 });
  });

  it('keeps reference price separate and applies rescue, tip, subsidy, spread, and claim snapshots exactly', async () => {
    const ready = await createReady();
    const initial = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: ready.orderId } });
    expect(initial).toMatchObject({
      merchantBaseDeliveryPriceMinor: 100,
      customerDeliveryFeeMinor: 320,
      riderBasePayoutMinor: 220,
      merchantRescueContributionMinor: 0,
      customerRiderTipMinor: 0,
      platformSubsidyMinor: 0,
      riderGuaranteedPayoutMinor: 220,
      deliveryPlatformContributionMinor: 100,
      platformCommissionMinor: 0,
      merchantSettlementMinor: 2000,
      merchantDeliveryContributionMinor: 0,
    });
    const taskBefore = await prisma.deliveryTask.findUniqueOrThrow({ where: { id: ready.taskId } });
    await prisma.orderPricing.update({ where: { orderId: ready.orderId }, data: { merchantRescueUpdatedAt: new Date(Date.now() - 20_000) } });
    expect((await app.inject({
      method: 'PATCH', url: `/merchant/orders/${ready.orderId}/delivery-quote`, headers: headers(seedIds.merchantUser),
      payload: { newRescueContributionMinor: 50, reason: 'Rescue pass-through test' },
    })).statusCode).toBe(200);
    const afterRescue = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: ready.orderId } });
    expect(afterRescue).toMatchObject({
      merchantRescueContributionMinor: 50,
      riderGuaranteedPayoutMinor: 270,
      deliveryPlatformContributionMinor: 100,
      merchantSettlementMinor: 1950,
    });
    expect((await prisma.deliveryTask.findUniqueOrThrow({ where: { id: ready.taskId } })).claimDeadline).toEqual(taskBefore.claimDeadline);
    expect((await app.inject({
      method: 'PATCH', url: `/merchant/orders/${ready.orderId}/delivery-quote`, headers: headers(seedIds.merchantUser),
      payload: { newRescueContributionMinor: 40, reason: 'Cannot lower rescue' },
    })).statusCode).toBe(409);

    expect((await app.inject({
      method: 'POST', url: `/orders/${ready.orderId}/rider-tip-adjustments`, headers: headers(seedIds.customer), payload: { deltaMinor: 30 },
    })).statusCode).toBe(201);
    expect((await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: ready.orderId } })).deliveryPlatformContributionMinor).toBe(100);

    await prisma.deliveryTask.update({
      where: { id: ready.taskId },
      data: { firstPublishedAt: new Date(Date.now() - 700_000), claimDeadline: new Date(Date.now() + 1_000_000) },
    });
    expect((await app.inject({
      method: 'POST', url: `/admin/orders/${ready.orderId}/platform-subsidies`, headers: headers(seedIds.admin), payload: { requestedMinor: 50, reason: 'Spread reduction test' },
    })).statusCode).toBe(201);
    const beforeClaim = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: ready.orderId } });
    expect(beforeClaim).toMatchObject({
      riderGuaranteedPayoutMinor: 350,
      deliveryPlatformContributionMinor: 50,
    });
    expect((await claim(ready.taskId, seedIds.riderAUser)).statusCode).toBe(200);
    const assignment = await prisma.deliveryAssignment.findFirstOrThrow({ where: { taskId: ready.taskId } });
    expect(assignment).toMatchObject({
      customerDeliveryFeeMinorAtClaim: 320,
      riderBasePayoutMinorAtClaim: 220,
      merchantRescueContributionMinorAtClaim: 50,
      customerTipMinorAtClaim: 30,
      platformSubsidyMinorAtClaim: 50,
      riderPayoutMinorAtClaim: 350,
      riderGuaranteedPayoutMinorAtClaim: 350,
      deliveryPlatformContributionMinorAtClaim: 50,
      pricingPolicyVersionAtClaim: beforeClaim.pricingPolicyVersion,
    });
  });

  it('keeps split pricing views isolated and pricing config super-admin only', async () => {
    const ready = await createReady();
    const customer = (await app.inject({ method: 'GET', url: `/orders/${ready.orderId}/pricing`, headers: headers(seedIds.customer) })).json();
    expect(customer.customerDeliveryFeeMinor).toBe(320);
    for (const hidden of ['riderBasePayoutMinor', 'merchantRescueContributionMinor', 'deliveryPlatformContributionMinor']) expect(customer[hidden]).toBeUndefined();
    const merchant = (await app.inject({ method: 'GET', url: `/orders/${ready.orderId}/pricing`, headers: headers(seedIds.merchantUser) })).json();
    expect(merchant).toMatchObject({ merchantBaseDeliveryPriceMinor: 100, merchantRescueContributionMinor: 0 });
    expect(merchant.customerDeliveryFeeMinor).toBeUndefined();
    expect(merchant.platformSubsidyMinor).toBeUndefined();
    const rider = (await app.inject({ method: 'GET', url: `/delivery-tasks/available`, headers: headers(seedIds.riderAUser) })).json()[0];
    expect(rider.riderGuaranteedPayoutMinor).toBe(220);
    expect(rider.deliveryPlatformContributionMinor).toBeUndefined();

    const updatedPolicy = {
      ...demoPolicy,
      deliveryPricingMerchantOverrides: [{ merchantId: seedIds.merchant, customerDeliveryFeeMinor: 500, riderBasePayoutMinor: 350 }],
    };
    expect((await app.inject({
      method: 'PUT', url: '/admin/business-configs/ORDER_POLICY', headers: headers(seedIds.operator),
      payload: { payload: updatedPolicy, reason: 'Operator forbidden pricing config' },
    })).statusCode).toBe(403);
    const superUpdate = await app.inject({
      method: 'PUT', url: '/admin/business-configs/ORDER_POLICY', headers: headers(seedIds.admin),
      payload: { payload: updatedPolicy, reason: 'Super-admin merchant pricing override' },
    });
    expect(superUpdate.statusCode, superUpdate.body).toBe(200);
    const next = await createReady();
    expect((await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: next.orderId } }))).toMatchObject({
      customerDeliveryFeeMinor: 520,
      riderBasePayoutMinor: 370,
      deliveryPlatformContributionMinor: 150,
    });
    const docs = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(docs.json().paths['/riders/me/capacity']?.get).toBeTruthy();
    expect(docs.json().paths['/admin/riders/{riderId}/capacity-override']?.put).toBeTruthy();
  });

  it('activates reference BPS explicitly, audits CAS config changes and never reprices existing orders or settlements', async () => {
    const old = await createReady();
    const before = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: old.orderId } });
    const settlementBefore = await prisma.settlement.findUniqueOrThrow({ where: { orderId: old.orderId } });
    const payload = { mode: 'REFERENCE_BPS', customerMarkupBps: 2000, riderDeductionBps: 2000, rounding: 'FLOOR_ADJUSTMENTS', maxMerchantBaseMinor: 100000 };
    const configure = (userId: string, expectedVersion?: number) => app.inject({
      method: 'PUT', url: '/admin/business-configs/DELIVERY_PRICING_POLICY', headers: headers(userId),
      payload: { payload, reason: 'Isolated test rates, not approved business rates', ...(expectedVersion === undefined ? {} : { expectedVersion }) },
    });
    expect((await configure(seedIds.operator, 0)).statusCode).toBe(403);
    expect((await configure(seedIds.admin)).statusCode).toBe(400);
    const concurrent = await Promise.all([configure(seedIds.admin, 0), configure(seedIds.admin, 0)]);
    expect(concurrent.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await prisma.businessConfigAudit.count({ where: { key: 'DELIVERY_PRICING_POLICY' } })).toBe(1);
    await prisma.merchant.update({ where: { id: seedIds.merchant }, data: { baseDeliveryPriceMinor: 250 } });
    try {
      const next = await createReady();
      const pricing = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: next.orderId } });
      expect(pricing).toMatchObject({ customerDeliveryFeeMinor: 300, riderBasePayoutMinor: 200, merchantSettlementMinor: 2000, platformCommissionMinor: 0, deliveryPlatformContributionMinor: 100 });
      expect(pricing.pricingInputsSnapshot).toMatchObject({ merchantBaseDeliveryPriceMinor: 250, deliveryPricingPolicyVersion: 1, customerMarkupBps: 2000, riderDeductionBps: 2000, rounding: 'FLOOR_ADJUSTMENTS' });
      expect(await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: old.orderId } })).toEqual(before);
      expect(await prisma.settlement.findUniqueOrThrow({ where: { orderId: old.orderId } })).toEqual(settlementBefore);
      const rollback = await app.inject({ method: 'PUT', url: '/admin/business-configs/DELIVERY_PRICING_POLICY', headers: headers(seedIds.admin), payload: { payload: { mode: 'LEGACY_ORDER_POLICY' }, expectedVersion: 1, reason: 'Explicit rollback affects only new orders' } });
      expect(rollback.statusCode, rollback.body).toBe(200);
      expect(await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: next.orderId } })).toEqual(pricing);
      const legacy = await createReady();
      expect(await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: legacy.orderId } })).toMatchObject({ customerDeliveryFeeMinor: 320, riderBasePayoutMinor: 220 });
    } finally {
      await prisma.merchant.update({ where: { id: seedIds.merchant }, data: { baseDeliveryPriceMinor: 100 } });
    }
  });

  const checkoutInput = () => ({ merchantId: seedIds.merchant, destinationLocationId: seedIds.dormLocation, deliveryMethod: DeliveryMethod.DESIGNATED_POINT, items: [{ productId: seedIds.productRice, quantity: 1 }] });
  const referencePayload = { mode: 'REFERENCE_BPS', customerMarkupBps: 2000, riderDeductionBps: 2000, rounding: 'FLOOR_ADJUSTMENTS', maxMerchantBaseMinor: 100000 };
  const configureReference = (expectedVersion = 0, payload = referencePayload) => app.inject({ method: 'PUT', url: '/admin/business-configs/DELIVERY_PRICING_POLICY', headers: headers(seedIds.admin), payload: { payload, expectedVersion, reason: 'Isolated reference fixture, not business defaults' } });
  const editQuote = (baseDeliveryPriceMinor: number, expectedVersion: number, userId: string = seedIds.merchantUser) => app.inject({ method: 'PUT', url: '/merchant/base-delivery-quote', headers: headers(userId), payload: { baseDeliveryPriceMinor, expectedVersion, reason: 'Future quote fixture' } });
  const preview = (input = checkoutInput()) => app.inject({ method: 'POST', url: '/orders/price-preview', headers: headers(seedIds.customer), payload: input });
  const submitQuote = (quoteToken?: string, input = checkoutInput()) => app.inject({ method: 'POST', url: '/orders', headers: headers(seedIds.customer), payload: { ...input, ...(quoteToken ? { expectedQuoteToken: quoteToken } : {}) } });

  it('edits only future merchant reference quotes and preserves created, claimed and accounting snapshots', async () => {
    expect((await configureReference()).statusCode).toBe(200);
    expect((await editQuote(250, 0)).json()).toMatchObject({ baseDeliveryPriceMinor: 250, baseDeliveryQuoteVersion: 1, notice: '仅对后续订单生效，已付款订单不变' });
    const ready = await createReady();
    expect((await claim(ready.taskId, seedIds.riderAUser)).statusCode).toBe(200);
    const before = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: ready.orderId } });
    const assignment = await prisma.deliveryAssignment.findFirstOrThrow({ where: { taskId: ready.taskId } });
    const settlement = await prisma.settlement.findUniqueOrThrow({ where: { orderId: ready.orderId } });
    expect((await editQuote(500, 1)).statusCode).toBe(200);
    expect(await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: ready.orderId } })).toEqual(before);
    expect(await prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).toEqual(assignment);
    expect(await prisma.settlement.findUniqueOrThrow({ where: { orderId: ready.orderId } })).toEqual(settlement);
    expect((await app.inject({ method: 'PATCH', url: `/merchant/orders/${ready.orderId}/delivery-quote`, headers: headers(seedIds.merchantUser), payload: { newRescueContributionMinor: 100 } })).json()).toMatchObject({ code: 'ORDER_ALREADY_CLAIMED' });
    const quote = await preview();
    expect(quote.json()).toMatchObject({ customerDeliveryFeeMinor: 600, quoteConfirmationRequired: true, contract: 'DEVELOPMENT_QUOTE_ONLY', paymentIntegration: 'NOT_IMPLEMENTED' });
    const next = await submitQuote(quote.json().quoteToken);
    expect(next.statusCode, next.body).toBe(201);
    expect(next.json().status).toBe('CREATED');
    expect(next.json().paymentStatus).toBeUndefined();
    expect(await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: next.json().id } })).toMatchObject({ merchantBaseDeliveryPriceMinor: 500, customerDeliveryFeeMinor: 600, riderBasePayoutMinor: 400, pricingInputsSnapshot: { merchantBaseQuoteVersion: 2, customerConfirmation: 'PREVIEW_CONFIRMED' } });
    const own = await app.inject({ method: 'GET', url: '/merchant/base-delivery-quote', headers: headers(seedIds.merchantUser) });
    expect(own.json().history).toHaveLength(2);
    expect(own.json().history[0]).toMatchObject({ previousMinor: 250, newMinor: 500, actorId: seedIds.merchantUser, version: 2 });
  });

  it('requires customer reconfirmation for changed merchant, policy, product or checkout facts without writing an order', async () => {
    expect((await configureReference()).statusCode).toBe(200);
    expect((await submitQuote()).json()).toMatchObject({ code: 'QUOTE_CONFIRMATION_REQUIRED' });
    const count = await prisma.order.count();
    const original = (await preview()).json();
    expect(await prisma.order.count()).toBe(count);
    expect((await editQuote(250, 0)).statusCode).toBe(200);
    expect((await submitQuote(original.quoteToken)).json()).toMatchObject({ code: 'CHECKOUT_QUOTE_CHANGED' });
    const quoted = (await preview()).json();
    expect((await configureReference(1, { ...referencePayload, customerMarkupBps: 3000 })).statusCode).toBe(200);
    expect((await submitQuote(quoted.quoteToken)).json()).toMatchObject({ code: 'CHECKOUT_QUOTE_CHANGED' });
    const policyQuote = (await preview()).json();
    const changedQuantity = { ...checkoutInput(), items: [{ productId: seedIds.productRice, quantity: 2 }] };
    expect((await submitQuote(policyQuote.quoteToken, changedQuantity)).statusCode).toBe(409);
    await prisma.product.update({ where: { id: seedIds.productRice }, data: { priceMinor: 1600, version: { increment: 1 } } });
    try {
      expect((await submitQuote(policyQuote.quoteToken)).statusCode).toBe(409);
      expect(await prisma.order.count()).toBe(count);
      const confirmed = (await preview()).json();
      expect((await submitQuote(confirmed.quoteToken)).statusCode).toBe(201);
    } finally {
      await prisma.product.update({ where: { id: seedIds.productRice }, data: { priceMinor: 1500 } });
    }
  });

  it('isolates own merchant quote edits, rejects malformed/out-of-range values and serializes competing CAS updates', async () => {
    for (const id of [seedIds.customer, seedIds.riderAUser, seedIds.operator, seedIds.admin]) {
      expect((await editQuote(250, 0, id)).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/merchant/base-delivery-quote', headers: headers(id) })).statusCode).toBe(403);
    }
    const otherOwner = await prisma.user.create({ data: { role: 'MERCHANT', displayName: 'Quote isolation fixture' } });
    const other = await prisma.merchant.create({ data: { ownerId: otherOwner.id, name: 'Other quote fixture', campusLocationId: seedIds.merchantLocation, baseDeliveryPriceMinor: 77 } });
    try {
      expect((await app.inject({ method: 'GET', url: '/merchant/base-delivery-quote', headers: headers(otherOwner.id) })).json()).toMatchObject({ id: other.id, baseDeliveryPriceMinor: 77 });
      expect((await app.inject({ method: 'PUT', url: '/merchant/base-delivery-quote', headers: headers(seedIds.merchantUser), payload: { merchantId: other.id, baseDeliveryPriceMinor: 250, expectedVersion: 0, reason: 'Forbidden cross-store field' } })).statusCode).toBe(400);
      for (const value of [-1, 0.5, 100001, 2_147_483_647]) expect((await editQuote(value, 0)).statusCode).toBe(400);
      const edits = await Promise.all([editQuote(250, 0), editQuote(500, 0)]);
      expect(edits.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect(await prisma.merchantBaseDeliveryQuoteAudit.count({ where: { merchantId: seedIds.merchant } })).toBe(1);
      expect(await prisma.merchant.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ baseDeliveryPriceMinor: 77, baseDeliveryQuoteVersion: 0 });
    } finally {
      await prisma.merchant.delete({ where: { id: other.id } }); await prisma.user.delete({ where: { id: otherOwner.id } });
    }
  });

  it('serializes a merchant edit that wins during classification and an edit waiting behind an order snapshot', async () => {
    expect((await configureReference()).statusCode).toBe(200);
    const firstPreview = (await preview()).json();
    const classifier: ItemClassifier = { classify: async () => {
      await updateMerchantBaseQuote(prisma, { id: seedIds.merchantUser, role: 'MERCHANT', merchantId: seedIds.merchant }, { baseDeliveryPriceMinor: 250, expectedVersion: 0, reason: 'Edit wins before order transaction' });
      return { suggestedFoodType: FoodType.RICE_MEAL, handlingTags: [], source: 'FIXTURE', version: 'FIXTURE', confidenceBps: 0 };
    } };
    await expect(createOrder(prisma, { id: seedIds.customer, role: 'CUSTOMER' }, { ...checkoutInput(), expectedQuoteToken: firstPreview.quoteToken }, config.campusTimeZone, new Date(), classifier)).rejects.toMatchObject({ code: 'CHECKOUT_QUOTE_CHANGED' });
    expect(await prisma.order.count()).toBe(0);
    const quote = (await preview()).json();
    let editing: ReturnType<typeof updateMerchantBaseQuote> | undefined;
    const order = await createOrder(prisma, { id: seedIds.customer, role: 'CUSTOMER' }, { ...checkoutInput(), expectedQuoteToken: quote.quoteToken }, config.campusTimeZone, new Date(), undefined, {
      evaluate: (input, policy, pricing) => {
        editing = updateMerchantBaseQuote(prisma, { id: seedIds.merchantUser, role: 'MERCHANT', merchantId: seedIds.merchant }, { baseDeliveryPriceMinor: 500, expectedVersion: 1, reason: 'Edit waits for already locked order snapshot' });
        return defaultDeliveryPricingPolicy.evaluate(input, policy, pricing);
      },
    });
    await editing;
    expect(order.pricing).toMatchObject({ merchantBaseDeliveryPriceMinor: 250, customerDeliveryFeeMinor: 300, riderBasePayoutMinor: 200, pricingInputsSnapshot: { merchantBaseQuoteVersion: 1 } });
    expect((await preview()).json().customerDeliveryFeeMinor).toBe(600);
    expect(await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: order.id } })).toEqual(order.pricing);
  });

  it('keeps seed from overwriting audited merchant quotes, policy versions or existing order money', async () => {
    expect((await configureReference()).statusCode).toBe(200);
    expect((await editQuote(250, 0)).statusCode).toBe(200);
    const ready = await createReady();
    const pricing = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: ready.orderId } });
    const audit = await prisma.merchantBaseDeliveryQuoteAudit.findMany();
    const oldPolicy = await app.inject({ method: 'PUT', url: '/admin/business-configs/ORDER_POLICY', headers: headers(seedIds.admin), payload: { payload: { ...demoPolicy, deliveryPricingDefaultCustomerFeeMinor: 450 }, expectedVersion: 1, reason: 'Preserve this explicitly configured legacy policy on seed' } });
    expect(oldPolicy.statusCode).toBe(200);
    await seedDatabase(prisma); await seedDatabase(prisma);
    expect(await prisma.merchant.findUniqueOrThrow({ where: { id: seedIds.merchant } })).toMatchObject({ baseDeliveryPriceMinor: 250, baseDeliveryQuoteVersion: 1 });
    expect(await prisma.merchantBaseDeliveryQuoteAudit.findMany()).toEqual(audit);
    expect(await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: ready.orderId } })).toEqual(pricing);
    expect(await prisma.businessConfig.findFirstOrThrow({ where: { key: 'ORDER_POLICY', isActive: true } })).toMatchObject({ version: 2, payload: { deliveryPricingDefaultCustomerFeeMinor: 450 } });
    expect(await prisma.businessConfig.findFirstOrThrow({ where: { key: 'DELIVERY_PRICING_POLICY', isActive: true } })).toMatchObject({ version: 1, payload: referencePayload });
  });

  it('passes reference-mode rescue +100, tip +100 and subsidy +50 through without changing base spread or the 40-minute window', async () => {
    expect((await configureReference()).statusCode).toBe(200);
    expect((await editQuote(250, 0)).statusCode).toBe(200);
    const ready = await createReady();
    const taskBefore = await prisma.deliveryTask.findUniqueOrThrow({ where: { id: ready.taskId } });
    expect(taskBefore.claimDeadline!.getTime() - taskBefore.firstPublishedAt!.getTime()).toBe(40 * 60 * 1000);
    const initial = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: ready.orderId } });
    expect(initial).toMatchObject({ customerDeliveryFeeMinor: 300, riderBasePayoutMinor: 200, deliveryPlatformContributionMinor: 100, merchantSettlementMinor: 2000, platformCommissionMinor: 0 });
    await repriceOrder(prisma, { id: seedIds.merchantUser, role: 'MERCHANT', merchantId: seedIds.merchant }, ready.orderId, 100, 'Fixture funded from merchant order payable', new Date(taskBefore.firstPublishedAt!.getTime() + 20000));
    expect(await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: ready.orderId } })).toMatchObject({ merchantRescueContributionMinor: 100, merchantSettlementMinor: 1900, riderGuaranteedPayoutMinor: 300, deliveryPlatformContributionMinor: 100 });
    const tip = await app.inject({ method: 'POST', url: `/orders/${ready.orderId}/rider-tip-adjustments`, headers: headers(seedIds.customer), payload: { deltaMinor: 100 } });
    expect(tip.statusCode).toBe(201);
    expect(await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: ready.orderId } })).toMatchObject({ customerRiderTipMinor: 100, riderGuaranteedPayoutMinor: 400, deliveryPlatformContributionMinor: 100 });
    const subsidyAt = new Date(taskBefore.firstPublishedAt!.getTime() + 601000);
    await addPlatformSubsidy(prisma, { id: seedIds.admin, role: 'ADMIN', adminLevel: 'SUPER_ADMIN' }, ready.orderId, { requestedMinor: 50, reason: 'Isolated timed budget fixture' }, undefined, subsidyAt);
    const beforeClaim = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: ready.orderId } });
    expect(beforeClaim).toMatchObject({ merchantBaseDeliveryPriceMinor: 250, customerDeliveryFeeMinor: 300, riderBasePayoutMinor: 200, merchantRescueContributionMinor: 100, customerRiderTipMinor: 100, platformSubsidyMinor: 50, riderGuaranteedPayoutMinor: 450, deliveryPlatformContributionMinor: 50, merchantSettlementMinor: 1900, pricingInputsSnapshot: { basePlatformSpreadMinor: 100 } });
    expect((await prisma.merchantSubsidyAccount.findUniqueOrThrow({ where: { id: seedIds.subsidyAccount } })).subsidyUsedMinor).toBe(50);
    await claimTask(prisma, { id: seedIds.riderAUser, role: 'RIDER', riderId: seedIds.riderA }, ready.taskId, new Date(subsidyAt.getTime() + 1000), config.campusTimeZone);
    const assignment = await prisma.deliveryAssignment.findFirstOrThrow({ where: { taskId: ready.taskId } });
    expect(assignment).toMatchObject({ customerDeliveryFeeMinorAtClaim: 300, riderBasePayoutMinorAtClaim: 200, merchantRescueContributionMinorAtClaim: 100, customerTipMinorAtClaim: 100, platformSubsidyMinorAtClaim: 50, riderGuaranteedPayoutMinorAtClaim: 450, deliveryPlatformContributionMinorAtClaim: 50, pricingInputsSnapshotAtClaim: beforeClaim.pricingInputsSnapshot });
    expect((await editQuote(500, 1)).statusCode).toBe(200);
    expect((await configureReference(1, { ...referencePayload, customerMarkupBps: 4000, riderDeductionBps: 4000 })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/orders/${ready.orderId}/rider-tip-adjustments`, headers: headers(seedIds.customer), payload: { deltaMinor: 100 } })).statusCode).toBe(201);
    const after = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: ready.orderId } });
    expect(after).toMatchObject({ customerDeliveryFeeMinor: 300, riderBasePayoutMinor: 200, riderGuaranteedPayoutMinor: 550, deliveryPlatformContributionMinor: 50, pricingInputsSnapshot: initial.pricingInputsSnapshot });
    expect(await prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).toMatchObject({ riderGuaranteedPayoutMinorAtClaim: 450, postClaimTipMinor: 100, pricingInputsSnapshotAtClaim: beforeClaim.pricingInputsSnapshot });
    const taskAfter = await prisma.deliveryTask.findUniqueOrThrow({ where: { id: ready.taskId } });
    expect(taskAfter.firstPublishedAt).toEqual(taskBefore.firstPublishedAt);
    expect(taskAfter.claimDeadline).toEqual(taskBefore.claimDeadline);
  });

  it('hides both rates, policy/input snapshots and other-role funds throughout serialized public responses', async () => {
    expect((await configureReference()).statusCode).toBe(200);
    expect((await editQuote(250, 0)).statusCode).toBe(200);
    const previewResponse = await preview();
    const ready = await createReady();
    expect((await claim(ready.taskId, seedIds.riderAUser)).statusCode).toBe(200);
    const hiddenInternal = ['customerMarkupBps', 'riderDeductionBps', 'customerMarkupMinor', 'riderDeductionMinor', 'basePlatformSpreadMinor', 'pricingInputsSnapshot', 'deliveryPricingPolicyVersion', 'pricingPolicyVersion', 'merchantBaseQuoteVersion', 'activeInputs', 'reservedInputs'];
    for (const hidden of [...hiddenInternal, 'merchantBaseDeliveryPriceMinor', 'riderBasePayoutMinor', 'merchantRescueContributionMinor', 'platformSubsidyMinor']) expect(previewResponse.body).not.toContain(hidden);
    for (const [actorId, hiddenFunds] of [
      [seedIds.customer, ['merchantBaseDeliveryPriceMinor', 'riderBasePayoutMinor', 'merchantRescueContributionMinor', 'platformSubsidyMinor', 'deliveryPlatformContributionMinor']],
      [seedIds.merchantUser, ['customerDeliveryFeeMinor', 'customerRiderTipMinor', 'riderBasePayoutMinor', 'platformSubsidyMinor', 'deliveryPlatformContributionMinor']],
      [seedIds.riderAUser, ['customerDeliveryFeeMinor', 'customerRiderTipMinor', 'merchantBaseDeliveryPriceMinor', 'riderBasePayoutMinor', 'merchantRescueContributionMinor', 'platformSubsidyMinor', 'deliveryPlatformContributionMinor']],
    ] as const) {
      for (const url of [`/orders/${ready.orderId}`, `/orders/${ready.orderId}/pricing`, `/orders/${ready.orderId}/timeline`]) {
        const response = await app.inject({ method: 'GET', url, headers: headers(actorId) });
        expect(response.statusCode, response.body).toBe(200);
        for (const hidden of [...hiddenInternal, ...hiddenFunds]) expect(response.body, `${actorId} ${url}: ${hidden}`).not.toContain(hidden);
      }
    }
    const docs = (await app.inject({ method: 'GET', url: '/docs/json' })).json();
    expect(docs.paths['/orders/price-preview']?.post).toBeTruthy();
    expect(docs.paths['/merchant/base-delivery-quote']?.get).toBeTruthy();
    expect(docs.paths['/merchant/base-delivery-quote']?.put).toBeTruthy();
    expect(docs.paths['/merchant/orders/{orderId}/delivery-quote']?.patch.description).toContain('rescue');
  });

  it('rejects extreme checkout and incentive amounts atomically without price, event or budget drift', async () => {
    expect((await configureReference()).statusCode).toBe(200);
    expect((await editQuote(250, 0)).statusCode).toBe(200);
    const ready = await createReady();
    const initial = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: ready.orderId } });
    expect((await app.inject({ method: 'POST', url: `/orders/${ready.orderId}/rider-tip-adjustments`, headers: headers(seedIds.customer), payload: { deltaMinor: 2_147_483_647 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/merchant/orders/${ready.orderId}/delivery-quote`, headers: headers(seedIds.merchantUser), payload: { newRescueContributionMinor: 2_147_483_648 } })).statusCode).toBe(400);
    expect(await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: ready.orderId } })).toEqual(initial);
    expect(await prisma.riderTipEvent.count({ where: { orderId: ready.orderId } })).toBe(0);
    expect(await prisma.merchantRescueContributionEvent.count({ where: { orderId: ready.orderId } })).toBe(0);
    const subtotalOverflow = { ...checkoutInput(), items: [{ productId: seedIds.productRice, quantity: 99 }] };
    await prisma.product.update({ where: { id: seedIds.productRice }, data: { priceMinor: 100_000_000 } });
    try { expect((await preview(subtotalOverflow)).statusCode).toBe(400); } finally { await prisma.product.update({ where: { id: seedIds.productRice }, data: { priceMinor: 1500 } }); }
    const repeated = { ...checkoutInput(), items: [{ productId: seedIds.productRice, quantity: 99 }, { productId: seedIds.productRice, quantity: 1 }] };
    expect((await preview(repeated)).statusCode).toBe(400);
  });

  it('preserves finalized legacy accounting and earned rider income across later quote and policy activation', async () => {
    const delivered = await createReady();
    expect((await claim(delivered.taskId, seedIds.riderAUser)).statusCode).toBe(200);
    expect((await merchantPickup(app, prisma, delivered.taskId)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/delivery-tasks/${delivered.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {} })).statusCode).toBe(200);
    const pricing = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: delivered.orderId } });
    const settlement = await prisma.settlement.findUniqueOrThrow({ where: { orderId: delivered.orderId } });
    const income = await prisma.riderSettlement.findUniqueOrThrow({ where: { orderId: delivered.orderId } });
    const assignment = await prisma.deliveryAssignment.findFirstOrThrow({ where: { taskId: delivered.taskId } });
    expect(settlement.status).toBe('FINALIZED');
    expect((await editQuote(250, 0)).statusCode).toBe(200);
    expect((await configureReference()).statusCode).toBe(200);
    expect((await preview()).json().customerDeliveryFeeMinor).toBe(300);
    expect(await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: delivered.orderId } })).toEqual(pricing);
    expect(await prisma.settlement.findUniqueOrThrow({ where: { orderId: delivered.orderId } })).toEqual(settlement);
    expect(await prisma.riderSettlement.findUniqueOrThrow({ where: { orderId: delivered.orderId } })).toEqual(income);
    expect(await prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).toEqual(assignment);
  });

  it('snapshots platform-only fee estimates for new contracts, preserves them on config changes and exposes no verified cash', async () => {
    const old = await createReady();
    const oldPricing = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: old.orderId } });
    const configureFee = (feeBps: number, expectedVersion: number) => app.inject({ method: 'PUT', url: '/admin/business-configs/PAYMENT_COST_ESTIMATE', headers: headers(seedIds.admin), payload: { payload: { feeBps, fixedFeeMinor: 0 }, expectedVersion, reason: 'Isolated cost fixture, no actual payment' } });
    const competing = await Promise.all([configureFee(60, 0), configureFee(60, 0)]);
    expect(competing.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const next = await createReady();
    const initial = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: next.orderId } });
    expect(initial).toMatchObject({ merchantSettlementMinor: 2000, platformCommissionMinor: 0, customerDeliveryFeeMinor: 320, riderBasePayoutMinor: 220,
      pricingInputsSnapshot: { paymentCostEstimate: { status: 'ESTIMATED', amountMinor: 13, paymentBasisMinor: 2320, payer: 'PLATFORM', policyVersion: 1 } } });
    const getProjection = (id: string) => app.inject({ method: 'GET', url: `/admin/finance/orders/${id}/projection`, headers: headers(seedIds.admin) });
    expect((await getProjection(next.orderId)).json()).toMatchObject({ realWithdrawableMinor: 0, operating: { finalizedOperatingContributionMinor: 0, estimatedNetContributionMinor: null } });
    expect((await claim(next.taskId, seedIds.riderAUser)).statusCode).toBe(200);
    expect((await merchantPickup(app, prisma, next.taskId)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/delivery-tasks/${next.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {} })).statusCode).toBe(200);
    const settlement = await prisma.settlement.findUniqueOrThrow({ where: { orderId: next.orderId } });
    expect(settlement).toMatchObject({ merchantPayableMinor: 2000, riderPayableMinor: 220, platformRevenueMinor: 100 });
    const projection = await getProjection(next.orderId);
    expect(projection.statusCode).toBe(200);
    expect(projection.json()).toMatchObject({ simulated: true, notVerified: true, realWithdrawalEnabled: false, realWithdrawableMinor: 0,
      operating: { merchandiseCommissionMinor: 0, baseDeliverySpreadMinor: 100, platformSubsidyMinor: 0, finalizedOperatingContributionMinor: 100, estimatedNetContributionMinor: 87 },
      paymentCosts: { estimatedFeeMinor: 13, actualFeeMinor: null, actualStatus: 'NOT_VERIFIED', externalReceipt: null },
      thirdPartyRights: { includedInPlatformIncome: false, finalizedMerchantPayableMinor: 2000, finalizedRiderPayableMinor: 220 } });
    expect((await configureFee(100, 1)).statusCode).toBe(200);
    expect((await getProjection(next.orderId)).json()).toEqual(projection.json());
    expect((await getProjection(old.orderId)).json().paymentCosts.estimatedFeeMinor).toBeNull();
    expect(await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: old.orderId } })).toEqual(oldPricing);
    expect(await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: next.orderId } })).toEqual(initial);
    expect(await prisma.settlement.findUniqueOrThrow({ where: { orderId: next.orderId } })).toEqual(settlement);
    const future = await createReady();
    expect((await getProjection(future.orderId)).json().paymentCosts).toMatchObject({ estimatedFeeMinor: 23, estimatePolicyVersion: 2, actualFeeMinor: null });
    expect(await prisma.businessConfigAudit.count({ where: { key: 'PAYMENT_COST_ESTIMATE' } })).toBe(2);
  });

  it('denies cost fact injection and role access, validates explicit fee policy and preserves seed configuration', async () => {
    const ready = await createReady();
    const route = `/admin/finance/orders/${ready.orderId}/projection`;
    for (const userId of [seedIds.customer, seedIds.merchantUser, seedIds.riderAUser, seedIds.operator]) {
      expect((await app.inject({ method: 'GET', url: route, headers: headers(userId) })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: route })).statusCode).toBe(401);
    const configure = (payload: unknown, expectedVersion?: number, userId: string = seedIds.admin) => app.inject({ method: 'PUT', url: '/admin/business-configs/PAYMENT_COST_ESTIMATE', headers: headers(userId), payload: { payload, expectedVersion, reason: 'Cost safety fixture' } });
    expect((await configure({ feeBps: 60, fixedFeeMinor: 0 }, 0, seedIds.operator)).statusCode).toBe(403);
    for (const payload of [{ feeBps: 60 }, { feeBps: 10001, fixedFeeMinor: 0 }, { feeBps: 60, fixedFeeMinor: 0, status: 'EXTERNALLY_VERIFIED', actualFeeMinor: 12 }]) {
      expect((await configure(payload, 0)).statusCode).toBe(400);
    }
    expect((await configure({ feeBps: 60, fixedFeeMinor: 0 })).statusCode).toBe(400);
    expect((await configure({ feeBps: 60, fixedFeeMinor: 0 }, 0)).statusCode).toBe(200);
    const costPolicy = await prisma.businessConfig.findFirstOrThrow({ where: { key: 'PAYMENT_COST_ESTIMATE', isActive: true } });
    await seedDatabase(prisma);
    expect(await prisma.businessConfig.findUniqueOrThrow({ where: { id: costPolicy.id } })).toEqual(costPolicy);
    for (const url of [route, '/admin/finance/payment-costs', '/admin/finance/external-receipts', '/admin/finance/cash-balance']) {
      expect((await app.inject({ method: 'POST', url, headers: headers(seedIds.admin), payload: { amountMinor: 100000, status: 'EXTERNALLY_VERIFIED', externalReceipt: 'forged' } })).statusCode).toBe(404);
    }
    for (const userId of [seedIds.customer, seedIds.merchantUser, seedIds.riderAUser]) {
      const publicOrder = await app.inject({ method: 'GET', url: `/orders/${ready.orderId}`, headers: headers(userId) });
      if (publicOrder.statusCode === 200) for (const secret of ['paymentCostEstimate', 'estimatedFeeMinor', 'actualFeeMinor', 'platformCommissionBps']) expect(publicOrder.body).not.toContain(secret);
    }
    const docs = (await app.inject({ method: 'GET', url: '/docs/json' })).json();
    expect(docs.paths['/admin/finance/orders/{orderId}/projection'].get).toBeTruthy();
    expect(Object.keys(docs.paths).some((path) => /withdraw|salary|cash-balance|external-receipt/.test(path))).toBe(false);
  });

  for (const mode of ['LEGACY_ORDER_POLICY', 'REFERENCE_BPS']) {
    it(`keeps merchandise commission independent in ${mode}, changes only future contracts and preserves finalized income`, async () => {
      if (mode === 'REFERENCE_BPS') {
        expect((await configureReference()).statusCode).toBe(200);
        expect((await editQuote(250, 0)).statusCode).toBe(200);
      }
      const old = await createReady();
      expect((await claim(old.taskId, seedIds.riderAUser)).statusCode).toBe(200);
      expect((await merchantPickup(app, prisma, old.taskId)).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: `/delivery-tasks/${old.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {} })).statusCode).toBe(200);
      const oldPricing = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: old.orderId } });
      const oldSettlement = await prisma.settlement.findUniqueOrThrow({ where: { orderId: old.orderId } });
      const oldIncome = await prisma.riderSettlement.findUniqueOrThrow({ where: { orderId: old.orderId } });
      expect(oldPricing).toMatchObject({ platformCommissionMinor: 0, merchantSettlementMinor: 2000, pricingInputsSnapshot: { platformCommissionBps: 0 } });
      expect(oldSettlement).toMatchObject({ status: 'FINALIZED', merchantPayableMinor: 2000, platformRevenueMinor: 100 });
      const configureCommission = (userId: string, expectedVersion?: number) => app.inject({
        method: 'PUT', url: '/admin/business-configs/ORDER_POLICY', headers: headers(userId),
        payload: { payload: { ...demoPolicy, platformCommissionBps: 1250 }, reason: 'Isolated commission fixture, never business default', ...(expectedVersion === undefined ? {} : { expectedVersion }) },
      });
      expect((await configureCommission(seedIds.operator, 1)).statusCode).toBe(403);
      expect((await configureCommission(seedIds.admin)).statusCode).toBe(400);
      const changes = await Promise.all([configureCommission(seedIds.admin, 1), configureCommission(seedIds.admin, 1)]);
      expect(changes.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect(await prisma.businessConfigAudit.findFirstOrThrow({ where: { key: 'ORDER_POLICY' } })).toMatchObject({ previousVersion: 1, newVersion: 2, actorId: seedIds.admin, beforePayload: { platformCommissionBps: 0 }, afterPayload: { platformCommissionBps: 1250 } });
      const next = await createReady();
      let pricing = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: next.orderId } });
      expect(pricing).toMatchObject({ platformCommissionMinor: 250, merchantSettlementMinor: 1750, pricingPolicyVersion: 2, pricingInputsSnapshot: { platformCommissionBps: 1250 }, customerDeliveryFeeMinor: oldPricing.customerDeliveryFeeMinor, riderBasePayoutMinor: oldPricing.riderBasePayoutMinor });
      const publishedAt = (await prisma.deliveryTask.findUniqueOrThrow({ where: { id: next.taskId } })).firstPublishedAt!;
      await repriceOrder(prisma, { id: seedIds.merchantUser, role: 'MERCHANT', merchantId: seedIds.merchant }, next.orderId, 100, 'Commission isolation fixture', new Date(publishedAt.getTime() + 20000));
      expect((await app.inject({ method: 'POST', url: `/orders/${next.orderId}/rider-tip-adjustments`, headers: headers(seedIds.customer), payload: { deltaMinor: 100 } })).statusCode).toBe(201);
      await addPlatformSubsidy(prisma, { id: seedIds.admin, role: 'ADMIN', adminLevel: 'SUPER_ADMIN' }, next.orderId, { requestedMinor: 50, reason: 'FINANCE_FIXTURE' }, undefined, new Date(publishedAt.getTime() + 601000));
      pricing = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: next.orderId } });
      expect(pricing).toMatchObject({ platformCommissionMinor: 250, merchantSettlementMinor: 1650, riderGuaranteedPayoutMinor: oldPricing.riderBasePayoutMinor + 250, deliveryPlatformContributionMinor: 50 });
      expect((await claim(next.taskId, seedIds.riderAUser)).statusCode).toBe(200);
      expect((await merchantPickup(app, prisma, next.taskId)).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: `/delivery-tasks/${next.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {} })).statusCode).toBe(200);
      expect(await prisma.settlement.findUniqueOrThrow({ where: { orderId: next.orderId } })).toMatchObject({ status: 'FINALIZED', merchantPayableMinor: 1650, platformRevenueMinor: 300, riderPayableMinor: pricing.riderGuaranteedPayoutMinor });
      expect(await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: old.orderId } })).toEqual(oldPricing);
      expect(await prisma.settlement.findUniqueOrThrow({ where: { orderId: old.orderId } })).toEqual(oldSettlement);
      expect(await prisma.riderSettlement.findUniqueOrThrow({ where: { orderId: old.orderId } })).toEqual(oldIncome);
      const cancelled = await app.inject({ method: 'POST', url: '/orders', headers: headers(seedIds.customer), payload: { ...checkoutInput(), expectedQuoteToken: (await preview()).json().quoteToken } });
      expect(cancelled.statusCode).toBe(201);
      expect((await app.inject({ method: 'POST', url: `/orders/${cancelled.json().id}/cancel`, headers: headers(seedIds.customer), payload: {} })).statusCode).toBe(200);
      const cancelledPricing = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: cancelled.json().id } });
      expect(cancelledPricing.customerRefundMinor).toBe(cancelledPricing.itemSubtotalMinor + cancelledPricing.customerDeliveryFeeMinor);
      expect(await prisma.settlement.findUniqueOrThrow({ where: { orderId: cancelled.json().id } })).toMatchObject({ platformRevenueMinor: 0, merchantPayableMinor: 0 });
    });
  }

  it('rounds tiny references without an invented minimum and rejects stale confirmations even after switching back to legacy', async () => {
    expect((await configureReference()).statusCode).toBe(200);
    expect((await editQuote(0, 0)).statusCode).toBe(200);
    const zero = (await preview()).json();
    expect(zero.customerDeliveryFeeMinor).toBe(0);
    const created = await submitQuote(zero.quoteToken);
    expect(created.statusCode).toBe(201);
    expect(await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: created.json().id } })).toMatchObject({ customerDeliveryFeeMinor: 0, riderBasePayoutMinor: 0 });
    expect((await editQuote(1, 1)).statusCode).toBe(200);
    const tiny = (await preview()).json();
    expect(tiny.customerDeliveryFeeMinor).toBe(1);
    expect((await app.inject({ method: 'PUT', url: '/admin/business-configs/DELIVERY_PRICING_POLICY', headers: headers(seedIds.admin), payload: { payload: { mode: 'LEGACY_ORDER_POLICY' }, expectedVersion: 1, reason: 'Explicit rollback fixture' } })).statusCode).toBe(200);
    expect((await submitQuote(tiny.quoteToken)).json()).toMatchObject({ code: 'CHECKOUT_QUOTE_CHANGED' });
    expect((await submitQuote()).statusCode).toBe(201);
  });
});
