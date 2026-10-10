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
      data: { exposureState: MerchantExposureState.NORMAL, trialExposureOverrideBps: 10_000, pickupVerificationMode: PickupVerificationMode.CONFIRMATION },
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
});
