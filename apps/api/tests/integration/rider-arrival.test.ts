import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { seedDatabase, seedIds } from '../../prisma/seed.js';
import { getOrder, markOrderReady } from '../../src/orders/service.js';
import { confirmRiderPickup } from '../../src/delivery/merchant-pickup.js';
import { markRiderArrival } from '../../src/delivery/arrival.js';

const prisma = new PrismaClient();
const headers = (id: string) => ({ 'x-user-id': id });
const config = { databaseUrl: process.env.DATABASE_URL!, host: '127.0.0.1', port: 3000,
  enableDevAuth: true, enableBackgroundJobs: false, backgroundSweepIntervalMs: 5000,
  campusTimeZone: 'Asia/Shanghai', logLevel: 'silent' as const };

describe('voluntary rider arrival belongs only to the current assignment', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ownerId: string;
  let merchantId: string;
  let productId: string;
  const riders: Array<{ id: string; userId: string }> = [];
  let orderId: string;
  let taskId: string;
  let assignmentId: string;
  beforeAll(async () => {
    await seedDatabase(prisma);
    ownerId = (await prisma.user.create({ data: { role: 'MERCHANT', displayName: 'arrival owner' } })).id;
    const merchant = await prisma.merchant.create({ data: { ownerId, name: 'arrival stall', campusLocationId: seedIds.merchantLocation,
      exposureState: 'NORMAL', categories: { create: { name: 'menu' } } }, include: { categories: true } });
    merchantId = merchant.id;
    productId = (await prisma.product.create({ data: { merchantId, categoryId: merchant.categories[0]!.id,
      name: 'rice', priceMinor: 2000, deliveryCategoryCode: 'ORDINARY_MEAL' } })).id;
    for (let i = 0; i < 2; i++) {
      const user = await prisma.user.create({ data: { role: 'RIDER', displayName: 'arrival rider', rider: { create: { status: 'AVAILABLE', capacityOverride: 10 } } }, include: { rider: true } });
      riders.push({ id: user.rider!.id, userId: user.id });
    }
    app = await buildApp(config, prisma);
    await app.ready();
  });
  beforeEach(async () => {
    const created = await app.inject({ method: 'POST', url: '/orders', headers: headers(seedIds.customer), payload: {
      merchantId, destinationLocationId: seedIds.dormLocation, deliveryMethod: 'DESIGNATED_POINT', items: [{ productId, quantity: 1 }],
    } });
    expect(created.statusCode, created.body).toBe(201);
    orderId = created.json().id;
    await prisma.order.update({ where: { id: orderId }, data: { status: 'MERCHANT_PENDING' } });
    const confirmed = await app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/confirm`, headers: headers(ownerId) });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    taskId = confirmed.json().deliveryTask.id;
    const claimed = await app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/claim`, headers: headers(riders[0]!.userId) });
    expect(claimed.statusCode, claimed.body).toBe(200);
    assignmentId = claimed.json().activeAssignmentId;
  });
  afterAll(async () => {
    await app.close();
    await prisma.exceptionCaseAction.deleteMany({ where: { case: { order: { merchantId } } } });
    await prisma.exceptionCase.deleteMany({ where: { order: { merchantId } } });
    await prisma.deliveryTask.deleteMany({ where: { order: { merchantId } } });
    await prisma.order.deleteMany({ where: { merchantId } });
    await prisma.product.deleteMany({ where: { merchantId } });
    await prisma.productCategory.deleteMany({ where: { merchantId } });
    await prisma.merchant.delete({ where: { id: merchantId } });
    await prisma.user.delete({ where: { id: ownerId } });
    for (const rider of riders) {
      await prisma.riderCancellationEvent.deleteMany({ where: { riderId: rider.id } });
      await prisma.riderRestrictionAudit.deleteMany({ where: { restriction: { riderId: rider.id } } });
      await prisma.riderRestriction.deleteMany({ where: { riderId: rider.id } });
      await prisma.riderCapacityEvent.deleteMany({ where: { riderId: rider.id } });
      await prisma.rider.delete({ where: { id: rider.id } });
      await prisma.user.delete({ where: { id: rider.userId } });
    }
    await prisma.$disconnect();
  });
  const arrive = (userId = riders[0]!.userId, currentId = assignmentId, extra = {}) => app.inject({
    method: 'POST', url: `/delivery-tasks/${taskId}/arrive`, headers: headers(userId), payload: { assignmentId: currentId, ...extra },
  });
  const read = (userId = riders[0]!.userId) => app.inject({ method: 'GET', url: `/orders/${orderId}`, headers: headers(userId) });
  const pickup = () => confirmRiderPickup(prisma, { id: ownerId, role: 'MERCHANT', merchantId }, orderId,
    { assignmentId, expectedRevision: 0, requestKey: randomUUID() });

  it('records one server timestamp under concurrent double clicks without changing financial or market facts', async () => {
    const before = await prisma.deliveryTask.findUniqueOrThrow({ where: { id: taskId } });
    const money = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId } });
    const responses = await Promise.all([arrive(), arrive()]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(responses[0]!.json().arrivedAt).toBe(responses[1]!.json().arrivedAt);
    expect(responses[0]!.json()).toMatchObject({ assignmentId, selfReported: true, onsiteVerified: false });
    expect((await read()).json().arrivalElapsed).toMatchObject({ readyAt: null, handedOffAt: null, arrivalToReadySeconds: null, readyToHandoffSeconds: null, selfReported: true, onsiteVerified: false });
    expect(await prisma.deliveryTask.findUniqueOrThrow({ where: { id: taskId } })).toEqual(before);
    expect(await prisma.orderPricing.findUniqueOrThrow({ where: { orderId } })).toEqual(money);
    const events = (await read()).json().events.filter((event: { eventType: string }) => event.eventType === 'RIDER_ARRIVED');
    expect(events).toHaveLength(1);
  });

  it('rejects unrelated roles, stale assignments and client time/location injection', async () => {
    for (const user of [ownerId, seedIds.customer, seedIds.admin, riders[1]!.userId]) expect((await arrive(user)).statusCode).toBe(403);
    expect((await arrive(riders[0]!.userId, randomUUID())).statusCode).toBe(409);
    for (const extra of [{ arrivedAt: '2020-01-01T00:00:00Z' }, { latitude: 0 }, { longitude: 0 }, { onsiteVerified: true }, { riderId: riders[0]!.id }]) expect((await arrive(riders[0]!.userId, assignmentId, extra)).statusCode).toBe(400);
    expect((await read()).json().arrivalElapsed.arrivedAt).toBeNull();
  });

  it('allows pickup with neither arrival nor READY and keeps missing nodes absent', async () => {
    await pickup();
    const view = (await read()).json();
    expect(view.status).toBe('PICKED_UP');
    expect(view.arrivalElapsed).toMatchObject({ arrivedAt: null, readyAt: null, arrivalToReadySeconds: null, readyToHandoffSeconds: null, totalElapsedSeconds: null });
    expect(view.arrivalElapsed.handedOffAt).not.toBeNull();
    expect((await arrive()).statusCode).toBe(409);
  });

  it('clamps READY-before-arrival to zero and retains the first READY on retries', async () => {
    const readyAt = new Date(Date.now() - 60_000);
    await markOrderReady(prisma, { id: ownerId, role: 'MERCHANT', merchantId }, orderId, readyAt);
    expect((await arrive()).statusCode).toBe(200);
    const readyAgain = await app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/ready`, headers: headers(ownerId) });
    expect(readyAgain.statusCode).toBe(200);
    expect(readyAgain.json().merchantPreparationUpdatedAt).toBe(readyAt.toISOString());
    await pickup();
    const view = (await read()).json().arrivalElapsed;
    expect(view.arrivalToReadySeconds).toBe(0);
    expect(view.readyToHandoffSeconds).toBeGreaterThanOrEqual(60);
    expect(view.ongoing).toBe(false);
  });

  it('retains the first assignment record on a legal pre-pickup cancellation without inheriting it for a replacement', async () => {
    expect((await arrive()).statusCode).toBe(200);
    const cancelled = await app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/pre-pickup-cancel`, headers: headers(riders[0]!.userId), payload: { reason: 'PERSONAL_EMERGENCY' } });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await arrive()).statusCode).toBe(403);
    const original = await prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
    const second = await app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/claim`, headers: headers(riders[1]!.userId) });
    expect(second.statusCode, second.body).toBe(200);
    const newAssignment = second.json().activeAssignmentId;
    expect((await read(riders[1]!.userId)).json().arrivalElapsed.arrivedAt).toBeNull();
    expect((await arrive(riders[0]!.userId, assignmentId)).statusCode).toBe(403);
    expect((await arrive(riders[1]!.userId, assignmentId)).statusCode).toBe(409);
    expect((await arrive(riders[1]!.userId, newAssignment)).statusCode).toBe(200);
    expect(await prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: assignmentId } })).toEqual(original);
    expect((await read(riders[0]!.userId)).json()).not.toHaveProperty('arrivalElapsed');
  });

  it('preserves a declaration on SQL retries, rejects actor spoofing and does not end elapsed time merely on an exception report', async () => {
    await expect(markRiderArrival(prisma, { id: riders[1]!.userId, role: 'RIDER', riderId: riders[0]!.id }, taskId, assignmentId)).rejects.toMatchObject({ statusCode: 403 });
    const arrived = await arrive();
    expect(arrived.statusCode).toBe(200);
    await expect(prisma.deliveryAssignment.update({ where: { id: assignmentId }, data: { merchantArrivedAt: new Date('2000-01-01') } })).rejects.toThrow();
    const exception = await app.inject({ method: 'POST', url: `/orders/${orderId}/exceptions`, headers: headers(riders[0]!.userId),
      payload: { type: 'OTHER_NEEDS_REVIEW', description: 'Preparation needs human information review' } });
    expect(exception.statusCode, exception.body).toBe(201);
    expect((await read()).json()).toMatchObject({ status: 'CLAIMED', arrivalElapsed: { ongoing: true, handedOffAt: null } });
    expect((await arrive()).json().arrivedAt).toBe(arrived.json().arrivedAt);
    const results = [(await read(seedIds.customer)).json(), (await read(ownerId)).json(), (await read()).json(),
      (await app.inject({ method: 'GET', url: '/delivery-tasks/mine', headers: headers(riders[0]!.userId) })).json()];
    for (const result of results) {
      const serialized = JSON.stringify(result);
      for (const field of ['merchantArrivedAt', 'requestKey', 'operatorId', 'pricingInputsSnapshot', 'platformSubsidyMinor']) expect(serialized).not.toContain(`"${field}":`);
    }
    await prisma.exceptionCaseAction.deleteMany({ where: { case: { orderId } } });
    await prisma.exceptionCase.deleteMany({ where: { orderId } });
  });

  it('serializes a queued arrival behind pickup and records no late arrival', async () => {
    let unlock!: () => void;
    let notify!: () => void;
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const acquired = new Promise<void>((resolve) => { notify = resolve; });
    const handedOff = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id"=${orderId}::uuid FOR UPDATE`;
      await tx.order.update({ where: { id: orderId }, data: { status: 'PICKED_UP' } });
      await tx.deliveryTask.update({ where: { id: taskId }, data: { status: 'PICKED_UP', pickedUpAt: new Date() } });
      notify();
      await release;
    });
    await acquired;
    const arriving = arrive();
    try {
      let observed = false;
      for (let i = 0; i < 300; i++) {
        const rows = await prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%"Order"%') AS waiting`;
        if (rows[0]?.waiting) { observed = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observed).toBe(true);
    } finally { unlock(); }
    await handedOff;
    expect((await arriving).statusCode).toBe(409);
    expect((await prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: assignmentId } })).merchantArrivedAt).toBeNull();
  });

  it('reads both literal elapsed segments from persisted server declaration and handoff nodes', async () => {
    const arrivedAt = new Date(Math.ceil(Date.now() / 1000) * 1000);
    const readyAt = new Date(arrivedAt.getTime() + 120_000);
    const handedOffAt = new Date(arrivedAt.getTime() + 300_000);
    await markRiderArrival(prisma, { id: riders[0]!.userId, role: 'RIDER', riderId: riders[0]!.id }, taskId, assignmentId, () => arrivedAt);
    await markOrderReady(prisma, { id: ownerId, role: 'MERCHANT', merchantId }, orderId, readyAt);
    await confirmRiderPickup(prisma, { id: ownerId, role: 'MERCHANT', merchantId }, orderId,
      { assignmentId, expectedRevision: 0, requestKey: randomUUID() }, handedOffAt);
    const view = await getOrder(prisma, { id: riders[0]!.userId, role: 'RIDER', riderId: riders[0]!.id }, orderId, config.campusTimeZone, () => new Date(arrivedAt.getTime() + 600_000));
    expect(view.arrivalElapsed).toMatchObject({ arrivalToReadySeconds: 120, readyToHandoffSeconds: 180, totalElapsedSeconds: 300, ongoing: false });
    expect((await app.inject({ method: 'GET', url: '/delivery-tasks/mine', headers: headers(riders[0]!.userId) })).json().find((t: { id: string }) => t.id === taskId).arrivalElapsed).toMatchObject({ arrivalToReadySeconds: 120, readyToHandoffSeconds: 180, totalElapsedSeconds: 300 });
  });

  it('does not claim an ongoing or invented end duration for a legacy terminal order missing its assignment end', async () => {
    expect((await arrive()).statusCode).toBe(200);
    const terminated = await app.inject({ method: 'POST', url: `/admin/orders/${orderId}/exception`, headers: headers(seedIds.admin), payload: { reason: 'Legacy terminal-state read-model fixture' } });
    expect(terminated.statusCode, terminated.body).toBe(200);
    const assignment = await prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(assignment).toMatchObject({ status: 'ACTIVE', endedAt: null });
    expect((await read()).json().arrivalElapsed).toMatchObject({ ongoing: false, totalElapsedSeconds: null, endTimeUnverified: true });
    expect((await app.inject({ method: 'GET', url: '/delivery-tasks/mine', headers: headers(riders[0]!.userId) })).json().find((t: { id: string }) => t.id === taskId).arrivalElapsed).toMatchObject({ ongoing: false, totalElapsedSeconds: null, endTimeUnverified: true });
    expect((await arrive()).statusCode).toBe(409);
  });
});
