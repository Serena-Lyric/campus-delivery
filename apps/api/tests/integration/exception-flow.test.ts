import { merchantPickup } from './pickup-helper.js';
import {
  DeliveryMethod,
  DeliveryTaskStatus,
  DeliveryVerificationMode,
  ExceptionType,
  MerchantExposureState,
  OrderStatus,
  PickupVerificationMode,
  PrismaClient,
  RiderStatus,
} from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import { claimTask, deliverTask } from '../../src/delivery/service.js';
import { getMerchantFulfillmentMetrics } from '../../src/merchant-risk/service.js';
import type { PolicyConfig } from '../../src/merchant-policy/policies.js';
import { releaseExpiredCoolingOrders } from '../../src/orders/lifecycle.js';
import { cancelBeforePickup } from '../../src/riders/restrictions.js';
import { stableExposureBucket } from '../../src/catalog/visibility.js';
import { createExceptionEvent, createSevereRiderExceptionEvent } from '../../src/exceptions/service.js';
import { DeterministicExceptionClassifier, type ExceptionClassifier } from '../../src/exceptions/classifier.js';
import { releaseAvailableRiderSettlements } from '../../src/settlements/service.js';
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('audit gaps, rider exceptions, and admin operations', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    await seedDatabase(prisma);
    app = await buildApp(config, prisma);
    await app.ready();
  });

  beforeEach(async () => {
    await prisma.riderBlockedMerchant.deleteMany();
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
    await prisma.rider.updateMany({ data: { status: RiderStatus.AVAILABLE, capacityOverride: 5 } });
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

  async function pickup(taskId: string, _riderUser = seedIds.riderAUser) {
    return merchantPickup(app, prisma, taskId);
  }

  async function pickedUpOrder() {
    const value = await createReady();
    expect((await claim(value.taskId)).statusCode).toBe(200);
    expect((await pickup(value.taskId)).statusCode).toBe(200);
    return value;
  }

  async function deliveredOrder() {
    const value = await pickedUpOrder();
    const delivered = await app.inject({
      method: 'POST', url: `/delivery-tasks/${value.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {},
    });
    expect(delivered.statusCode, delivered.body).toBe(200);
    return value;
  }

  async function reportDispute(orderId: string, description: string) {
    const response = await app.inject({
      method: 'POST', url: `/orders/${orderId}/exceptions`, headers: headers(seedIds.customer),
      payload: { type: 'DELIVERY_DISPUTE', description },
    });
    expect(response.statusCode, response.body).toBe(201);
    const exceptionEventId = response.json().id as string;
    const exceptionCase = await prisma.exceptionCase.findUniqueOrThrow({ where: { exceptionEventId } });
    return { exceptionEventId, caseId: exceptionCase.id };
  }

  async function resolveDispute(caseId: string, note: string) {
    expect((await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/claim`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 0 },
    })).statusCode).toBe(200);
    const response = await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/resolve`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 1, resolutionType: 'RESPONSIBILITY_UNDETERMINED', note },
    });
    expect(response.statusCode, response.body).toBe(200);
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
          pickupMerchantNameSnapshot: '校园饭堂演示店',
          pickupLocationNameSnapshot: '第一食堂',
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
          riderGuaranteedPayoutMinorAtClaim: 150,
          quoteVersionAtClaim: 1,
          customerDeliveryFeeMinorAtClaim: 150,
          riderBasePayoutMinorAtClaim: 100,
          merchantRescueContributionMinorAtClaim: 0,
          deliveryPlatformContributionMinorAtClaim: subsidized ? 0 : 50,
          pricingPolicyVersionAtClaim: 1,
          pricingInputsSnapshotAtClaim: { source: 'METRIC_TEST' },
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
        riderGuaranteedPayoutMinorAtClaim: pricing.riderGuaranteedPayoutMinor,
        quoteVersionAtClaim: pricing.merchantQuoteVersion,
        customerDeliveryFeeMinorAtClaim: pricing.customerDeliveryFeeMinor,
        riderBasePayoutMinorAtClaim: pricing.riderBasePayoutMinor,
        merchantRescueContributionMinorAtClaim: pricing.merchantRescueContributionMinor,
        deliveryPlatformContributionMinorAtClaim: pricing.deliveryPlatformContributionMinor,
        pricingPolicyVersionAtClaim: pricing.pricingPolicyVersion,
        pricingInputsSnapshotAtClaim: pricing.pricingInputsSnapshot ?? {},
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
    const thirdCancel = await app.inject({
      method: 'POST', url: `/delivery-tasks/${held.taskId}/pre-pickup-cancel`, headers: headers(seedIds.riderAUser), payload: { reason: 'OTHER' },
    });
    expect(thirdCancel.statusCode).toBe(409);
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

  it('keeps severe self-reports behind the responsible-rider-after-pickup route', async () => {
    const ready = await createReady();
    const customerAttempt = await app.inject({
      method: 'POST', url: `/orders/${ready.orderId}/exceptions`, headers: headers(seedIds.customer),
      payload: { type: 'SEVERE_FOOD_DAMAGE', description: 'Customer must use a dispute rather than forge a rider report' },
    });
    expect(customerAttempt.statusCode).toBe(400);
    expect(await prisma.exceptionEvent.count({ where: { orderId: ready.orderId } })).toBe(0);

    expect((await claim(ready.taskId)).statusCode).toBe(200);
    const beforePickupAttempt = await app.inject({
      method: 'POST', url: `/orders/${ready.orderId}/exceptions`, headers: headers(seedIds.riderAUser),
      payload: { type: 'FOOD_LOST', description: 'Rider has not picked up the order' },
    });
    expect(beforePickupAttempt.statusCode).toBe(400);
    expect(await prisma.exceptionEvent.count({ where: { orderId: ready.orderId } })).toBe(0);

    expect((await pickup(ready.taskId)).statusCode).toBe(200);
    const dedicated = await app.inject({
      method: 'POST', url: `/rider/orders/${ready.orderId}/severe-exception`, headers: headers(seedIds.riderAUser),
      payload: { type: 'FOOD_LOST', description: 'Responsible rider reports after pickup' },
    });
    expect(dedicated.statusCode, dedicated.body).toBe(201);
    expect(await prisma.exceptionCase.count({ where: { orderId: ready.orderId } })).toBe(1);
  });

  it('serializes severe reporting and delivery across the same Order then DeliveryTask locks', async () => {
    const reportFirst = await pickedUpOrder();
    const reportEntered = deferred();
    const releaseReport = deferred();
    const deterministic = new DeterministicExceptionClassifier();
    const blockingClassifier: ExceptionClassifier = {
      source: deterministic.source,
      version: deterministic.version,
      classify: async (input) => {
        reportEntered.resolve();
        await releaseReport.promise;
        return deterministic.classify(input);
      },
    };
    const reportPromise = createSevereRiderExceptionEvent(
      prisma,
      riderActor,
      reportFirst.orderId,
      { type: ExceptionType.FOOD_LOST, description: 'Report transaction owns the delivery boundary first' },
      blockingClassifier,
    );
    await reportEntered.promise;
    const blockedDelivery = deliverTask(prisma, riderActor, reportFirst.taskId, {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseReport.resolve();
    await reportPromise;
    await expect(blockedDelivery).rejects.toMatchObject({ code: 'SEVERE_EXCEPTION_UNRESOLVED' });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: reportFirst.orderId } })).status).toBe('PICKED_UP');
    expect(await prisma.exceptionCase.count({ where: { orderId: reportFirst.orderId, status: 'OPEN' } })).toBe(1);

    const deliveryFirst = await pickedUpOrder();
    const deliveryLocked = deferred();
    const releaseDelivery = deferred();
    const deliveryPromise = deliverTask(
      prisma,
      riderActor,
      deliveryFirst.taskId,
      {},
      new Date(),
      config.campusTimeZone,
      async () => {
        deliveryLocked.resolve();
        await releaseDelivery.promise;
      },
    );
    await deliveryLocked.promise;
    const lateReport = createSevereRiderExceptionEvent(
      prisma,
      riderActor,
      deliveryFirst.orderId,
      { type: ExceptionType.SEVERE_FOOD_DAMAGE, description: 'Delivery transaction owns the boundary first' },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseDelivery.resolve();
    await deliveryPromise;
    await expect(lateReport).rejects.toMatchObject({ code: 'SEVERE_EXCEPTION_STAGE_INVALID' });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: deliveryFirst.orderId } })).status).toBe('DELIVERED');
    expect((await prisma.deliveryTask.findUniqueOrThrow({ where: { id: deliveryFirst.taskId } })).status).toBe('COMPLETED');
    expect(await prisma.exceptionCase.count({ where: { orderId: deliveryFirst.orderId } })).toBe(0);
  });

  it('records wrong address as a user-responsibility fact without opening an admin case', async () => {
    const ready = await createReady();
    const wrongAddress = await app.inject({
      method: 'POST', url: `/orders/${ready.orderId}/exceptions`, headers: headers(seedIds.customer),
      payload: { type: 'WRONG_ADDRESS', description: 'Customer selected the wrong campus location' },
    });
    expect(wrongAddress.statusCode, wrongAddress.body).toBe(201);
    expect(await prisma.exceptionEvent.count({ where: { orderId: ready.orderId, type: 'WRONG_ADDRESS' } })).toBe(1);
    expect(await prisma.exceptionCase.count({ where: { orderId: ready.orderId } })).toBe(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: ready.orderId } })).status).toBe('READY_FOR_RIDER');

    const dispute = await app.inject({
      method: 'POST', url: `/orders/${ready.orderId}/exceptions`, headers: headers(seedIds.customer),
      payload: { type: 'DELIVERY_DISPUTE', description: 'A later dispute requires admin review' },
    });
    expect(dispute.statusCode, dispute.body).toBe(201);
    expect(await prisma.exceptionCase.count({ where: { orderId: ready.orderId } })).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: ready.orderId } })).status).toBe('READY_FOR_RIDER');
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
    expect((await prisma.exceptionEvent.findFirstOrThrow({ where: { exceptionCase: { id: caseId } } })).resolvedAt).not.toBeNull();
    expect((await app.inject({ method: 'POST', url: `/delivery-tasks/${ready.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {} })).statusCode).toBe(200);
  });

  it('does not let admin CONTINUE_FULFILLMENT bypass customer confirmation for a severe case', async () => {
    const ready = await pickedUpOrder();
    const reported = await app.inject({
      method: 'POST', url: `/rider/orders/${ready.orderId}/severe-exception`, headers: headers(seedIds.riderAUser),
      payload: { type: 'SEVERE_FOOD_DAMAGE', description: 'Severe case requires customer-confirmed remake' },
    });
    const caseId = reported.json().id as string;
    expect((await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/claim`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 0 },
    })).statusCode).toBe(200);
    const adminContinue = await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/resolve`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 1, resolutionType: 'CONTINUE_FULFILLMENT', note: 'Cannot replace customer confirmation' },
    });
    expect(adminContinue.statusCode).toBe(409);
    expect(adminContinue.json()).toMatchObject({ code: 'SEVERE_REMAKE_CONFIRMATION_REQUIRED' });
    expect((await app.inject({
      method: 'POST', url: `/delivery-tasks/${ready.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {},
    })).statusCode).toBe(409);

    expect((await app.inject({
      method: 'POST', url: `/exception-cases/${caseId}/remake-proposal`, headers: headers(seedIds.riderAUser),
      payload: { message: 'Merchant will remake the order' },
    })).statusCode).toBe(201);
    expect((await app.inject({
      method: 'POST', url: `/exception-cases/${caseId}/remake-response`, headers: headers(seedIds.customer), payload: { accept: true },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST', url: `/delivery-tasks/${ready.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {},
    })).statusCode).toBe(200);
  });

  it('keeps delivery blocked while any earlier severe incident remains unresolved', async () => {
    const ready = await pickedUpOrder();
    const older = await app.inject({
      method: 'POST', url: `/rider/orders/${ready.orderId}/severe-exception`, headers: headers(seedIds.riderAUser),
      payload: { type: 'FOOD_LOST', description: 'Earlier severe incident' },
    });
    const newer = await app.inject({
      method: 'POST', url: `/rider/orders/${ready.orderId}/severe-exception`, headers: headers(seedIds.riderAUser),
      payload: { type: 'SEVERE_FOOD_DAMAGE', description: 'Later severe incident' },
    });
    const olderCaseId = older.json().id as string;
    const newerCaseId = newer.json().id as string;
    await app.inject({
      method: 'POST', url: `/exception-cases/${newerCaseId}/remake-proposal`, headers: headers(seedIds.riderAUser),
      payload: { message: 'Resolve only the newer incident first' },
    });
    await app.inject({
      method: 'POST', url: `/exception-cases/${newerCaseId}/remake-response`, headers: headers(seedIds.customer), payload: { accept: true },
    });
    expect((await app.inject({
      method: 'POST', url: `/delivery-tasks/${ready.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {},
    })).statusCode).toBe(409);

    await app.inject({
      method: 'POST', url: `/exception-cases/${olderCaseId}/remake-proposal`, headers: headers(seedIds.riderAUser),
      payload: { message: 'Resolve the earlier incident too' },
    });
    await app.inject({
      method: 'POST', url: `/exception-cases/${olderCaseId}/remake-response`, headers: headers(seedIds.customer), payload: { accept: true },
    });
    expect((await app.inject({
      method: 'POST', url: `/delivery-tasks/${ready.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {},
    })).statusCode).toBe(200);
  });

  it('keeps CONTINUE_FULFILLMENT available for a non-severe case', async () => {
    const ready = await pickedUpOrder();
    await app.inject({
      method: 'POST', url: `/orders/${ready.orderId}/exceptions`, headers: headers(seedIds.customer),
      payload: { type: 'MINOR_DAMAGE_OR_DELAY', description: 'Minor issue can continue under ordinary admin handling' },
    });
    const exceptionCase = await prisma.exceptionCase.findFirstOrThrow({ where: { orderId: ready.orderId } });
    await app.inject({
      method: 'POST', url: `/admin/exception-cases/${exceptionCase.id}/claim`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 0 },
    });
    const continued = await app.inject({
      method: 'POST', url: `/admin/exception-cases/${exceptionCase.id}/resolve`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 1, resolutionType: 'CONTINUE_FULFILLMENT', note: 'Minor issue resolved without remake' },
    });
    expect(continued.statusCode, continued.body).toBe(200);
    expect((await app.inject({
      method: 'POST', url: `/delivery-tasks/${ready.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {},
    })).statusCode).toBe(200);
  });

  it('returns an unhandled rejected remake to a clean, claimable shared-pool state', async () => {
    const ready = await pickedUpOrder();
    const reported = await app.inject({
      method: 'POST', url: `/rider/orders/${ready.orderId}/severe-exception`, headers: headers(seedIds.riderAUser),
      payload: { type: 'FOOD_LOST', description: 'Customer may reject waiting for a remake' },
    });
    const caseId = reported.json().id as string;
    expect((await app.inject({
      method: 'POST', url: `/exception-cases/${caseId}/remake-proposal`, headers: headers(seedIds.riderAUser),
      payload: { message: 'A remake can be prepared' },
    })).statusCode).toBe(201);
    expect((await app.inject({
      method: 'POST', url: `/exception-cases/${caseId}/remake-response`, headers: headers(seedIds.customer), payload: { accept: false },
    })).statusCode).toBe(200);
    expect((await prisma.exceptionCase.findUniqueOrThrow({ where: { id: caseId } }))).toMatchObject({
      status: 'OPEN',
      currentHandlerAdminId: null,
      claimedAt: null,
      resolutionType: null,
      resolutionNote: null,
      resolvedAt: null,
    });
    expect((await prisma.exceptionCaseAction.findMany({ where: { caseId } })).map((action) => action.type))
      .toEqual(['CREATED', 'CLASSIFIED', 'REQUESTED_INFORMATION', 'REMAKE_REJECTED']);
    expect((await prisma.exceptionCaseAction.findFirstOrThrow({ where: { caseId, type: 'REMAKE_REJECTED' } })).metadata)
      .toMatchObject({ resultingCaseStatus: 'OPEN' });
    expect((await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/claim`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 2 },
    })).statusCode).toBe(200);
  });

  it('returns a handled rejected remake to its operator without stale resolution metadata', async () => {
    const ready = await pickedUpOrder();
    const reported = await app.inject({
      method: 'POST', url: `/rider/orders/${ready.orderId}/severe-exception`, headers: headers(seedIds.riderAUser),
      payload: { type: 'SEVERE_FOOD_DAMAGE', description: 'Handled remake rejection case' },
    });
    const caseId = reported.json().id as string;
    await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/claim`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 0 },
    });
    await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/resolve`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 1, resolutionType: 'WAITING_FOR_INFORMATION', note: 'Stale metadata must be cleared' },
    });
    await app.inject({
      method: 'POST', url: `/exception-cases/${caseId}/remake-proposal`, headers: headers(seedIds.riderAUser),
      payload: { message: 'Customer can choose whether to wait' },
    });
    await app.inject({
      method: 'POST', url: `/exception-cases/${caseId}/remake-response`, headers: headers(seedIds.customer), payload: { accept: false },
    });
    const rejected = await prisma.exceptionCase.findUniqueOrThrow({ where: { id: caseId } });
    expect(rejected).toMatchObject({
      status: 'IN_PROGRESS',
      currentHandlerAdminId: seedIds.operator,
      resolutionType: null,
      resolutionNote: null,
      resolvedAt: null,
    });
    const rejectAction = await prisma.exceptionCaseAction.findFirstOrThrow({ where: { caseId, type: 'REMAKE_REJECTED' } });
    expect(rejectAction.metadata).toMatchObject({ resultingCaseStatus: 'IN_PROGRESS' });
    expect(await prisma.exceptionCaseAction.count({ where: { caseId, type: 'RELEASED' } })).toBe(0);
    expect((await prisma.exceptionEvent.findFirstOrThrow({ where: { exceptionCase: { id: caseId } } })).resolvedAt).toBeNull();
    const resolved = await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/resolve`, headers: headers(seedIds.operator),
      payload: { expectedVersion: rejected.version, resolutionType: 'RESPONSIBILITY_UNDETERMINED', note: 'Operator remains able to handle the case' },
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
  });

  it('blocks rider remake proposals after escalation', async () => {
    const ready = await pickedUpOrder();
    const reported = await app.inject({
      method: 'POST', url: `/rider/orders/${ready.orderId}/severe-exception`, headers: headers(seedIds.riderAUser),
      payload: { type: 'SEVERE_FOOD_DAMAGE', description: 'Escalated before a remake proposal' },
    });
    const caseId = reported.json().id as string;
    await app.inject({ method: 'POST', url: `/admin/exception-cases/${caseId}/claim`, headers: headers(seedIds.operator), payload: { expectedVersion: 0 } });
    await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/escalate`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 1, reason: 'Escalate before participant action' },
    });
    const proposal = await app.inject({
      method: 'POST', url: `/exception-cases/${caseId}/remake-proposal`, headers: headers(seedIds.riderAUser),
      payload: { message: 'This must not reopen an escalated case' },
    });
    expect(proposal.statusCode).toBe(409);
    expect((await prisma.exceptionCase.findUniqueOrThrow({ where: { id: caseId } })).status).toBe('ESCALATED');
    expect(await prisma.remakeProposal.count({ where: { caseId } })).toBe(0);
  });

  it('blocks both customer remake responses when a pending proposal is escalated', async () => {
    const ready = await pickedUpOrder();
    const reported = await app.inject({
      method: 'POST', url: `/rider/orders/${ready.orderId}/severe-exception`, headers: headers(seedIds.riderAUser),
      payload: { type: 'FOOD_LOST', description: 'Escalated while remake confirmation is pending' },
    });
    const caseId = reported.json().id as string;
    await app.inject({
      method: 'POST', url: `/exception-cases/${caseId}/remake-proposal`, headers: headers(seedIds.riderAUser),
      payload: { message: 'Pending customer decision' },
    });
    await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/takeover`, headers: headers(seedIds.admin),
      payload: { expectedVersion: 1, nextHandlerAdminId: seedIds.operator, reason: 'Assign pending case for escalation' },
    });
    await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/escalate`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 2, reason: 'Participant decision now requires super-admin control' },
    });
    for (const accept of [true, false]) {
      const response = await app.inject({
        method: 'POST', url: `/exception-cases/${caseId}/remake-response`, headers: headers(seedIds.customer), payload: { accept },
      });
      expect(response.statusCode).toBe(409);
      expect((await prisma.exceptionCase.findUniqueOrThrow({ where: { id: caseId } })).status).toBe('ESCALATED');
      expect((await prisma.remakeProposal.findUniqueOrThrow({ where: { caseId } })).status).toBe('PENDING');
    }
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

  it('releases an available settlement after its delivery dispute reaches a terminal resolution', async () => {
    const flow = await deliveredOrder();
    const settlement = await prisma.riderSettlement.findUniqueOrThrow({ where: { orderId: flow.orderId } });
    await prisma.riderSettlement.update({
      where: { id: settlement.id },
      data: { pendingUntil: new Date(Date.now() - 1000) },
    });
    expect(await releaseAvailableRiderSettlements(prisma)).toBe(1);
    const dispute = await reportDispute(flow.orderId, 'Available settlement dispute');
    expect((await prisma.riderSettlement.findUniqueOrThrow({ where: { id: settlement.id } }))).toMatchObject({
      status: 'HELD', holdReason: 'DELIVERY_DISPUTE',
    });
    await resolveDispute(dispute.caseId, 'Terminal review completed');
    expect((await prisma.exceptionEvent.findUniqueOrThrow({ where: { id: dispute.exceptionEventId } })).resolvedAt).not.toBeNull();
    expect((await prisma.riderSettlement.findUniqueOrThrow({ where: { id: settlement.id } }))).toMatchObject({
      status: 'AVAILABLE', heldAt: null, holdReason: null,
    });
  });

  it('restores a not-yet-due dispute settlement to pending and releases it on the normal sweep', async () => {
    const flow = await deliveredOrder();
    const original = await prisma.riderSettlement.findUniqueOrThrow({ where: { orderId: flow.orderId } });
    const dispute = await reportDispute(flow.orderId, 'Pending settlement dispute');
    await resolveDispute(dispute.caseId, 'Review completed before pending window elapsed');
    expect((await prisma.riderSettlement.findUniqueOrThrow({ where: { id: original.id } }))).toMatchObject({
      status: 'PENDING', availableAt: null, heldAt: null, holdReason: null,
    });
    expect(await releaseAvailableRiderSettlements(
      prisma,
      new Date(original.pendingUntil.getTime() + 1000),
    )).toBe(1);
    expect((await prisma.riderSettlement.findUniqueOrThrow({ where: { id: original.id } })).status).toBe('AVAILABLE');
  });

  it('keeps a dispute hold until every delivery dispute on the order is resolved', async () => {
    const flow = await deliveredOrder();
    const settlement = await prisma.riderSettlement.findUniqueOrThrow({ where: { orderId: flow.orderId } });
    await prisma.riderSettlement.update({
      where: { id: settlement.id },
      data: { pendingUntil: new Date(Date.now() - 1000) },
    });
    expect(await releaseAvailableRiderSettlements(prisma)).toBe(1);
    const first = await reportDispute(flow.orderId, 'First simultaneous dispute');
    const second = await reportDispute(flow.orderId, 'Second simultaneous dispute');
    await resolveDispute(first.caseId, 'First dispute resolved');
    expect((await prisma.riderSettlement.findUniqueOrThrow({ where: { id: settlement.id } })).status).toBe('HELD');
    expect((await prisma.exceptionEvent.findUniqueOrThrow({ where: { id: second.exceptionEventId } })).resolvedAt).toBeNull();
    await resolveDispute(second.caseId, 'Second dispute resolved');
    expect((await prisma.riderSettlement.findUniqueOrThrow({ where: { id: settlement.id } })).status).toBe('AVAILABLE');
  });

  it('preserves compensation reservations when a delivery dispute hold is removed', async () => {
    const flow = await deliveredOrder();
    const settlement = await prisma.riderSettlement.findUniqueOrThrow({ where: { orderId: flow.orderId } });
    await prisma.riderSettlement.update({
      where: { id: settlement.id },
      data: { pendingUntil: new Date(Date.now() - 1000), reservedMinor: 50 },
    });
    expect(await releaseAvailableRiderSettlements(prisma)).toBe(1);
    const dispute = await reportDispute(flow.orderId, 'Dispute with an existing reservation');
    await resolveDispute(dispute.caseId, 'Resolve dispute without touching reservation');
    const restored = await prisma.riderSettlement.findUniqueOrThrow({ where: { id: settlement.id } });
    expect(restored).toMatchObject({ status: 'AVAILABLE', reservedMinor: 50, holdReason: null });
    const riderView = await app.inject({ method: 'GET', url: '/riders/me/settlements', headers: headers(seedIds.riderAUser) });
    const visibleSettlement = riderView.json().find((item: { id: string }) => item.id === settlement.id);
    expect(visibleSettlement.internalUnreservedMinor).toBe(restored.amountMinor - 50);
    expect(visibleSettlement).toMatchObject({ withdrawableMinor: 0, realWithdrawableMinor: 0, realWithdrawalEnabled: false, simulated: true, notVerified: true });
  });

  it('does not resolve linked events or release dispute holds for waiting or escalated cases', async () => {
    const flow = await deliveredOrder();
    const settlement = await prisma.riderSettlement.findUniqueOrThrow({ where: { orderId: flow.orderId } });
    const dispute = await reportDispute(flow.orderId, 'Non-terminal dispute case');
    await app.inject({
      method: 'POST', url: `/admin/exception-cases/${dispute.caseId}/claim`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 0 },
    });
    await app.inject({
      method: 'POST', url: `/admin/exception-cases/${dispute.caseId}/resolve`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 1, resolutionType: 'WAITING_FOR_INFORMATION', note: 'More evidence required' },
    });
    expect((await prisma.exceptionEvent.findUniqueOrThrow({ where: { id: dispute.exceptionEventId } })).resolvedAt).toBeNull();
    expect((await prisma.riderSettlement.findUniqueOrThrow({ where: { id: settlement.id } })).status).toBe('HELD');
    await app.inject({
      method: 'POST', url: `/admin/exception-cases/${dispute.caseId}/escalate`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 2, reason: 'Escalate without resolving the dispute' },
    });
    expect((await prisma.exceptionEvent.findUniqueOrThrow({ where: { id: dispute.exceptionEventId } })).resolvedAt).toBeNull();
    expect((await prisma.riderSettlement.findUniqueOrThrow({ where: { id: settlement.id } })).status).toBe('HELD');
  });

  it('reconciles legacy dispute-only holds idempotently without touching other hold reasons', async () => {
    const disputeFlow = await deliveredOrder();
    const disputeSettlement = await prisma.riderSettlement.findUniqueOrThrow({ where: { orderId: disputeFlow.orderId } });
    await prisma.riderSettlement.update({
      where: { id: disputeSettlement.id },
      data: { pendingUntil: new Date(Date.now() - 1000) },
    });
    expect(await releaseAvailableRiderSettlements(prisma)).toBe(1);
    const dispute = await reportDispute(disputeFlow.orderId, 'Legacy reconciliation dispute');
    const resolvedAt = new Date();
    await prisma.$transaction([
      prisma.exceptionEvent.update({ where: { id: dispute.exceptionEventId }, data: { resolvedAt } }),
      prisma.exceptionCase.update({
        where: { id: dispute.caseId },
        data: { status: 'RESOLVED', resolutionType: 'RESPONSIBILITY_UNDETERMINED', resolvedAt },
      }),
    ]);
    expect(await releaseAvailableRiderSettlements(prisma)).toBe(1);
    expect(await releaseAvailableRiderSettlements(prisma)).toBe(0);
    expect((await prisma.riderSettlement.findUniqueOrThrow({ where: { id: disputeSettlement.id } })).status).toBe('AVAILABLE');

    const compensationFlow = await deliveredOrder();
    const compensationSettlement = await prisma.riderSettlement.update({
      where: { orderId: compensationFlow.orderId },
      data: { status: 'HELD', heldAt: new Date(), holdReason: 'COMPENSATION_OBLIGATION' },
    });
    expect(await releaseAvailableRiderSettlements(prisma)).toBe(0);
    expect((await prisma.riderSettlement.findUniqueOrThrow({ where: { id: compensationSettlement.id } }))).toMatchObject({
      status: 'HELD', holdReason: 'COMPENSATION_OBLIGATION',
    });
  });

  it('rejects ESCALATED_OTHER as a terminal resolve and preserves the audited escalation path', async () => {
    const ready = await pickedUpOrder();
    await app.inject({
      method: 'POST', url: `/orders/${ready.orderId}/exceptions`, headers: headers(seedIds.customer),
      payload: { type: 'DELIVERY_DISPUTE', description: 'Must use the audited escalation action' },
    });
    const exceptionCase = await prisma.exceptionCase.findFirstOrThrow({ where: { orderId: ready.orderId } });
    await app.inject({
      method: 'POST', url: `/admin/exception-cases/${exceptionCase.id}/claim`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 0 },
    });
    const fakeEscalation = await app.inject({
      method: 'POST', url: `/admin/exception-cases/${exceptionCase.id}/resolve`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 1, resolutionType: 'ESCALATED_OTHER', note: 'This must not become a resolved case' },
    });
    expect(fakeEscalation.statusCode).toBe(400);
    expect(fakeEscalation.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect((await prisma.exceptionCase.findUniqueOrThrow({ where: { id: exceptionCase.id } }))).toMatchObject({
      status: 'IN_PROGRESS', version: 1, resolutionType: null,
    });

    const escalated = await app.inject({
      method: 'POST', url: `/admin/exception-cases/${exceptionCase.id}/escalate`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 1, reason: 'Use the actual escalation transition' },
    });
    expect(escalated.statusCode, escalated.body).toBe(200);
    expect(escalated.json()).toMatchObject({ status: 'ESCALATED', version: 2 });
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
    expect((await prisma.compensationObligation.findUniqueOrThrow({ where: { caseId } })).requiredCompensationMinor).toBe(2320);
    expect((await prisma.exceptionEvent.findFirstOrThrow({ where: { exceptionCase: { id: caseId } } })).resolvedAt).not.toBeNull();
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

  it('lets one super admin assign an escalated case to another super admin but not an operator', async () => {
    const secondSuperAdminId = '00000000-0000-4000-8000-000000000007';
    await prisma.user.upsert({
      where: { id: secondSuperAdminId },
      update: { displayName: 'Second super admin', role: 'ADMIN', active: true },
      create: { id: secondSuperAdminId, displayName: 'Second super admin', role: 'ADMIN' },
    });
    await prisma.adminProfile.upsert({
      where: { userId: secondSuperAdminId },
      update: { level: 'SUPER_ADMIN' },
      create: { userId: secondSuperAdminId, level: 'SUPER_ADMIN' },
    });
    const ready = await pickedUpOrder();
    const reported = await app.inject({
      method: 'POST', url: `/rider/orders/${ready.orderId}/severe-exception`, headers: headers(seedIds.riderAUser),
      payload: { type: 'FOOD_LOST', description: 'Escalated reassignment case' },
    });
    const caseId = reported.json().id as string;
    await app.inject({ method: 'POST', url: `/admin/exception-cases/${caseId}/claim`, headers: headers(seedIds.operator), payload: { expectedVersion: 0 } });
    await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/escalate`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 1, reason: 'Requires super-admin reassignment' },
    });
    const operatorTarget = await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/takeover`, headers: headers(seedIds.admin),
      payload: { expectedVersion: 2, nextHandlerAdminId: seedIds.operator, reason: 'Must remain behind super-admin boundary' },
    });
    expect(operatorTarget.statusCode).toBe(409);
    const reassigned = await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/takeover`, headers: headers(seedIds.admin),
      payload: { expectedVersion: 2, nextHandlerAdminId: secondSuperAdminId, reason: 'Assign to the responsible super admin' },
    });
    expect(reassigned.statusCode, reassigned.body).toBe(200);
    expect(reassigned.json()).toMatchObject({ status: 'IN_PROGRESS', currentHandlerAdminId: secondSuperAdminId });
    expect(await prisma.exceptionCaseAction.count({
      where: { caseId, type: 'TAKEN_OVER', actorId: seedIds.admin, nextHandlerAdminId: secondSuperAdminId },
    })).toBe(1);
  });

  it('keeps resolved cases terminal across release, transfer, takeover, and escalation', async () => {
    const ready = await pickedUpOrder();
    await app.inject({
      method: 'POST', url: `/orders/${ready.orderId}/exceptions`, headers: headers(seedIds.customer),
      payload: { type: 'DELIVERY_DISPUTE', description: 'Terminal state guard case' },
    });
    const exceptionCase = await prisma.exceptionCase.findFirstOrThrow({ where: { orderId: ready.orderId } });
    await app.inject({ method: 'POST', url: `/admin/exception-cases/${exceptionCase.id}/claim`, headers: headers(seedIds.operator), payload: { expectedVersion: 0 } });
    await app.inject({
      method: 'POST', url: `/admin/exception-cases/${exceptionCase.id}/resolve`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 1, resolutionType: 'RESPONSIBILITY_UNDETERMINED', note: 'Terminal guard setup' },
    });
    const attempts = [
      app.inject({ method: 'POST', url: `/admin/exception-cases/${exceptionCase.id}/release`, headers: headers(seedIds.operator), payload: { expectedVersion: 2, reason: 'stale release' } }),
      app.inject({ method: 'POST', url: `/admin/exception-cases/${exceptionCase.id}/transfer`, headers: headers(seedIds.operator), payload: { expectedVersion: 2, nextHandlerAdminId: seedIds.admin, reason: 'stale transfer' } }),
      app.inject({ method: 'POST', url: `/admin/exception-cases/${exceptionCase.id}/takeover`, headers: headers(seedIds.admin), payload: { expectedVersion: 2, nextHandlerAdminId: seedIds.admin, reason: 'stale takeover' } }),
      app.inject({ method: 'POST', url: `/admin/exception-cases/${exceptionCase.id}/escalate`, headers: headers(seedIds.operator), payload: { expectedVersion: 2, reason: 'stale escalation' } }),
    ];
    expect((await Promise.all(attempts)).map((response) => response.statusCode)).toEqual([409, 409, 409, 409]);
    expect((await prisma.exceptionCase.findUniqueOrThrow({ where: { id: exceptionCase.id } })).status).toBe('RESOLVED');
  });

  it('blocks stale refund and rider compensation after remake resolution', async () => {
    const ready = await pickedUpOrder();
    const reported = await app.inject({
      method: 'POST', url: `/rider/orders/${ready.orderId}/severe-exception`, headers: headers(seedIds.riderAUser),
      payload: { type: 'SEVERE_FOOD_DAMAGE', description: 'Stale refund case' },
    });
    const caseId = reported.json().id as string;
    await app.inject({
      method: 'POST', url: `/exception-cases/${caseId}/remake-proposal`, headers: headers(seedIds.riderAUser), payload: { message: 'Remake offered' },
    });
    await app.inject({
      method: 'POST', url: `/exception-cases/${caseId}/remake-response`, headers: headers(seedIds.customer), payload: { accept: true },
    });
    const staleAdmin = await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/resolve`, headers: headers(seedIds.admin),
      payload: { expectedVersion: 1, resolutionType: 'REFUND_AND_CLOSE', note: 'stale admin page', idempotencyKey: `stale-admin-${caseId}` },
    });
    const staleRider = await app.inject({
      method: 'POST', url: `/exception-cases/${caseId}/voluntary-compensation`, headers: headers(seedIds.riderAUser),
      payload: { expectedVersion: 1, idempotencyKey: `stale-rider-${caseId}`, reason: 'stale rider page' },
    });
    expect(staleAdmin.statusCode).toBe(409);
    expect(staleRider.statusCode).toBe(409);
    expect(await prisma.compensationObligation.count({ where: { caseId } })).toBe(0);
  });

  it('requires super-admin takeover before an escalated case can be refunded', async () => {
    const ready = await pickedUpOrder();
    const reported = await app.inject({
      method: 'POST', url: `/rider/orders/${ready.orderId}/severe-exception`, headers: headers(seedIds.riderAUser),
      payload: { type: 'FOOD_LOST', description: 'Escalation boundary case' },
    });
    const caseId = reported.json().id as string;
    await app.inject({ method: 'POST', url: `/admin/exception-cases/${caseId}/claim`, headers: headers(seedIds.operator), payload: { expectedVersion: 0 } });
    await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/escalate`, headers: headers(seedIds.operator), payload: { expectedVersion: 1, reason: 'Needs super-admin decision' },
    });
    const operatorRefund = await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/resolve`, headers: headers(seedIds.operator),
      payload: { expectedVersion: 2, resolutionType: 'REFUND_AND_CLOSE', note: 'operator after escalation', idempotencyKey: `escalated-op-${caseId}` },
    });
    expect(operatorRefund.statusCode).toBe(409);
    expect((await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/takeover`, headers: headers(seedIds.admin),
      payload: { expectedVersion: 2, nextHandlerAdminId: seedIds.admin, reason: 'Super-admin accepts escalation' },
    })).statusCode).toBe(200);
    const superRefund = await app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/resolve`, headers: headers(seedIds.admin),
      payload: { expectedVersion: 3, resolutionType: 'REFUND_AND_CLOSE', note: 'Super-admin approved refund', idempotencyKey: `escalated-super-${caseId}` },
    });
    expect(superRefund.statusCode, superRefund.body).toBe(200);
  });

  it('rejects an unverified non-zero rider voluntary payment without creating funded facts', async () => {
    const ready = await pickedUpOrder();
    const reported = await app.inject({
      method: 'POST', url: `/rider/orders/${ready.orderId}/severe-exception`, headers: headers(seedIds.riderAUser),
      payload: { type: 'FOOD_LOST', description: 'Unverified voluntary payment attempt' },
    });
    const caseId = reported.json().id as string;
    const response = await app.inject({
      method: 'POST', url: `/exception-cases/${caseId}/voluntary-compensation`, headers: headers(seedIds.riderAUser),
      payload: {
        expectedVersion: 0,
        idempotencyKey: `unfunded-${caseId}`,
        voluntaryPaymentMinor: 100,
        reason: 'A client-entered amount is not proof of payment',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VOLUNTARY_PAYMENT_UNFUNDED' });
    expect(await prisma.compensationObligation.count({ where: { caseId } })).toBe(0);
    expect(await prisma.compensationAllocation.count()).toBe(0);
    expect((await prisma.exceptionCase.findUniqueOrThrow({ where: { id: caseId } })).status).toBe('OPEN');
  });

  it('records idempotent refund funding and keeps released rider reservations as outstanding platform advance', async () => {
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
        pickupMerchantNameSnapshot: '校园饭堂演示店',
        pickupLocationNameSnapshot: '第一食堂',
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
      payload: { expectedVersion: 0, idempotencyKey: `refund-${caseId}`, reason: 'Rider chose original-price compensation' },
    });
    const responses = await Promise.all([request(), request()]);
    expect(responses.every((response) => response.statusCode === 201)).toBe(true);
    expect(await prisma.compensationObligation.count({ where: { caseId } })).toBe(1);
    const obligation = await prisma.compensationObligation.findUniqueOrThrow({ where: { caseId }, include: { allocations: true } });
    expect(obligation.requiredCompensationMinor).toBe(2320);
    expect(obligation.customerRefundMinor).toBe(2320);
    expect(obligation.currentOrderReservedMinor).toBe(250);
    expect(obligation.otherUnwithdrawnReservedMinor).toBe(500);
    expect(obligation.riderVoluntaryPaymentMinor).toBe(0);
    expect(obligation.platformAdvancedMinor).toBe(1570);
    expect(obligation.outstandingMinor).toBe(1570);
    expect(obligation.allocations.some((allocation) => allocation.source === 'RIDER_VOLUNTARY_PAYMENT')).toBe(false);
    const pricing = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: ready.orderId } });
    expect(pricing.customerRiderTipMinor).toBe(30);
    expect(pricing.customerRefundMinor).toBe(2320);
    const settlements = await prisma.riderSettlement.findMany({ where: { riderId: seedIds.riderA } });
    expect(settlements.every((settlement) => settlement.reservedMinor <= settlement.amountMinor)).toBe(true);
    const customerView = await app.inject({ method: 'GET', url: `/orders/${ready.orderId}/exception-cases`, headers: headers(seedIds.customer) });
    for (const hidden of ['currentOrderReservedMinor', 'otherUnwithdrawnReservedMinor', 'platformAdvancedMinor', 'outstandingMinor']) {
      expect(customerView.body).not.toContain(hidden);
    }

    const release = () => app.inject({
      method: 'POST', url: `/admin/exception-cases/${caseId}/release-compensation`, headers: headers(seedIds.admin),
      payload: { expectedVersion: 1, idempotencyKey: `release-${caseId}`, reason: 'Super admin determined rider reservation should be released' },
    });
    const releases = await Promise.all([release(), release()]);
    expect(releases.every((response) => response.statusCode === 200)).toBe(true);
    const released = await prisma.compensationObligation.findUniqueOrThrow({ where: { caseId } });
    expect(released).toMatchObject({
      currentOrderReservedMinor: 0,
      otherUnwithdrawnReservedMinor: 0,
      platformAdvancedMinor: 2320,
      outstandingMinor: 2320,
      status: 'PARTIALLY_FUNDED',
      resolvedAt: null,
    });
    expect(released.platformAdvancedMinor).toBe(released.outstandingMinor);
    expect((await prisma.compensationAllocation.findFirstOrThrow({
      where: { obligationId: released.id, source: 'PLATFORM_ADVANCE' },
    })).amountMinor).toBe(2320);
    expect((await prisma.riderSettlement.findMany({ where: { riderId: seedIds.riderA } }))
      .every((settlement) => settlement.reservedMinor === 0)).toBe(true);
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
      payload: { expectedVersion: 0, idempotencyKey: `concurrent-${caseId}`, reason: 'Concurrent reservation safety test' },
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

  it('creates an exception case with manual fallback metadata when the classifier throws', async () => {
    const ready = await createReady();
    const failingClassifier: ExceptionClassifier = {
      source: 'JEV_TEST_ADAPTER',
      version: 'test',
      classify: async () => { throw new Error('Jev timeout'); },
    };
    const event = await createExceptionEvent(
      prisma,
      { id: seedIds.customer, role: 'CUSTOMER' },
      ready.orderId,
      { type: ExceptionType.OTHER_NEEDS_REVIEW, description: 'Classifier failure must not block case creation' },
      failingClassifier,
    );
    const exceptionCase = await prisma.exceptionCase.findUniqueOrThrow({ where: { exceptionEventId: event.id } });
    expect(exceptionCase).toMatchObject({
      category: ExceptionType.OTHER_NEEDS_REVIEW,
      classifierSource: 'MANUAL_FALLBACK',
      classifierVersion: '1',
      classifierConfidenceBps: 0,
    });
    expect(exceptionCase.classifierResult).toMatchObject({ routeSuggestion: 'OPERATOR_POOL' });
  });
});
