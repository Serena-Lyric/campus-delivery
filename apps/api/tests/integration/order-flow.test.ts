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
import { releaseExpiredCoolingOrders } from '../../src/orders/lifecycle.js';
import { cancelOrder } from '../../src/orders/service.js';
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
  campusTimeZone: 'Asia/Singapore',
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
    await prisma.subsidyRecord.deleteMany();
    await prisma.deliveryTask.deleteMany();
    await prisma.order.deleteMany();
    await prisma.businessConfig.update({
      where: { id: seedIds.policyConfig },
      data: { payload: demoPolicy, isActive: true },
    });
    await prisma.merchantSubsidyAccount.update({
      where: { id: seedIds.subsidyAccount },
      data: { subsidyUsedMinor: 0, riskScore: 0, subsidyLimitMinor: 1000 },
    });
    await prisma.merchant.update({
      where: { id: seedIds.merchant },
      data: {
        exposureState: MerchantExposureState.NORMAL,
        pickupVerificationMode: PickupVerificationMode.CONFIRMATION,
      },
    });
    await prisma.rider.updateMany({
      data: { status: RiderStatus.AVAILABLE, currentConcurrentOrderLimit: 2 },
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
  }

  async function makeReady(method: DeliveryMethod = DeliveryMethod.DESIGNATED_POINT) {
    const order = await createOrder(method);
    await submitToMerchant(order.id);
    const response = await app.inject({
      method: 'POST',
      url: `/merchant/orders/${order.id}/ready`,
      headers: headers(seedIds.merchantUser),
    });
    expect(response.statusCode).toBe(200);
    return { order: response.json(), taskId: response.json().deliveryTask.id as string };
  }

  async function claim(taskId: string, riderUser: string = seedIds.riderAUser) {
    return app.inject({
      method: 'POST',
      url: `/delivery-tasks/${taskId}/claim`,
      headers: headers(riderUser),
    });
  }

  async function pickup(taskId: string, riderUser: string = seedIds.riderAUser, evidenceId?: string) {
    return app.inject({
      method: 'POST',
      url: `/delivery-tasks/${taskId}/pick-up`,
      headers: headers(riderUser),
      payload: evidenceId ? { evidenceId } : {},
    });
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

  it('prevents personal and platform rider limit violations', async () => {
    await prisma.rider.update({ where: { id: seedIds.riderA }, data: { currentConcurrentOrderLimit: 1 } });
    const first = await makeReady();
    const second = await makeReady();
    expect((await claim(first.taskId)).statusCode).toBe(200);
    expect((await claim(second.taskId)).statusCode).toBe(409);

    await prisma.subsidyRecord.deleteMany();
    await prisma.deliveryAssignment.deleteMany();
    await prisma.deliveryTask.deleteMany();
    await prisma.order.deleteMany();
    await prisma.rider.update({ where: { id: seedIds.riderA }, data: { currentConcurrentOrderLimit: 5 } });
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
    await prisma.rider.update({ where: { id: seedIds.riderA }, data: { currentConcurrentOrderLimit: 1 } });
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

  it('records claim, abandonment, and reopens the task without scoring', async () => {
    const { order, taskId } = await makeReady();
    expect((await claim(taskId)).statusCode).toBe(200);
    const abandoned = await app.inject({
      method: 'POST',
      url: `/delivery-tasks/${taskId}/abandon`,
      headers: headers(seedIds.riderAUser),
      payload: { reason: 'Cannot complete this route' },
    });
    expect(abandoned.statusCode).toBe(200);
    expect(abandoned.json().status).toBe('OPEN');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('READY_FOR_RIDER');
    expect((await prisma.deliveryAssignment.findFirstOrThrow({ where: { taskId } })).status).toBe('ABANDONED');
  });

  it('validates pickup and delivery codes and records verification evidence', async () => {
    await prisma.merchant.update({
      where: { id: seedIds.merchant },
      data: { pickupVerificationMode: PickupVerificationMode.PICKUP_CODE },
    });
    const { order, taskId } = await makeReady(DeliveryMethod.FACE_TO_FACE);
    expect((await claim(taskId)).statusCode).toBe(200);

    const pickupCode = await app.inject({
      method: 'POST',
      url: `/orders/${order.id}/pickup-code`,
      headers: headers(seedIds.merchantUser),
    });
    expect(pickupCode.statusCode).toBe(201);
    const pickupVerified = await app.inject({
      method: 'POST',
      url: `/delivery-tasks/${taskId}/verify-pickup-code`,
      headers: headers(seedIds.riderAUser),
      payload: { code: pickupCode.json().code },
    });
    expect(pickupVerified.statusCode).toBe(200);
    expect((await pickup(taskId, seedIds.riderAUser, pickupVerified.json().evidenceId)).statusCode).toBe(200);

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
      'CLAIMED',
      'PICKED_UP',
      'DELIVERED',
    ]);
    expect(finalOrder.settlement?.status).toBe('FINALIZED');
    expect(finalOrder.riderSettlement?.status).toBe('PENDING');
  });
});
