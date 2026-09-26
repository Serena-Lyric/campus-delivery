import {
  DeliveryMethod,
  DeliveryTaskStatus,
  DeliveryVerificationMode,
  MerchantExposureState,
  OrderStatus,
  PickupVerificationMode,
  PrismaClient,
  RiderStatus,
} from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import { claimTask } from '../../src/delivery/service.js';
import { getMerchantFulfillmentMetrics } from '../../src/merchant-risk/service.js';
import type { PolicyConfig } from '../../src/merchant-policy/policies.js';
import { releaseExpiredCoolingOrders } from '../../src/orders/lifecycle.js';
import { cancelBeforePickup } from '../../src/riders/restrictions.js';
import { stableExposureBucket } from '../../src/catalog/visibility.js';
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
const riderActor = { id: seedIds.riderAUser, role: 'RIDER' as const, riderId: seedIds.riderA };

describe('audit gaps, rider exceptions, and admin operations', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    await seedDatabase(prisma);
    app = await buildApp(config, prisma);
    await app.ready();
  });

  beforeEach(async () => {
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
    await prisma.adminProfileAudit.deleteMany();
    await prisma.businessConfig.deleteMany({ where: { id: { not: seedIds.policyConfig } } });
    await prisma.businessConfig.update({ where: { id: seedIds.policyConfig }, data: { payload: demoPolicy, isActive: true } });
    await prisma.merchant.update({
      where: { id: seedIds.merchant },
      data: {
        exposureState: MerchantExposureState.NORMAL,
        trialExposureOverrideBps: 10_000,
        pickupVerificationMode: PickupVerificationMode.CONFIRMATION,
      },
    });
    await prisma.rider.updateMany({ data: { status: RiderStatus.AVAILABLE, currentConcurrentOrderLimit: 5 } });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function createReady(method: DeliveryMethod = DeliveryMethod.DESIGNATED_POINT) {
    const created = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: headers(seedIds.customer),
      payload: {
        merchantId: seedIds.merchant,
        destinationLocationId: seedIds.dormLocation,
        deliveryMethod: method,
        items: [{ productId: seedIds.productRice, quantity: 1 }, { productId: seedIds.productTea, quantity: 1 }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const orderId = created.json().id as string;
    await prisma.order.update({ where: { id: orderId }, data: { coolingOffEndsAt: new Date(Date.now() - 1000) } });
    await releaseExpiredCoolingOrders(prisma);
    const confirmed = await app.inject({
      method: 'POST', url: `/merchant/orders/${orderId}/confirm`, headers: headers(seedIds.merchantUser),
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    return { orderId, taskId: confirmed.json().deliveryTask.id as string };
  }

  async function claim(taskId: string, riderUser = seedIds.riderAUser) {
    return app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/claim`, headers: headers(riderUser) });
  }

  async function pickup(taskId: string, riderUser = seedIds.riderAUser) {
    return app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/pick-up`, headers: headers(riderUser), payload: {} });
  }

  async function pickedUpOrder() {
    const value = await createReady();
    expect((await claim(value.taskId)).statusCode).toBe(200);
    expect((await pickup(value.taskId)).statusCode).toBe(200);
    return value;
  }

  it('enforces stable TRIAL catalog exposure, explicit seed override, and hidden state', async () => {
    await prisma.merchant.update({
      where: { id: seedIds.merchant },
      data: { exposureState: MerchantExposureState.TRIAL, trialExposureOverrideBps: null },
    });
    const candidates = Array.from({ length: 200 }, (_, index) => `01000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    const visibleId = candidates.find((id) => stableExposureBucket(seedIds.merchant, id) < demoPolicy.merchantTrialExposureBps)!;
    const hiddenId = candidates.find((id) => stableExposureBucket(seedIds.merchant, id) >= demoPolicy.merchantTrialExposureBps)!;
    for (const [id, name] of [[visibleId, '灰度可见用户'], [hiddenId, '灰度不可见用户']] as const) {
      await prisma.user.upsert({ where: { id }, update: { active: true }, create: { id, displayName: name, role: 'CUSTOMER' } });
    }
    const visibleFirst = await app.inject({ method: 'GET', url: '/merchants', headers: headers(visibleId) });
    const visibleAgain = await app.inject({ method: 'GET', url: '/merchants', headers: headers(visibleId) });
    const hidden = await app.inject({ method: 'GET', url: '/merchants', headers: headers(hiddenId) });
    expect(visibleFirst.json().map((merchant: { id: string }) => merchant.id)).toContain(seedIds.merchant);
    expect(visibleAgain.body).toBe(visibleFirst.body);
    expect(hidden.json().map((merchant: { id: string }) => merchant.id)).not.toContain(seedIds.merchant);

    await prisma.merchant.update({ where: { id: seedIds.merchant }, data: { trialExposureOverrideBps: 10_000 } });
    expect((await app.inject({ method: 'GET', url: '/merchants', headers: headers(hiddenId) })).json()).toHaveLength(1);
    await prisma.merchant.update({ where: { id: seedIds.merchant }, data: { exposureState: MerchantExposureState.HIDDEN } });
    expect((await app.inject({ method: 'GET', url: '/merchants', headers: headers(visibleId) })).json()).toHaveLength(0);
  });

  it('returns customer-safe catalog and order DTOs without merchant internals', async () => {
    const products = await app.inject({
      method: 'GET', url: `/merchants/${seedIds.merchant}/products`, headers: headers(seedIds.customer),
    });
    expect(products.statusCode).toBe(200);
    for (const sensitive of ['ownerId', 'deliveryContributionMinor', 'maxConcurrentOrders', 'trialExposureOverrideBps', 'exposureState', 'pickupVerificationMode', 'subsidyAccount']) {
      expect(products.body).not.toContain(sensitive);
    }
    const ready = await createReady();
    const order = await app.inject({ method: 'GET', url: `/orders/${ready.orderId}`, headers: headers(seedIds.customer) });
    for (const sensitive of ['customerId', 'merchantId', 'platformSubsidyMinor', 'merchantDeliveryContributionMinor', 'operatorId', 'metadata']) {
      expect(order.body).not.toContain(sensitive);
    }
  });

  it('keeps terminal and rescue samples independent from newer in-progress orders', async () => {
    const base = new Date('2026-09-20T00:00:00.000Z');
    let code = 0;
    const metricOrder = async (status: OrderStatus, subsidized: boolean, offset: number) => {
      code += 1;
      const order = await prisma.order.create({
        data: {
          shortCode: `M${String(code).padStart(3, '0')}`,
          shortCodeDay: new Date('2026-09-20T00:00:00.000Z'),
          coolingOffEndsAt: base,
          tipDeadline: new Date(base.getTime() + 86_400_000),
          customerId: seedIds.customer,
          merchantId: seedIds.merchant,
          destinationLocationId: seedIds.dormLocation,
          destinationLabelSnapshot: '宿舍',
          deliveryMethod: DeliveryMethod.DESIGNATED_POINT,
          deliveryVerificationMode: DeliveryVerificationMode.DELIVERY_PHOTO,
          pickupVerificationMode: PickupVerificationMode.CONFIRMATION,
          status,
          pricing: { create: { itemSubtotalMinor: 1000, platformSubsidyMinor: subsidized ? 50 : 0, riderPayoutMinor: 150 } },
        },
      });
      const published = new Date(base.getTime() + offset * 1000);
      const taskStatus = status === OrderStatus.DELIVERED ? DeliveryTaskStatus.COMPLETED : DeliveryTaskStatus.CLAIMED;
      const task = await prisma.deliveryTask.create({
        data: {
          orderId: order.id,
          status: taskStatus,
          riderId: seedIds.riderA,
          payoutMinor: 150,
          firstPublishedAt: published,
          claimDeadline: new Date(published.getTime() + 2_400_000),
          claimedAt: new Date(published.getTime() + 1000),
          ...(status === OrderStatus.DELIVERED
            ? { pickedUpAt: new Date(published.getTime() + 2000), deliveredAt: new Date(published.getTime() + 3000) }
            : {}),
        },
      });
      await prisma.deliveryAssignment.create({
        data: {
          taskId: task.id,
          orderId: order.id,
          riderId: seedIds.riderA,
          status: status === OrderStatus.DELIVERED ? 'COMPLETED' : 'ACTIVE',
          claimedAt: new Date(published.getTime() + 1000),
          ...(status === OrderStatus.DELIVERED ? { endedAt: new Date(published.getTime() + 3000) } : {}),
          merchantQuoteMinorAtClaim: 100,
          customerTipMinorAtClaim: 0,
          platformSubsidyMinorAtClaim: subsidized ? 50 : 0,
          riderPayoutMinorAtClaim: 150,
          quoteVersionAtClaim: 1,
          claimSampleType: subsidized ? 'SUBSIDIZED' : 'NATURAL',
          claimLatencySeconds: 1,
        },
      });
    };
    await metricOrder(OrderStatus.DELIVERED, true, 1);
    await metricOrder(OrderStatus.DELIVERED, false, 2);
    for (let index = 0; index < 5; index += 1) await metricOrder(OrderStatus.CLAIMED, true, 100 + index);
    const policy = { ...demoPolicy, merchantRiskWindowOrderCount: 2, merchantRiskMinimumSampleSize: 1 } as PolicyConfig;
    const metrics = await getMerchantFulfillmentMetrics(prisma, seedIds.merchant, policy);
    expect(metrics.observableTerminalOrderCount).toBe(2);
    expect(metrics.deliveredOrderCount).toBe(2);
    expect(metrics.subsidizedTerminalClaimCount).toBe(1);
    expect(metrics.subsidizedRescuedOrderCount).toBe(1);
    expect(metrics.subsidizedClaimRescueRateBps).toBe(10_000);
  });

  it('returns a claimed task to the original pool without refreshing market timestamps', async () => {
    const ready = await createReady();
    expect((await claim(ready.taskId)).statusCode).toBe(200);
    const before = await prisma.deliveryTask.findUniqueOrThrow({ where: { id: ready.taskId } });
    const cancelled = await app.inject({
      method: 'POST',
      url: `/delivery-tasks/${ready.taskId}/pre-pickup-cancel`,
      headers: headers(seedIds.riderAUser),
      payload: { reason: 'PERSONAL_EMERGENCY', note: 'Cannot continue before pickup' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const after = await prisma.deliveryTask.findUniqueOrThrow({ where: { id: ready.taskId } });
    expect(after).toMatchObject({ status: 'OPEN', riderId: null, claimedAt: null });
    expect(after.firstPublishedAt).toEqual(before.firstPublishedAt);
    expect(after.claimDeadline).toEqual(before.claimDeadline);
    expect((await prisma.deliveryAssignment.findFirstOrThrow({ where: { taskId: ready.taskId } })).status).toBe('ABANDONED');
  });

  it('fails immediately under the original deadline when a late pre-pickup cancel releases the task', async () => {
    const ready = await createReady();
    const now = new Date('2026-09-26T10:00:00.000Z');
    await prisma.deliveryTask.update({
      where: { id: ready.taskId },
      data: { firstPublishedAt: new Date(now.getTime() - 2_500_000), claimDeadline: new Date(now.getTime() - 1000) },
    });
    await prisma.deliveryTask.update({
      where: { id: ready.taskId },
      data: { status: 'CLAIMED', riderId: seedIds.riderA, claimedAt: new Date(now.getTime() - 2000) },
    });
    await prisma.order.update({ where: { id: ready.orderId }, data: { status: 'CLAIMED' } });
    const pricing = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: ready.orderId } });
    await prisma.deliveryAssignment.create({
      data: {
        taskId: ready.taskId,
        orderId: ready.orderId,
        riderId: seedIds.riderA,
        merchantQuoteMinorAtClaim: pricing.merchantDeliveryContributionMinor,
        customerTipMinorAtClaim: pricing.customerRiderTipMinor,
        platformSubsidyMinorAtClaim: pricing.platformSubsidyMinor,
        riderPayoutMinorAtClaim: pricing.riderPayoutMinor,
        quoteVersionAtClaim: pricing.merchantQuoteVersion,
        claimSampleType: 'NATURAL',
        claimLatencySeconds: 1,
      },
    });
    await cancelBeforePickup(prisma, riderActor, ready.taskId, { reason: 'OTHER' }, config, now);
    expect((await prisma.deliveryTask.findUniqueOrThrow({ where: { id: ready.taskId } })).status).toBe('NO_RIDER_ACCEPTED');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: ready.orderId } })).status).toBe('NO_RIDER_ACCEPTED');
  });

  it('rejects responsibility-free cancellation after pickup', async () => {
    const ready = await pickedUpOrder();
    const response = await app.inject({
      method: 'POST', url: `/delivery-tasks/${ready.taskId}/pre-pickup-cancel`, headers: headers(seedIds.riderAUser), payload: { reason: 'OTHER' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('applies first/second daily behavior, pauses only new claims, and supports super-admin override', async () => {
    const first = await createReady();
    const second = await createReady();
    const held = await createReady();
    expect((await claim(first.taskId)).statusCode).toBe(200);
    expect((await claim(second.taskId)).statusCode).toBe(200);
    await cancelBeforePickup(prisma, riderActor, first.taskId, { reason: 'OTHER' }, config);
    expect((await claim(held.taskId)).statusCode).toBe(200);
    const secondCancel = await cancelBeforePickup(prisma, riderActor, second.taskId, { reason: 'VEHICLE_ISSUE' }, config);
    expect(secondCancel.summary).toMatchObject({ dailyCount: 2, warningCount: 1 });
    expect(secondCancel.summary.restrictions.some((item) => item.type === 'SAME_DAY_NEW_CLAIM_PAUSE')).toBe(true);
    expect((await prisma.deliveryTask.findUniqueOrThrow({ where: { id: held.taskId } })).status).toBe('CLAIMED');
    const blocked = await createReady();
    expect((await claim(blocked.taskId)).statusCode).toBe(409);

    const restrictionId = secondCancel.summary.restrictions[0]!.id;
    const operatorDenied = await app.inject({
      method: 'PATCH', url: `/admin/rider-restrictions/${restrictionId}`, headers: headers(seedIds.operator),
      payload: { action: 'RELEASE', reason: 'Operator cannot change cross-order restrictions' },
    });
    expect(operatorDenied.statusCode).toBe(403);
    const released = await app.inject({
      method: 'PATCH', url: `/admin/rider-restrictions/${restrictionId}`, headers: headers(seedIds.admin),
      payload: { action: 'RELEASE', reason: 'Verified emergency' },
    });
    expect(released.statusCode).toBe(200);
    expect(await prisma.riderRestrictionAudit.count({ where: { restrictionId } })).toBe(2);
  });

  it('uses Asia/Shanghai natural days and triggers the 7-day cancellation cooldown path without a second warning', async () => {
    const times = [
      new Date('2026-09-20T15:59:00.000Z'),
      new Date('2026-09-20T16:01:00.000Z'),
      new Date('2026-09-21T16:01:00.000Z'),
      new Date('2026-09-22T16:01:00.000Z'),
    ];
    for (const [index, now] of times.entries()) {
      const ready = await createReady();
      await prisma.deliveryTask.update({
        where: { id: ready.taskId },
        data: { firstPublishedAt: new Date(now.getTime() - 1000), claimDeadline: new Date(now.getTime() + 100_000) },
      });
      await claimTask(prisma, riderActor, ready.taskId, new Date(now.getTime() - 500));
      const result = await cancelBeforePickup(prisma, riderActor, ready.taskId, { reason: 'OTHER' }, config, now);
      if (index === 0 || index === 1) expect(result.event.dailyCount).toBe(1);
    }
    const summary = await app.inject({ method: 'GET', url: '/riders/me/restrictions', headers: headers(seedIds.riderAUser) });
    expect(await prisma.riderCancellationEvent.count({ where: { riderId: seedIds.riderA, warningIssued: true } })).toBe(0);
    expect(await prisma.riderRestriction.count({ where: { riderId: seedIds.riderA, type: 'ROLLING_CANCELLATION_COOLDOWN' } })).toBe(1);
    expect(summary.statusCode).toBe(200);
  });

  it('triggers the independent two-warning cooldown path', async () => {
    const days = [new Date('2026-09-23T02:00:00.000Z'), new Date('2026-09-24T02:00:00.000Z')];
    for (const day of days) {
      for (let count = 0; count < 2; count += 1) {
        const now = new Date(day.getTime() + count * 60_000);
        const ready = await createReady();
        await prisma.deliveryTask.update({ where: { id: ready.taskId }, data: { firstPublishedAt: new Date(now.getTime() - 1000), claimDeadline: new Date(now.getTime() + 100_000) } });
        await claimTask(prisma, riderActor, ready.taskId, new Date(now.getTime() - 500));
        await cancelBeforePickup(prisma, riderActor, ready.taskId, { reason: 'OTHER' }, config, now);
      }
    }
    expect(await prisma.riderCancellationEvent.count({ where: { riderId: seedIds.riderA, warningIssued: true } })).toBe(2);
    expect(await prisma.riderRestriction.count({ where: { riderId: seedIds.riderA, type: 'ROLLING_WARNING_COOLDOWN' } })).toBe(1);
  });

  it('requires customer acceptance before remake fulfillment can continue', async () => {
    const ready = await pickedUpOrder();
    const reported = await app.inject({
      method: 'POST', url: `/rider/orders/${ready.orderId}/severe-exception`, headers: headers(seedIds.riderAUser),
      payload: { type: 'SEVERE_FOOD_DAMAGE', description: 'Container opened and food is unusable' },
    });
    expect(reported.statusCode, reported.body).toBe(201);
    const caseId = reported.json().id as string;
    expect((await app.inject({ method: 'POST', url: `/delivery-tasks/${ready.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {} })).statusCode).toBe(409);
    expect((await app.inject({
      method: 'POST', url: `/exception-cases/${caseId}/remake-proposal`, headers: headers(seedIds.riderAUser),
      payload: { message: 'Merchant agreed to remake; please wait' },
    })).statusCode).toBe(201);
    expect((await app.inject({
      method: 'POST', url: `/exception-cases/${caseId}/remake-response`, headers: headers(seedIds.customer), payload: { accept: true },
    })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/delivery-tasks/${ready.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {} })).statusCode).toBe(200);
  });

  it('claims an exception case exactly once under concurrency and lets an operator resolve ordinary judgment', async () => {
    const ready = await pickedUpOrder();
    const reported = await app.inject({
      method: 'POST', url: `/orders/${ready.orderId}/exceptions`, headers: headers(seedIds.customer),
      payload: { type: 'DELIVERY_DISPUTE', description: 'Needs human evidence review' },
    });
    expect(reported.statusCode).toBe(201);
    const exceptionCase = await prisma.exceptionCase.findFirstOrThrow({ where: { orderId: ready.orderId } });
    const results = await Promise.all([
      app.inject({ method: 'POST', url: `/admin/exception-cases/${exceptionCase.id}/claim`, headers: headers(seedIds.operator), payload: { expectedVersion: 0 } }),
      app.inject({ method: 'POST', url: `/admin/exception-cases/${exceptionCase.id}/claim`, headers: headers(seedIds.admin), payload: { expectedVersion: 0 } }),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    const claimed = await prisma.exceptionCase.findUniqueOrThrow({ where: { id: exceptionCase.id } });
    const handler = claimed.currentHandlerAdminId!;
    const resolved = await app.inject({
      method: 'POST', url: `/admin/exception-cases/${exceptionCase.id}/resolve`, headers: headers(handler),
      payload: { expectedVersion: claimed.version, resolutionType: 'RESPONSIBILITY_UNDETERMINED', note: 'Evidence is insufficient to assign responsibility' },
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect((await prisma.exceptionCase.findUniqueOrThrow({ where: { id: exceptionCase.id } })).status).toBe('RESOLVED');
  });

  it('lets the assigned operator execute the predefined refund-and-close action without choosing an arbitrary amount', async () => {
    const ready = await pickedUpOrder();
    const reported = await app.inject({
      method: 'POST', url: `/rider/orders/${ready.orderId}/severe-exception`, headers: headers(seedIds.riderAUser),
      payload: { type: 'FOOD_LOST', description: 'Operator standard refund case' },
    });
    const caseId = reported.json().id as string;
    expect((await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/claim`, headers: headers(seedIds.operator), payload: { expectedVersion: 0 },
    })).statusCode).toBe(200);
    const resolved = await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/resolve`, headers: headers(seedIds.operator),
      payload: {
        expectedVersion: 1,
        resolutionType: 'REFUND_AND_CLOSE',
        note: 'Apply the system-defined original-price refund',
        idempotencyKey: `operator-refund-${caseId}`,
      },
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect((await prisma.compensationObligation.findUniqueOrThrow({ where: { caseId } })).requiredCompensationMinor).toBe(2000);
  });

  it('audits transfer, super-admin takeover, and release of case ownership', async () => {
    const ready = await pickedUpOrder();
    await app.inject({
      method: 'POST', url: `/orders/${ready.orderId}/exceptions`, headers: headers(seedIds.customer),
      payload: { type: 'DELIVERY_DISPUTE', description: 'Ownership audit case' },
    });
    const exceptionCase = await prisma.exceptionCase.findFirstOrThrow({ where: { orderId: ready.orderId } });
    expect((await app.inject({
      method: 'POST', url: `/admin/exception-cases/${exceptionCase.id}/claim`, headers: headers(seedIds.operator), payload: { expectedVersion: 0 },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST', url: `/admin/exception-cases/${exceptionCase.id}/transfer`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 1, nextHandlerAdminId: seedIds.admin, reason: 'Transfer for high-risk review' },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST', url: `/admin/exception-cases/${exceptionCase.id}/takeover`, headers: headers(seedIds.admin),
      payload: { expectedVersion: 2, nextHandlerAdminId: seedIds.operator, reason: 'Return to operator after review' },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST', url: `/admin/exception-cases/${exceptionCase.id}/release`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 3, reason: 'Return to shared pool' },
    })).statusCode).toBe(200);
    expect((await prisma.exceptionCaseAction.findMany({ where: { caseId: exceptionCase.id }, orderBy: { createdAt: 'asc' } }))
      .map((action) => action.type)).toEqual(['CREATED', 'CLASSIFIED', 'CLAIMED', 'TRANSFERRED', 'TAKEN_OVER', 'RELEASED']);
  });

  it('records idempotent refund funding without changing RiderTip or over-reserving settlements', async () => {
    const fundingOrder = await prisma.order.create({
      data: {
        shortCode: 'FUND',
        shortCodeDay: new Date('2026-09-26T00:00:00.000Z'),
        coolingOffEndsAt: new Date(),
        tipDeadline: new Date(Date.now() + 86_400_000),
        customerId: seedIds.customer,
        merchantId: seedIds.merchant,
        destinationLocationId: seedIds.dormLocation,
        destinationLabelSnapshot: '宿舍',
        deliveryMethod: DeliveryMethod.DESIGNATED_POINT,
        deliveryVerificationMode: DeliveryVerificationMode.DELIVERY_PHOTO,
        pickupVerificationMode: PickupVerificationMode.CONFIRMATION,
        status: OrderStatus.DELIVERED,
      },
    });
    await prisma.riderSettlement.create({
      data: {
        orderId: fundingOrder.id,
        riderId: seedIds.riderA,
        amountMinor: 500,
        status: 'AVAILABLE',
        pendingUntil: new Date(),
        availableAt: new Date(),
      },
    });
    const ready = await createReady();
    await app.inject({ method: 'POST', url: `/orders/${ready.orderId}/rider-tip-adjustments`, headers: headers(seedIds.customer), payload: { deltaMinor: 30 } });
    expect((await claim(ready.taskId)).statusCode).toBe(200);
    expect((await pickup(ready.taskId)).statusCode).toBe(200);
    const reported = await app.inject({
      method: 'POST', url: `/rider/orders/${ready.orderId}/severe-exception`, headers: headers(seedIds.riderAUser),
      payload: { type: 'FOOD_LOST', description: 'Food was lost after pickup' },
    });
    const caseId = reported.json().id as string;
    const request = () => app.inject({
      method: 'POST', url: `/exception-cases/${caseId}/voluntary-compensation`, headers: headers(seedIds.riderAUser),
      payload: { idempotencyKey: `refund-${caseId}`, voluntaryPaymentMinor: 100, reason: 'Rider voluntarily chose original-price compensation' },
    });
    const responses = await Promise.all([request(), request()]);
    expect(responses.every((response) => response.statusCode === 201)).toBe(true);
    expect(await prisma.compensationObligation.count({ where: { caseId } })).toBe(1);
    const obligation = await prisma.compensationObligation.findUniqueOrThrow({ where: { caseId }, include: { allocations: true } });
    expect(obligation.requiredCompensationMinor).toBe(2000);
    expect(obligation.customerRefundMinor).toBe(2000);
    expect(obligation.currentOrderReservedMinor).toBe(130);
    expect(obligation.otherUnwithdrawnReservedMinor).toBe(500);
    expect(obligation.riderVoluntaryPaymentMinor).toBe(100);
    expect(obligation.platformAdvancedMinor).toBe(1270);
    expect(obligation.outstandingMinor).toBe(1270);
    const pricing = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: ready.orderId } });
    expect(pricing.customerRiderTipMinor).toBe(30);
    expect(pricing.customerRefundMinor).toBe(2000);
    const settlements = await prisma.riderSettlement.findMany({ where: { riderId: seedIds.riderA } });
    expect(settlements.every((settlement) => settlement.reservedMinor <= settlement.amountMinor)).toBe(true);
    const customerView = await app.inject({ method: 'GET', url: `/orders/${ready.orderId}/exception-cases`, headers: headers(seedIds.customer) });
    for (const hidden of ['currentOrderReservedMinor', 'otherUnwithdrawnReservedMinor', 'platformAdvancedMinor', 'outstandingMinor']) {
      expect(customerView.body).not.toContain(hidden);
    }

    const release = () => app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/release-compensation`, headers: headers(seedIds.admin),
      payload: { idempotencyKey: `release-${caseId}`, reason: 'Super admin determined rider reservation should be released' },
    });
    const releases = await Promise.all([release(), release()]);
    expect(releases.every((response) => response.statusCode === 200)).toBe(true);
    const released = await prisma.compensationObligation.findUniqueOrThrow({ where: { caseId } });
    expect(released).toMatchObject({
      currentOrderReservedMinor: 0,
      otherUnwithdrawnReservedMinor: 0,
      platformAdvancedMinor: 1900,
      outstandingMinor: 0,
      status: 'RESOLVED',
    });
    expect(await prisma.exceptionCaseAction.count({ where: { caseId, type: 'RESERVATION_RELEASED' } })).toBe(1);
  });

  it('serializes concurrent obligations so the same unwithdrawn balance is never reserved twice', async () => {
    const cases: string[] = [];
    for (const type of ['SEVERE_FOOD_DAMAGE', 'FOOD_LOST'] as const) {
      const ready = await pickedUpOrder();
      const reported = await app.inject({
        method: 'POST', url: `/rider/orders/${ready.orderId}/severe-exception`, headers: headers(seedIds.riderAUser),
        payload: { type, description: `Concurrent compensation ${type}` },
      });
      cases.push(reported.json().id as string);
    }
    const responses = await Promise.all(cases.map((caseId) => app.inject({
      method: 'POST', url: `/exception-cases/${caseId}/voluntary-compensation`, headers: headers(seedIds.riderAUser),
      payload: { idempotencyKey: `concurrent-${caseId}`, reason: 'Concurrent reservation safety test' },
    })));
    expect(responses.every((response) => response.statusCode === 201)).toBe(true);
    const settlements = await prisma.riderSettlement.findMany({ where: { riderId: seedIds.riderA } });
    expect(settlements.reduce((sum, settlement) => sum + settlement.reservedMinor, 0))
      .toBeLessThanOrEqual(settlements.reduce((sum, settlement) => sum + settlement.amountMinor, 0));
    expect(await prisma.compensationObligation.count()).toBe(2);
  });

  it('separates operator and super-admin endpoint permissions', async () => {
    const operatorConfig = await app.inject({
      method: 'PUT', url: '/admin/business-configs/ORDER_POLICY', headers: headers(seedIds.operator),
      payload: { payload: demoPolicy, reason: 'Operator must not update global policy' },
    });
    expect(operatorConfig.statusCode).toBe(403);
    const superConfig = await app.inject({
      method: 'PUT', url: '/admin/business-configs/ORDER_POLICY', headers: headers(seedIds.admin),
      payload: { payload: demoPolicy, reason: 'Super admin policy confirmation' },
    });
    expect(superConfig.statusCode).toBe(200);
    const accessChange = await app.inject({
      method: 'PUT', url: `/admin/users/${seedIds.operator}/admin-profile`, headers: headers(seedIds.admin),
      payload: { level: 'OPERATOR', reason: 'Audit existing operator access' },
    });
    expect(accessChange.statusCode).toBe(200);
    expect(await prisma.adminProfileAudit.count({ where: { targetUserId: seedIds.operator } })).toBe(1);
  });

  it('publishes exception/admin paths and stores deterministic classifier output separately', async () => {
    const ready = await pickedUpOrder();
    await app.inject({
      method: 'POST', url: `/rider/orders/${ready.orderId}/severe-exception`, headers: headers(seedIds.riderAUser),
      payload: { type: 'SEVERE_FOOD_DAMAGE', description: 'Classifier boundary test' },
    });
    const exceptionCase = await prisma.exceptionCase.findFirstOrThrow({ where: { orderId: ready.orderId } });
    expect(exceptionCase).toMatchObject({ classifierSource: 'DETERMINISTIC_FALLBACK', classifierVersion: '1' });
    expect(exceptionCase.resolutionType).toBeNull();
    const docs = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(docs.json().paths['/admin/exception-cases/{caseId}/claim']?.post).toBeTruthy();
    expect(docs.json().paths['/delivery-tasks/{taskId}/pre-pickup-cancel']?.post).toBeTruthy();
    expect(docs.json().paths['/exception-cases/{caseId}/voluntary-compensation']?.post).toBeTruthy();
    expect(docs.json().paths['/admin/riders/{riderId}/restrictions']?.get).toBeTruthy();
  });
});
