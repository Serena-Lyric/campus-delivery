import { merchantPickup } from './pickup-helper.js';
import {
  DeliveryMethod,
  MerchantExposureState,
  PickupVerificationMode,
  PrismaClient,
  RiderSettlementStatus,
  RiderStatus,
} from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import { expireUnclaimedDeliveryTasks, releaseExpiredCoolingOrders } from '../../src/orders/lifecycle.js';
import { cancelOrder } from '../../src/orders/service.js';
import { adjustRiderTip } from '../../src/pricing/service.js';
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

describe('order handoff and settlement flow', () => {
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
    await prisma.businessConfig.deleteMany({ where: { id: { not: seedIds.policyConfig } } });
    await prisma.businessConfig.update({
      where: { id: seedIds.policyConfig },
      data: { payload: demoPolicy, isActive: true },
    });
    await prisma.merchantSubsidyAccount.update({
      where: { id: seedIds.subsidyAccount },
      data: { subsidyUsedMinor: 0, subsidyUsageBps: 0, subsidyLimitMinor: 1000 },
    });
    await prisma.merchant.update({
      where: { id: seedIds.merchant },
      data: {
        exposureState: MerchantExposureState.NORMAL,
        trialExposureOverrideBps: 10_000,
        pickupVerificationMode: PickupVerificationMode.CONFIRMATION,
      },
    });
    await prisma.rider.updateMany({
      data: { status: RiderStatus.AVAILABLE, capacityOverride: 2 },
    });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function createOrder(method: DeliveryMethod = DeliveryMethod.DESIGNATED_POINT) {
    const response = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: headers(seedIds.customer),
      payload: {
        merchantId: seedIds.merchant,
        destinationLocationId: seedIds.dormLocation,
        deliveryMethod: method,
        items: [
          { productId: seedIds.productRice, quantity: 1 },
          { productId: seedIds.productTea, quantity: 1 },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  async function submitToMerchant(orderId: string) {
    await prisma.order.update({
      where: { id: orderId },
      data: { coolingOffEndsAt: new Date(Date.now() - 1000) },
    });
    expect(await releaseExpiredCoolingOrders(prisma)).toBe(1);
    const response = await app.inject({
      method: 'POST',
      url: `/merchant/orders/${orderId}/confirm`,
      headers: headers(seedIds.merchantUser),
    });
    expect(response.statusCode).toBe(200);
    return response;
  }

  async function makeReady(method: DeliveryMethod = DeliveryMethod.DESIGNATED_POINT) {
    const order = await createOrder(method);
    const confirmed = await submitToMerchant(order.id);
    const taskId = confirmed.json().deliveryTask.id as string;
    const preparation = await app.inject({
      method: 'POST',
      url: `/merchant/orders/${order.id}/ready`,
      headers: headers(seedIds.merchantUser),
    });
    expect(preparation.statusCode).toBe(200);
    return { order: confirmed.json(), taskId };
  }

  async function claim(taskId: string, riderUser: string = seedIds.riderAUser) {
    return app.inject({
      method: 'POST',
      url: `/delivery-tasks/${taskId}/claim`,
      headers: headers(riderUser),
    });
  }

  async function pickup(taskId: string, _riderUser: string = seedIds.riderAUser, evidenceId?: string) {
    return merchantPickup(app, prisma, taskId, evidenceId ? { evidenceId } : {});
  }

  async function createDeliveryEvidence(orderId: string, riderUser: string = seedIds.riderAUser) {
    const response = await app.inject({
      method: 'POST',
      url: `/orders/${orderId}/evidence`,
      headers: headers(riderUser),
      payload: {
        evidenceType: 'DELIVERY_PHOTO',
        media: {
          fileName: 'delivery.jpg',
          contentType: 'image/jpeg',
          source: 'CAMERA',
          capturedAt: new Date().toISOString(),
        },
        note: 'Placed at the selected delivery location',
      },
    });
    return response;
  }

  async function deliverPhotoOrder() {
    const { order, taskId } = await makeReady();
    expect((await claim(taskId)).statusCode).toBe(200);
    expect((await pickup(taskId)).statusCode).toBe(200);
    const evidence = await createDeliveryEvidence(order.id);
    expect(evidence.statusCode).toBe(201);
    const delivered = await app.inject({
      method: 'POST',
      url: `/delivery-tasks/${taskId}/deliver`,
      headers: headers(seedIds.riderAUser),
      payload: { evidenceId: evidence.json().id },
    });
    expect(delivered.statusCode).toBe(200);
    return { orderId: order.id, taskId, evidenceId: evidence.json().id as string };
  }

  it('allows cancellation only during the cooling-off period', async () => {
    const cancellable = await createOrder();
    const cancelled = await app.inject({
      method: 'POST',
      url: `/orders/${cancellable.id}/cancel`,
      headers: headers(seedIds.customer),
      payload: { reason: 'Changed mind during cooling-off' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('CANCELLED');

    const expired = await createOrder();
    await prisma.order.update({
      where: { id: expired.id },
      data: { coolingOffEndsAt: new Date(Date.now() - 1000) },
    });
    await releaseExpiredCoolingOrders(prisma);
    const rejected = await app.inject({
      method: 'POST',
      url: `/orders/${expired.id}/cancel`,
      headers: headers(seedIds.customer),
      payload: {},
    });
    expect(rejected.statusCode).toBe(409);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: expired.id } })).status).toBe('MERCHANT_PENDING');
  });

  it('resolves cancellation and cooling release races atomically', async () => {
    const order = await createOrder();
    const boundary = new Date();
    await prisma.order.update({
      where: { id: order.id },
      data: { coolingOffEndsAt: boundary },
    });
    const actor = { id: seedIds.customer, role: 'CUSTOMER' as const };
    const results = await Promise.allSettled([
      cancelOrder(prisma, actor, order.id, undefined, boundary),
      releaseExpiredCoolingOrders(prisma, boundary),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('MERCHANT_PENDING');
  });

  it('creates readable, same-day unique short codes and enforces merchant submission timing', async () => {
    const first = await createOrder();
    const second = await createOrder();
    expect(first.shortCode).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    expect(second.shortCode).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    expect(first.shortCode).not.toBe(second.shortCode);

    const early = await app.inject({
      method: 'POST',
      url: `/merchant/orders/${first.id}/confirm`,
      headers: headers(seedIds.merchantUser),
    });
    expect(early.statusCode).toBe(409);
    const wrongRole = await app.inject({
      method: 'POST',
      url: `/merchant/orders/${first.id}/confirm`,
      headers: headers(seedIds.customer),
    });
    expect(wrongRole.statusCode).toBe(403);
  });

  it('publishes immediately on merchant confirmation and keeps ready as a self-reported signal', async () => {
    const order = await createOrder();
    const confirmed = await submitToMerchant(order.id);
    expect(confirmed.json().status).toBe('READY_FOR_RIDER');
    expect(confirmed.json().deliveryTask.id).toBeTruthy();
    const task = await prisma.deliveryTask.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(task.firstPublishedAt).toBeTruthy();
    expect(task.claimDeadline!.getTime() - task.firstPublishedAt!.getTime()).toBe(2400 * 1000);

    const ready = await app.inject({
      method: 'POST',
      url: `/merchant/orders/${order.id}/ready`,
      headers: headers(seedIds.merchantUser),
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe('READY_FOR_RIDER');
    expect(ready.json().merchantPreparationStatus).toBe('READY_FOR_PICKUP');
  });

  it('versions merchant quotes, enforces cooldown, and freezes the price atomically at claim', async () => {
    const order = await createOrder();
    const confirmed = await submitToMerchant(order.id);
    const taskId = confirmed.json().deliveryTask.id as string;
    await prisma.orderPricing.update({
      where: { orderId: order.id },
      data: { merchantRescueUpdatedAt: new Date(Date.now() - 20_000) },
    });

    const firstQuote = await app.inject({
      method: 'PATCH',
      url: `/merchant/orders/${order.id}/delivery-quote`,
      headers: headers(seedIds.merchantUser),
      payload: { newMinor: 180, reason: 'Market response' },
    });
    expect(firstQuote.statusCode).toBe(200);
    await prisma.businessConfig.update({
      where: { id: seedIds.policyConfig },
      data: { payload: { ...demoPolicy, merchantRepriceCooldownSeconds: 0 } },
    });
    const cooldown = await app.inject({
      method: 'PATCH',
      url: `/merchant/orders/${order.id}/delivery-quote`,
      headers: headers(seedIds.merchantUser),
      payload: { newMinor: 200 },
    });
    expect(cooldown.statusCode).toBe(409);
    expect(await prisma.merchantRescueContributionEvent.count({ where: { orderId: order.id } })).toBe(1);

    await prisma.orderPricing.update({
      where: { orderId: order.id },
      data: { merchantRescueUpdatedAt: new Date(Date.now() - 20_000) },
    });
    const [reprice, claimed] = await Promise.all([
      app.inject({
        method: 'PATCH',
        url: `/merchant/orders/${order.id}/delivery-quote`,
        headers: headers(seedIds.merchantUser),
        payload: { newMinor: 220, reason: 'Concurrent market update' },
      }),
      claim(taskId),
    ]);
    expect(claimed.statusCode, claimed.body).toBe(200);
    expect([200, 409], reprice.body).toContain(reprice.statusCode);
    const [pricing, assignment] = await Promise.all([
      prisma.orderPricing.findUniqueOrThrow({ where: { orderId: order.id } }),
      prisma.deliveryAssignment.findFirstOrThrow({ where: { taskId } }),
    ]);
    expect(assignment.merchantRescueContributionMinorAtClaim).toBe(pricing.merchantRescueContributionMinor);
    expect(assignment.quoteVersionAtClaim).toBe(pricing.merchantRescueContributionVersion);
    expect(assignment.riderBasePayoutMinorAtClaim).toBe(pricing.riderBasePayoutMinor);
    expect(assignment.deliveryPlatformContributionMinorAtClaim).toBe(pricing.deliveryPlatformContributionMinor);
    const afterClaim = await app.inject({
      method: 'PATCH',
      url: `/merchant/orders/${order.id}/delivery-quote`,
      headers: headers(seedIds.merchantUser),
      payload: { newMinor: 300, reason: 'Too late' },
    });
    expect(afterClaim.statusCode).toBe(409);
  });

  it('keeps user rider incentives separate and sends post-claim additions entirely to the rider', async () => {
    const order = await createOrder();
    const add = await app.inject({
      method: 'POST',
      url: `/orders/${order.id}/rider-tip-adjustments`,
      headers: headers(seedIds.customer),
      payload: { deltaMinor: 100, reason: 'Help attract a rider' },
    });
    expect(add.statusCode).toBe(201);
    const reduce = await app.inject({
      method: 'POST',
      url: `/orders/${order.id}/rider-tip-adjustments`,
      headers: headers(seedIds.customer),
      payload: { deltaMinor: -40 },
    });
    expect(reduce.statusCode).toBe(201);

    const confirmed = await submitToMerchant(order.id);
    const taskId = confirmed.json().deliveryTask.id as string;
    expect((await claim(taskId)).statusCode).toBe(200);
    const assignmentAtClaim = await prisma.deliveryAssignment.findFirstOrThrow({ where: { taskId } });
    expect(assignmentAtClaim.customerTipMinorAtClaim).toBe(60);

    const afterClaim = await app.inject({
      method: 'POST',
      url: `/orders/${order.id}/rider-tip-adjustments`,
      headers: headers(seedIds.customer),
      payload: { deltaMinor: 25, reason: 'Good communication' },
    });
    expect(afterClaim.statusCode).toBe(201);
    const cannotWithdraw = await app.inject({
      method: 'POST',
      url: `/orders/${order.id}/rider-tip-adjustments`,
      headers: headers(seedIds.customer),
      payload: { deltaMinor: -1 },
    });
    expect(cannotWithdraw.statusCode).toBe(409);
    await prisma.businessConfig.update({
      where: { id: seedIds.policyConfig },
      data: { payload: { ...demoPolicy, riderSettlementPendingSeconds: 0 } },
    });

    expect((await pickup(taskId)).statusCode).toBe(200);
    const delivered = await app.inject({
      method: 'POST',
      url: `/delivery-tasks/${taskId}/deliver`,
      headers: headers(seedIds.riderAUser),
      payload: {},
    });
    expect(delivered.statusCode).toBe(200);
    const [assignment, settlement, riderSettlement] = await Promise.all([
      prisma.deliveryAssignment.findFirstOrThrow({ where: { taskId } }),
      prisma.settlement.findUniqueOrThrow({ where: { orderId: order.id } }),
      prisma.riderSettlement.findUniqueOrThrow({ where: { orderId: order.id } }),
    ]);
    expect(assignment.riderPayoutMinorAtClaim).toBe(280);
    expect(assignment.postClaimTipMinor).toBe(25);
    expect(settlement.riderPayableMinor).toBe(305);
    expect(settlement.merchantPayableMinor).toBe(2000);
    expect(riderSettlement.amountMinor).toBe(305);
    const completedTask = await prisma.deliveryTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(
      riderSettlement.pendingUntil.getTime() - completedTask.deliveredAt!.getTime(),
    ).toBe(demoPolicy.riderSettlementPendingSeconds * 1000);
    expect(settlement.platformRevenueMinor).toBe(100);
    expect((await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: order.id } })).platformCommissionMinor).toBe(0);

    const afterDelivery = await app.inject({
      method: 'POST',
      url: `/orders/${order.id}/rider-tip-adjustments`,
      headers: headers(seedIds.customer),
      payload: { deltaMinor: 10, reason: 'Post-delivery thank you' },
    });
    expect(afterDelivery.statusCode).toBe(201);
    expect((await prisma.deliveryAssignment.findFirstOrThrow({ where: { taskId } })).postClaimTipMinor).toBe(35);
    expect((await prisma.riderSettlement.findUniqueOrThrow({ where: { orderId: order.id } })).amountMinor).toBe(315);
  });

  it('enforces the snapshotted rider-tip deadline at the service boundary', async () => {
    const order = await createOrder();
    const deadline = new Date('2026-09-24T12:00:00.000Z');
    await prisma.order.update({ where: { id: order.id }, data: { tipDeadline: deadline } });
    await expect(adjustRiderTip(
      prisma,
      { id: seedIds.customer, role: 'CUSTOMER' },
      order.id,
      10,
      undefined,
      new Date(deadline.getTime() - 1),
    )).resolves.toBeTruthy();
    await expect(adjustRiderTip(
      prisma,
      { id: seedIds.customer, role: 'CUSTOMER' },
      order.id,
      10,
      undefined,
      deadline,
    )).rejects.toMatchObject({ code: 'RIDER_TIP_WINDOW_ENDED' });
  });

  it.each(['CANCELLED', 'NO_RIDER_ACCEPTED', 'EXCEPTION'] as const)(
    'rejects rider-tip changes for %s orders inside the time window',
    async (status) => {
      const order = await createOrder();
      await prisma.order.update({ where: { id: order.id }, data: { status } });
      const response = await app.inject({
        method: 'POST',
        url: `/orders/${order.id}/rider-tip-adjustments`,
        headers: headers(seedIds.customer),
        payload: { deltaMinor: 10 },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('ORDER_NOT_TIPPABLE');
    },
  );

  it('fails unclaimed orders at the fixed deadline and records the full user refund boundary', async () => {
    const order = await createOrder();
    await app.inject({
      method: 'POST',
      url: `/orders/${order.id}/rider-tip-adjustments`,
      headers: headers(seedIds.customer),
      payload: { deltaMinor: 80 },
    });
    const confirmed = await submitToMerchant(order.id);
    const taskId = confirmed.json().deliveryTask.id as string;
    const original = await prisma.deliveryTask.findUniqueOrThrow({ where: { id: taskId } });
    const expiredAt = new Date(original.claimDeadline!.getTime() + 1000);

    expect(await expireUnclaimedDeliveryTasks(prisma, expiredAt)).toBe(1);
    const [failedOrder, failedTask, pricing] = await Promise.all([
      prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
      prisma.deliveryTask.findUniqueOrThrow({ where: { id: taskId } }),
      prisma.orderPricing.findUniqueOrThrow({ where: { orderId: order.id } }),
    ]);
    expect(failedOrder.status).toBe('NO_RIDER_ACCEPTED');
    expect(failedTask.status).toBe('NO_RIDER_ACCEPTED');
    expect(failedTask.firstPublishedAt).toEqual(original.firstPublishedAt);
    expect(pricing.customerRefundMinor).toBe(2400);
    expect(pricing.customerRiderTipMinor).toBe(0);
    expect(pricing.customerRiderTipRefundMinor).toBe(80);
    expect((await claim(taskId)).statusCode).toBe(409);
  });

  it('adds platform subsidy incrementally with independent policy boundaries and sample isolation', async () => {
    const order = await createOrder();
    const confirmed = await submitToMerchant(order.id);
    const taskId = confirmed.json().deliveryTask.id as string;
    await prisma.deliveryTask.update({
      where: { id: taskId },
      data: {
        firstPublishedAt: new Date(Date.now() - 700_000),
        claimDeadline: new Date(Date.now() + 1_000_000),
      },
    });

    const first = await app.inject({
      method: 'POST',
      url: `/admin/orders/${order.id}/platform-subsidies`,
      headers: headers(seedIds.admin),
      payload: { reason: 'MARKET_SLOW' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().record.addedMinor).toBe(50);
    expect((await prisma.merchant.findUniqueOrThrow({ where: { id: seedIds.merchant } })).exposureState).toBe('NORMAL');
    expect((await prisma.merchantSubsidyAccount.findUniqueOrThrow({ where: { id: seedIds.subsidyAccount } })).subsidyUsageBps).toBe(500);
    const tooSoon = await app.inject({
      method: 'POST',
      url: `/admin/orders/${order.id}/platform-subsidies`,
      headers: headers(seedIds.admin),
      payload: { requestedMinor: 999, reason: 'TOO_SOON' },
    });
    expect(tooSoon.statusCode).toBe(409);

    await prisma.subsidyRecord.updateMany({
      where: { orderId: order.id },
      data: { createdAt: new Date(Date.now() - 400_000) },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/admin/orders/${order.id}/platform-subsidies`,
      headers: headers(seedIds.admin),
      payload: { requestedMinor: 999, reason: 'SECOND_INCREMENT' },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().record.addedMinor).toBe(100);
    expect(second.json().record.newPlatformSubsidyMinor).toBe(150);

    await prisma.subsidyRecord.updateMany({
      where: { orderId: order.id },
      data: { createdAt: new Date(Date.now() - 400_000) },
    });
    const third = await app.inject({
      method: 'POST',
      url: `/admin/orders/${order.id}/platform-subsidies`,
      headers: headers(seedIds.admin),
      payload: { requestedMinor: 999, reason: 'THIRD_INCREMENT' },
    });
    expect(third.statusCode).toBe(201);
    expect(third.json().record.addedMinor).toBe(50);
    expect(third.json().record.newPlatformSubsidyMinor).toBe(200);

    await prisma.subsidyRecord.updateMany({
      where: { orderId: order.id },
      data: { createdAt: new Date(Date.now() - 400_000) },
    });
    const capped = await app.inject({
      method: 'POST',
      url: `/admin/orders/${order.id}/platform-subsidies`,
      headers: headers(seedIds.admin),
      payload: { requestedMinor: 999, reason: 'ORDER_CAP_REACHED' },
    });
    expect(capped.statusCode).toBe(409);

    await prisma.orderPricing.update({
      where: { orderId: order.id },
      data: { merchantRescueUpdatedAt: new Date(Date.now() - 20_000) },
    });
    const lowerQuote = await app.inject({
      method: 'PATCH',
      url: `/merchant/orders/${order.id}/delivery-quote`,
      headers: headers(seedIds.merchantUser),
      payload: { newRescueContributionMinor: 50, reason: 'Merchant rescue contribution' },
    });
    expect(lowerQuote.statusCode).toBe(200);
    const afterLowering = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(afterLowering.platformSubsidyMinor).toBe(200);
    expect(afterLowering.riderGuaranteedPayoutMinor).toBe(470);

    expect((await claim(taskId)).statusCode).toBe(200);
    const subsidized = await prisma.deliveryAssignment.findFirstOrThrow({ where: { taskId } });
    expect(subsidized.claimSampleType).toBe('SUBSIDIZED');
    const afterClaimSubsidy = await app.inject({
      method: 'POST',
      url: `/admin/orders/${order.id}/platform-subsidies`,
      headers: headers(seedIds.admin),
      payload: { reason: 'TOO_LATE' },
    });
    expect(afterClaimSubsidy.statusCode).toBe(409);

    const naturalOrder = await createOrder();
    const naturalConfirmed = await submitToMerchant(naturalOrder.id);
    const naturalTaskId = naturalConfirmed.json().deliveryTask.id as string;
    expect((await claim(naturalTaskId, seedIds.riderBUser)).statusCode).toBe(200);
    const natural = await prisma.deliveryAssignment.findFirstOrThrow({ where: { taskId: naturalTaskId } });
    expect(natural.claimSampleType).toBe('NATURAL');
    expect(await prisma.subsidyRecord.count({ where: { orderId: order.id } })).toBe(3);
  });

  it('versions and audits administrator business configuration changes', async () => {
    const updatedPayload = { ...demoPolicy, merchantRepriceCooldownSeconds: 20 };
    const updated = await app.inject({
      method: 'PUT',
      url: '/admin/business-configs/ORDER_POLICY',
      headers: headers(seedIds.admin),
      payload: { payload: updatedPayload, reason: 'Review market quote cadence' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().version).toBe(2);

    const read = await app.inject({
      method: 'GET',
      url: '/admin/business-configs/ORDER_POLICY',
      headers: headers(seedIds.admin),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().config.payload.merchantRepriceCooldownSeconds).toBe(20);
    expect(read.json().audit).toHaveLength(1);
    expect(read.json().audit[0]).toMatchObject({
      previousVersion: 1,
      newVersion: 2,
      reason: 'Review market quote cadence',
    });

    const forbidden = await app.inject({
      method: 'PUT',
      url: '/admin/business-configs/ORDER_POLICY',
      headers: headers(seedIds.merchantUser),
      payload: { payload: updatedPayload, reason: 'Not allowed' },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('separates merchant risk views and audits hysteretic exposure decisions', async () => {
    await prisma.businessConfig.update({
      where: { id: seedIds.policyConfig },
      data: { payload: { ...demoPolicy, merchantRiskMinimumSampleSize: 1 } },
    });
    const delivered = await deliverPhotoOrder();
    const merchantView = await app.inject({
      method: 'GET',
      url: '/merchant/fulfillment-risk',
      headers: headers(seedIds.merchantUser),
    });
    expect(merchantView.statusCode).toBe(200);
    expect(merchantView.json()).toMatchObject({
      sampleStatus: 'SUFFICIENT',
      completionRisk: 'NORMAL',
    });
    expect(merchantView.json().metrics.platformSubsidyUsedMinor).toBeUndefined();

    const userCatalog = await app.inject({
      method: 'GET',
      url: '/merchants',
      headers: headers(seedIds.customer),
    });
    expect(userCatalog.statusCode).toBe(200);
    expect(userCatalog.json()[0].risk).toMatchObject({ completionRisk: 'NORMAL' });
    expect(userCatalog.json()[0].risk.metrics).toBeUndefined();

    const failed = await createOrder();
    const confirmed = await submitToMerchant(failed.id);
    const task = await prisma.deliveryTask.findUniqueOrThrow({ where: { id: confirmed.json().deliveryTask.id } });
    await expireUnclaimedDeliveryTasks(prisma, new Date(task.claimDeadline!.getTime() + 1));
    const evaluated = await app.inject({
      method: 'POST',
      url: `/admin/merchants/${seedIds.merchant}/exposure/evaluate`,
      headers: headers(seedIds.admin),
      payload: {},
    });
    expect(evaluated.statusCode, evaluated.body).toBe(200);
    expect(evaluated.json()).toMatchObject({
      completionRisk: 'HIGH',
      newState: 'SEVERELY_LIMITED',
    });
    expect(await prisma.merchantExposureDecision.count({ where: { merchantId: seedIds.merchant } })).toBe(1);

    const adminView = await app.inject({
      method: 'GET',
      url: `/admin/merchants/${seedIds.merchant}/fulfillment-risk`,
      headers: headers(seedIds.admin),
    });
    expect(adminView.statusCode).toBe(200);
    expect(adminView.json().merchant.subsidyAccount.subsidyUsageBps).toBe(0);
    expect(adminView.json().merchant.exposureDecisions).toHaveLength(1);
    expect(adminView.json().risk.metrics.exceptionCounts).toEqual({});
    expect(delivered.orderId).toBeTruthy();
  });

  it('keeps a sample-poor trial merchant unknown without changing exposure', async () => {
    await prisma.merchant.update({
      where: { id: seedIds.merchant },
      data: { exposureState: MerchantExposureState.TRIAL },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/merchants',
      headers: headers(seedIds.customer),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()[0]).toMatchObject({
      risk: { timeRisk: 'UNKNOWN', completionRisk: 'UNKNOWN', sampleStatus: 'INSUFFICIENT_DATA' },
    });
    expect(response.json()[0].exposureState).toBeUndefined();
  });

  it('publishes the merchant-risk routes in OpenAPI', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(response.statusCode).toBe(200);
    const paths = response.json().paths;
    expect(paths['/merchant/fulfillment-risk']?.get).toBeTruthy();
    expect(paths['/admin/merchants/{merchantId}/fulfillment-risk']?.get).toBeTruthy();
    expect(paths['/admin/merchants/{merchantId}/exposure/evaluate']?.post).toBeTruthy();
  });

  it('returns role-specific pricing views without mixing funding sources', async () => {
    const order = await createOrder();
    await app.inject({
      method: 'POST',
      url: `/orders/${order.id}/rider-tip-adjustments`,
      headers: headers(seedIds.customer),
      payload: { deltaMinor: 30 },
    });
    const confirmed = await submitToMerchant(order.id);
    const taskId = confirmed.json().deliveryTask.id as string;
    await prisma.deliveryTask.update({
      where: { id: taskId },
      data: { firstPublishedAt: new Date(Date.now() - 700_000) },
    });
    await app.inject({
      method: 'POST',
      url: `/admin/orders/${order.id}/platform-subsidies`,
      headers: headers(seedIds.admin),
      payload: { reason: 'VIEW_TEST' },
    });
    expect((await claim(taskId)).statusCode).toBe(200);

    const customer = (await app.inject({
      method: 'GET', url: `/orders/${order.id}/pricing`, headers: headers(seedIds.customer),
    })).json();
    expect(customer.customerRiderTipMinor).toBe(30);
    expect(customer.platformSubsidyMinor).toBeUndefined();
    expect(customer.merchantDeliveryQuoteMinor).toBeUndefined();

    const merchant = (await app.inject({
      method: 'GET', url: `/orders/${order.id}/pricing`, headers: headers(seedIds.merchantUser),
    })).json();
    expect(merchant.merchantBaseDeliveryPriceMinor).toBe(100);
    expect(merchant.merchantRescueContributionMinor).toBe(0);
    expect(merchant.customerRiderTipMinor).toBeUndefined();
    expect(merchant.platformSubsidyMinor).toBeUndefined();

    const rider = (await app.inject({
      method: 'GET', url: `/orders/${order.id}/pricing`, headers: headers(seedIds.riderAUser),
    })).json();
    expect(rider.guaranteedRiderPayoutMinor).toBe(300);
    expect(rider.merchantDeliveryContributionMinor).toBeUndefined();

    const admin = (await app.inject({
      method: 'GET', url: `/orders/${order.id}/pricing`, headers: headers(seedIds.admin),
    })).json();
    expect(admin.pricing.customerRiderTipMinor).toBe(30);
    expect(admin.pricing.platformSubsidyMinor).toBe(50);
    expect(admin.pricing.merchantDeliveryContributionMinor).toBe(0);
    expect(admin.pricing.merchantBaseDeliveryPriceMinor).toBe(100);
    expect(admin.pricing.merchantRescueContributionMinor).toBe(0);
  });

  it('allows normal delivery without photo while keeping evidence available as an option', async () => {
    const { taskId } = await makeReady();
    expect((await claim(taskId)).statusCode).toBe(200);
    expect((await pickup(taskId)).statusCode).toBe(200);
    const delivered = await app.inject({
      method: 'POST',
      url: `/delivery-tasks/${taskId}/deliver`,
      headers: headers(seedIds.riderAUser),
      payload: {},
    });
    expect(delivered.statusCode).toBe(200);
  });

  it('prevents personal and platform rider limit violations', async () => {
    await prisma.rider.update({ where: { id: seedIds.riderA }, data: { capacityOverride: 1 } });
    const first = await makeReady();
    const second = await makeReady();
    expect((await claim(first.taskId)).statusCode).toBe(200);
    expect((await claim(second.taskId)).statusCode).toBe(409);

    await prisma.subsidyRecord.deleteMany();
    await prisma.deliveryAssignment.deleteMany();
    await prisma.deliveryTask.deleteMany();
    await prisma.order.deleteMany();
    await prisma.rider.update({ where: { id: seedIds.riderA }, data: { capacityOverride: 5 } });
    await prisma.businessConfig.update({
      where: { id: seedIds.policyConfig },
      data: { payload: { ...demoPolicy, platformMaxConcurrentOrdersPerRider: 1 } },
    });
    const platformFirst = await makeReady();
    const platformSecond = await makeReady();
    expect((await claim(platformFirst.taskId)).statusCode).toBe(200);
    expect((await claim(platformSecond.taskId)).statusCode).toBe(409);
  });

  it('serializes concurrent claims by the same rider', async () => {
    await prisma.rider.update({ where: { id: seedIds.riderA }, data: { capacityOverride: 1 } });
    const first = await makeReady();
    const second = await makeReady();
    const results = await Promise.all([claim(first.taskId), claim(second.taskId)]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect(await prisma.deliveryTask.count({
      where: { riderId: seedIds.riderA, status: { in: ['CLAIMED', 'PICKED_UP'] } },
    })).toBe(1);
  });

  it('allows only one of two riders to claim the same task', async () => {
    const ready = await makeReady();
    const [claimA, claimB] = await Promise.all([
      claim(ready.taskId, seedIds.riderAUser),
      claim(ready.taskId, seedIds.riderBUser),
    ]);
    expect([claimA.statusCode, claimB.statusCode].sort()).toEqual([200, 409]);
    expect(await prisma.deliveryAssignment.count({ where: { taskId: ready.taskId } })).toBe(1);
  });

  it('treats claim as a commitment and exposes no normal abandon endpoint', async () => {
    const { order, taskId } = await makeReady();
    expect((await claim(taskId)).statusCode).toBe(200);
    const abandoned = await app.inject({
      method: 'POST',
      url: `/delivery-tasks/${taskId}/abandon`,
      headers: headers(seedIds.riderAUser),
      payload: { reason: 'Changed mind' },
    });
    expect(abandoned.statusCode).toBe(404);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CLAIMED');
    expect((await prisma.deliveryAssignment.findFirstOrThrow({ where: { taskId } })).status).toBe('ACTIVE');
  });

  it('validates pickup and delivery codes and records verification evidence', async () => {
    await prisma.merchant.update({
      where: { id: seedIds.merchant },
      data: { pickupVerificationMode: PickupVerificationMode.PICKUP_CODE },
    });
    const { order, taskId } = await makeReady(DeliveryMethod.FACE_TO_FACE);
    expect((await claim(taskId)).statusCode).toBe(200);

    const assignment = await prisma.deliveryAssignment.findFirstOrThrow({ where: { taskId, status: 'ACTIVE' } });
    const pickupCode = await app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/pickup-code`, headers: headers(seedIds.riderAUser), payload: { assignmentId: assignment.id } });
    expect(pickupCode.statusCode).toBe(201);
    expect((await merchantPickup(app, prisma, taskId, { codeId: pickupCode.json().id, code: pickupCode.json().code })).statusCode).toBe(200);

    const deliveryCode = await app.inject({
      method: 'POST',
      url: `/orders/${order.id}/delivery-code`,
      headers: headers(seedIds.customer),
    });
    expect(deliveryCode.statusCode).toBe(201);
    const wrongCode = deliveryCode.json().code === '000000' ? '999999' : '000000';
    const wrong = await app.inject({
      method: 'POST',
      url: `/delivery-tasks/${taskId}/deliver`,
      headers: headers(seedIds.riderAUser),
      payload: { code: wrongCode },
    });
    expect(wrong.statusCode).toBe(409);
    const correct = await app.inject({
      method: 'POST',
      url: `/delivery-tasks/${taskId}/deliver`,
      headers: headers(seedIds.riderAUser),
      payload: { code: deliveryCode.json().code },
    });
    expect(correct.statusCode).toBe(200);
    expect(await prisma.evidence.count({
      where: { orderId: order.id, evidenceType: { in: ['PICKUP_CODE_VERIFICATION', 'HANDOFF_CODE_VERIFICATION'] } },
    })).toBe(2);
  });

  it('binds photo evidence to the correct order, rider, and stage', async () => {
    const { order, taskId } = await makeReady();
    expect((await claim(taskId)).statusCode).toBe(200);
    expect((await pickup(taskId)).statusCode).toBe(200);

    const wrongRider = await createDeliveryEvidence(order.id, seedIds.riderBUser);
    expect(wrongRider.statusCode).toBe(403);
    const evidence = await createDeliveryEvidence(order.id);
    expect(evidence.statusCode).toBe(201);
    expect(evidence.json()).toMatchObject({
      orderId: order.id,
      actorId: seedIds.riderAUser,
      actorRole: 'RIDER',
      orderStage: 'PICKED_UP',
      evidenceType: 'DELIVERY_PHOTO',
    });
  });

  it('allows evidenced unattended delivery but blocks face-to-face delivery when the customer is unreachable', async () => {
    const allowed = await makeReady(DeliveryMethod.DESIGNATED_POINT);
    expect((await claim(allowed.taskId)).statusCode).toBe(200);
    expect((await pickup(allowed.taskId)).statusCode).toBe(200);
    const report = await app.inject({
      method: 'POST',
      url: `/orders/${allowed.order.id}/exceptions`,
      headers: headers(seedIds.riderAUser),
      payload: { type: 'CUSTOMER_UNREACHABLE', description: 'No response at the selected point' },
    });
    expect(report.statusCode).toBe(201);
    const evidence = await createDeliveryEvidence(allowed.order.id);
    const delivered = await app.inject({
      method: 'POST',
      url: `/delivery-tasks/${allowed.taskId}/deliver`,
      headers: headers(seedIds.riderAUser),
      payload: { evidenceId: evidence.json().id },
    });
    expect(delivered.statusCode).toBe(200);

    const blocked = await makeReady(DeliveryMethod.FACE_TO_FACE);
    expect((await claim(blocked.taskId, seedIds.riderBUser)).statusCode).toBe(200);
    expect((await pickup(blocked.taskId, seedIds.riderBUser)).statusCode).toBe(200);
    const blockedReport = await app.inject({
      method: 'POST',
      url: `/orders/${blocked.order.id}/exceptions`,
      headers: headers(seedIds.riderBUser),
      payload: { type: 'CUSTOMER_UNREACHABLE', description: 'Face-to-face handoff cannot be completed' },
    });
    expect(blockedReport.statusCode).toBe(201);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: blocked.order.id } })).status).toBe('EXCEPTION');
  });

  it('moves rider income from pending to available and holds disputed income', async () => {
    const availableFlow = await deliverPhotoOrder();
    const pending = await prisma.riderSettlement.findUniqueOrThrow({ where: { orderId: availableFlow.orderId } });
    expect(pending.status).toBe(RiderSettlementStatus.PENDING);
    await prisma.riderSettlement.update({
      where: { id: pending.id },
      data: { pendingUntil: new Date(Date.now() - 1000) },
    });
    expect(await releaseAvailableRiderSettlements(prisma)).toBe(1);
    expect((await prisma.riderSettlement.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('AVAILABLE');

    const disputedFlow = await deliverPhotoOrder();
    const dispute = await app.inject({
      method: 'POST',
      url: `/orders/${disputedFlow.orderId}/exceptions`,
      headers: headers(seedIds.customer),
      payload: { type: 'DELIVERY_DISPUTE', description: 'Delivery requires review' },
    });
    expect(dispute.statusCode).toBe(201);
    const held = await prisma.riderSettlement.findUniqueOrThrow({ where: { orderId: disputedFlow.orderId } });
    expect(held.status).toBe(RiderSettlementStatus.HELD);
    await prisma.riderSettlement.update({ where: { id: held.id }, data: { pendingUntil: new Date(Date.now() - 1000) } });
    expect(await releaseAvailableRiderSettlements(prisma)).toBe(0);
    expect((await prisma.riderSettlement.findUniqueOrThrow({ where: { id: held.id } })).status).toBe('HELD');
  });

  it('returns a chronological, role-filtered timeline and preserves the full original flow', async () => {
    const flow = await deliverPhotoOrder();
    const customerTimeline = await app.inject({
      method: 'GET',
      url: `/orders/${flow.orderId}/timeline`,
      headers: headers(seedIds.customer),
    });
    expect(customerTimeline.statusCode).toBe(200);
    const customerItems = customerTimeline.json();
    const timestamps = customerItems.map((item: { timestamp: string }) => Date.parse(item.timestamp));
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    expect(JSON.stringify(customerItems)).not.toContain('mediaReference');
    expect(customerItems.some((item: { details: { metadata?: unknown } }) => item.details.metadata)).toBe(false);

    const adminTimeline = await app.inject({
      method: 'GET',
      url: `/orders/${flow.orderId}/timeline`,
      headers: headers(seedIds.admin),
    });
    expect(adminTimeline.statusCode).toBe(200);
    expect(adminTimeline.json().some((item: { details: { metadata?: unknown } }) => item.details.metadata)).toBe(true);

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: flow.orderId },
      include: { events: { orderBy: { createdAt: 'asc' } }, settlement: true, riderSettlement: true },
    });
    expect(finalOrder.status).toBe('DELIVERED');
    expect(finalOrder.events.map((event) => event.toStatus)).toEqual([
      'CREATED',
      'MERCHANT_PENDING',
      'MERCHANT_CONFIRMED',
      'READY_FOR_RIDER',
      'READY_FOR_RIDER',
      'CLAIMED',
      'PICKED_UP',
      'DELIVERED',
    ]);
    expect(finalOrder.settlement?.status).toBe('FINALIZED');
    expect(finalOrder.riderSettlement?.status).toBe('PENDING');
  });
});
